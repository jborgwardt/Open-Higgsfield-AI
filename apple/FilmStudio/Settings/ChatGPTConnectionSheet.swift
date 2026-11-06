import SwiftUI
import FilmStudioKit

/// Account setup is independent of director selection, including while its option is disabled.
struct ChatGPTConnectionSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var status: CodexConnectionStatus?
    @State private var error: String?
    @State private var activity: String?
    @State private var loading = false
    @State private var confirmDisconnect = false
    @State private var operation: Task<Void, Never>?
    #if os(macOS)
    @State private var localSignIn = ChatGPTLocalSignIn()
    @State private var pending: (APIClient, String)?
    #endif

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Use your ChatGPT plan to write and plan films. Your existing video and audio providers still create the media.")
                    LabeledContent("Studio receiving access") {
                        Text(app.serverURL.absoluteString).textSelection(.enabled)
                    }
                    Text("This studio stores the connection securely and makes the director available to its signed-in iPhone, iPad, Mac, and browser clients.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Connection") {
                    if let status {
                        connectionDetails(status)
                    } else if loading {
                        ProgressView("Checking connection…")
                    }
                    if let activity {
                        HStack { ProgressView().controlSize(.small); Text(activity) }
                    }
                    if let error {
                        Text(error).foregroundStyle(.red).font(.callout)
                    }
                    #if os(macOS)
                    if pending != nil {
                        Button("Cancel Sign-In", role: .cancel) { cancelSignIn() }
                    }
                    #endif
                    Button("Refresh Connection") { Task { await refresh() } }
                        .disabled(activity != nil || loading)
                }
                Section {
                    Text("Connecting does not change your selected director. After connecting, choose ChatGPT / Codex in Film Director when you want to use it.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .studioForm()
            .navigationTitle("ChatGPT / Codex")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { cancelSignIn(); dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 480, idealWidth: 540, minHeight: 420)
        #endif
        .presentationDetents([.large])
        .task { await refresh() }
        .onDisappear { cancelSignIn() }
        .onChange(of: app.serverURL) { _, _ in cancelSignIn(); dismiss() }
        .confirmationDialog("Disconnect ChatGPT from this studio?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
            Button("Disconnect ChatGPT", role: .destructive) { disconnect() }
        } message: {
            Text("The director will become unavailable on every device connected to this studio. Your films and other providers are kept.")
        }
    }

    @ViewBuilder private func connectionDetails(_ value: CodexConnectionStatus) -> some View {
        Label(value.loggedIn ? (value.available ? "Connected" : "Connected — needs attention") : "Not connected",
              systemImage: value.available ? "checkmark.circle.fill" : "circle.dashed")
            .foregroundStyle(value.available ? .green : .secondary)
        if let email = value.account?.email, !email.isEmpty { LabeledContent("ChatGPT account", value: email) }
        if let plan = value.account?.plan, !plan.isEmpty { LabeledContent("Plan", value: plan) }
        if let problem = value.error, !problem.isEmpty { Text(problem).font(.caption).foregroundStyle(.secondary) }
        #if os(macOS)
        if value.loginMethod == "mac_local_oauth" {
            if !app.client.hasStudioSession {
                Text("Sign in to your studio first, then connect ChatGPT.")
                    .font(.caption).foregroundStyle(.secondary)
            } else if !app.client.canTransferCodexCredentials {
                Text("Connect this app to an HTTPS studio address before signing in with ChatGPT.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if !value.loggedIn || !value.available {
                Button("Continue with ChatGPT") { connect() }
                    .buttonStyle(.borderedProminent)
                    .disabled(activity != nil || !app.client.canTransferCodexCredentials)
                Text("Your browser will open for ChatGPT sign-in and approval. Access is saved only on the studio shown above.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        } else if !value.loggedIn {
            Text("This studio version does not support ChatGPT sign-in yet. Update the studio and refresh this connection.")
                .font(.caption).foregroundStyle(.secondary)
        }
        #else
        if !value.loggedIn || !value.available {
            Text("Open Film Studio on your Mac, connect it to the same studio address, then go to Settings → Film Director → ChatGPT / Codex Connection → Continue with ChatGPT. Return here and refresh after connecting.")
                .font(.callout).foregroundStyle(.secondary)
        }
        #endif
        if value.loggedIn {
            Button("Disconnect ChatGPT", role: .destructive) { confirmDisconnect = true }
                .disabled(activity != nil)
        }
    }

    private func refresh() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            status = try await app.client.codexConnection()
            error = nil
            try? await app.loadDirectors()
        } catch is CancellationError {
        } catch let failure as APIError where failure.isMissingRoute {
            error = "This studio version does not support ChatGPT connections yet. Update the studio and try again."
        } catch { self.error = error.localizedDescription }
    }

    #if os(macOS)
    private func connect() {
        guard operation == nil, status?.loginMethod == "mac_local_oauth" else { return }
        let client = app.client
        error = nil
        activity = "Starting sign-in…"
        operation = Task {
            defer { operation = nil; activity = nil }
            do {
                let attempt = try await client.beginCodexConnection()
                pending = (client, attempt.connectionId)
                try Task.checkCancellation()
                activity = "Waiting for ChatGPT approval in your browser…"
                let credentials = try await localSignIn.authorize(attempt: attempt,
                    hostID: ChatGPTLocalSignIn.stableHostID(), openBrowser: { Platform.open($0) })
                try Task.checkCancellation()
                activity = "Connecting your studio…"
                status = try await client.completeCodexConnection(attempt, credentials: credentials)
                pending = nil
                try Task.checkCancellation()
                try? await app.loadDirectors()
                app.refreshTick += 1
            } catch is CancellationError {
                cancelPendingAttempt()
            } catch {
                self.error = error.localizedDescription
                cancelPendingAttempt()
                // A network interruption after transfer may still have completed on the studio.
                if let current = try? await client.codexConnection() { status = current }
            }
        }
    }

    private func cancelPendingAttempt() {
        guard let (client, id) = pending else { return }
        pending = nil
        Task { _ = try? await client.cancelCodexConnection(id) }
    }
    #endif

    private func cancelSignIn() {
        #if os(macOS)
        operation?.cancel()
        localSignIn.cancel()
        cancelPendingAttempt()
        #endif
    }

    private func disconnect() {
        guard operation == nil else { return }
        error = nil
        activity = "Disconnecting…"
        let client = app.client
        operation = Task {
            defer { operation = nil; activity = nil }
            do {
                status = try await client.disconnectCodex()
                try? await app.loadDirectors()
                app.refreshTick += 1
            } catch is CancellationError {
            } catch { self.error = error.localizedDescription }
        }
    }
}
