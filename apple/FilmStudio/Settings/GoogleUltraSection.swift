import SwiftUI
import FilmStudioKit

/// Google AI Ultra plan sign-in. Google sends the browser back to http://localhost:8085, which can't load on this
/// device, so the user pastes that address here and the studio finishes the sign-in. The tokens stay on the studio.
struct GoogleUltraSection: View {
    @Environment(AppModel.self) private var app
    @State private var status: GoogleUltraStatus?
    @State private var unsupported = false
    @State private var awaitingCode = false
    @State private var code = ""
    @State private var busy = false
    @State private var problem: String?
    @State private var confirmSignOut = false

    var body: some View {
        Section {
            if let status {
                if status.connected {
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Connected")
                            if let email = status.email { Text(email).font(.caption).foregroundStyle(.secondary) }
                        }
                    } icon: { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                    Button("Sign Out", role: .destructive) { confirmSignOut = true }
                        .disabled(busy)
                } else {
                    Label("Not connected", systemImage: "circle.dashed").foregroundStyle(.secondary)
                    if !status.hasSecret {
                        Text("The studio is missing its Google sign-in secret, so sign-in can't finish yet. Add it on the studio server.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Button { Task { await begin() } } label: { Label("Sign in with Google", systemImage: "person.crop.circle.badge.checkmark") }
                        .disabled(busy || !status.hasSecret)
                    if awaitingCode {
                        TextField("Address", text: $code, prompt: Text("http://localhost:8085/?code=…"), axis: .vertical)
                            .urlField()
                            .onSubmit { Task { await complete() } }
                        Text("Approve in your browser, then paste the address from the page that failed to load.")
                            .font(.caption).foregroundStyle(.secondary)
                        HStack {
                            Button("Continue") { Task { await complete() } }
                                .disabled(busy || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            Spacer()
                            Button("Cancel", role: .cancel) { awaitingCode = false; code = "" }
                        }
                        .buttonStyle(.borderless)
                    }
                }
            } else if unsupported {
                Text("This studio version doesn't support AI Ultra sign-in yet. Update the studio and refresh.")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                HStack { ProgressView().controlSize(.small); Text("Checking AI Ultra…").foregroundStyle(.secondary) }
            }
            if busy { HStack { ProgressView().controlSize(.small); Text("Working…").foregroundStyle(.secondary) } }
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
        } header: { Text("AI Ultra plan") } footer: {
            Text("Uses your AI Ultra plan's included Nano Banana, Lyria and voices. Video from the plan goes through the Flow hand-off.")
        }
        .task(id: app.refreshTick) { await load() }
        .confirmationDialog("Sign out of AI Ultra?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive) { Task { await signOut() } }
        } message: { Text("Plan models and voices become unavailable on every device using this studio.") }
    }

    private func load() async {
        guard app.phase == .ready else { return }
        do { status = try await app.client.googleUltraStatus(); unsupported = false } catch is CancellationError {
        } catch let e as APIError where e.isMissingRoute { unsupported = true
        } catch { problem = error.localizedDescription }
    }

    private func begin() async {
        problem = nil
        busy = true
        defer { busy = false }
        do {
            let login = try await app.client.beginGoogleUltraLogin()
            guard let url = login.consentURL else { problem = "The studio returned an unexpected sign-in address."; return }
            code = ""
            awaitingCode = true
            Platform.open(url)
        } catch is CancellationError {
        } catch { problem = error.localizedDescription }
    }

    private func complete() async {
        let value = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !busy else { return }
        problem = nil
        busy = true
        defer { busy = false }
        do {
            status = try await app.client.completeGoogleUltraLogin(code: value)
            awaitingCode = false
            code = ""
            await afterChange()
        } catch is CancellationError {
        } catch { problem = error.localizedDescription }
    }

    private func signOut() async {
        problem = nil
        busy = true
        defer { busy = false }
        do {
            status = try await app.client.signOutGoogleUltra()
            await afterChange()
        } catch is CancellationError {
        } catch { problem = error.localizedDescription }
    }

    /// Plan models, voices and the director depend on the sign-in.
    private func afterChange() async {
        try? await app.loadDirectors()
        await app.reloadCatalog()
        app.refreshTick += 1
    }
}
