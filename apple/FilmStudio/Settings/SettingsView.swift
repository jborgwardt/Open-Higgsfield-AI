import SwiftUI
import FilmStudioKit

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @State private var status: StatusReport?
    @State private var statusError: String?
    @State private var pending = 0
    @State private var confirmSignOut = false

    var body: some View {
        Form {
            if case .available(let v) = app.updateState, let url = app.config.updateUrl.flatMap(URL.init(string:)) {
                Section {
                    Button { Platform.open(url) } label: { Label("Install Film Studio \(v)", systemImage: "arrow.down.app.fill") }
                }
            }
            ServerSection()
            accountSection
            if app.config.isOn("films") {
                Section {
                    DirectorPicker()
                } header: { Text("Film Director") } footer: {
                    Text("Plans every long-form film: an AI director writes scenes and shots, or “No AI” splits your script as written.")
                }
            }
            providersSection
            appSection
        }
        .studioForm()
        .navigationTitle("Settings")
        .task(id: app.refreshTick) { await load() }
        .refreshable { await load() }
        .confirmationDialog("Sign out of the studio?", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive) { Task { await app.signOut() } }
        } message: { Text("Generations and films keep running on the server.") }
    }

    @ViewBuilder private var accountSection: some View {
        Section("Account") {
            if let u = app.health?.user {
                LabeledContent("Signed in as") {
                    VStack(alignment: .trailing) {
                        Text(u.name)
                        Text(u.email).font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else if app.health?.auth == false {
                LabeledContent("Sign-in", value: "Not required (local engine)")
            } else {
                LabeledContent("Sign-in", value: app.token == nil ? "Signed out" : "Signed in")
            }
            if app.health?.usesPocketID == true { LabeledContent("Method", value: "\(app.health?.provider ?? "Pocket ID") passkey") }
            if app.token != nil {
                Button("Sign Out", role: .destructive) { confirmSignOut = true }
            }
        }
    }

    @ViewBuilder private var providersSection: some View {
        Section {
            if let s = status {
                ForEach(s.providers) { p in
                    HStack {
                        Image(systemName: p.available ? "checkmark.circle.fill" : "circle.dashed").foregroundStyle(p.available ? .green : .secondary)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(p.label)
                            if !p.note.isEmpty { Text(p.note).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                LabeledContent("Director", value: s.director.map { $0 == "codex" ? "ChatGPT / Codex" : ($0 == "openai" ? "Local LLM" : $0.capitalized) } ?? "Offline splitter")
                LabeledContent("ElevenLabs", value: s.elevenAvailable ? "Connected" : "Not connected")
                LabeledContent("ComfyUI", value: s.comfy ? "Online" : "Offline")
                LabeledContent("ffmpeg", value: s.ffmpeg ? "Ready" : "Missing")
            } else if let statusError {
                Text(statusError).foregroundStyle(.secondary)
            } else {
                HStack { ProgressView().controlSize(.small); Text("Checking providers…").foregroundStyle(.secondary) }
            }
        } header: { Text("Providers") } footer: {
            Text("Connect ChatGPT above under Film Director. Manage video and other providers on the studio server (web app → Providers).")
        }
    }

    @ViewBuilder private var appSection: some View {
        Section {
            LabeledContent("Version", value: "\(DeviceFacts.appVersion) (\(DeviceFacts.build))")
            LabeledContent("Device", value: "\(DeviceFacts.model) · \(DeviceFacts.os)")
            if let d = app.config.updatedAt.flatMap(ISODate.parse) {
                LabeledContent("Server config", value: d.formatted(date: .abbreviated, time: .shortened))
            } else {
                LabeledContent("Server config", value: "Defaults")
            }
            Button("Refresh Server Config") { Task { await app.refreshConfig(force: true); app.refreshTick += 1 } }
            LabeledContent("Diagnostics", value: app.config.isOn("diagnostics") ? (pending == 0 ? "Sent" : "\(pending) waiting") : "Off")
            if pending > 0, app.config.isOn("diagnostics") {
                Button("Send Diagnostics Now") { Task { await app.diagnostics.flush(); pending = await app.diagnostics.pending.count } }
            }
        } header: { Text("App") } footer: {
            Text("Errors and crashes are reported to your studio server (not to anyone else) so they can be fixed remotely.")
        }
    }

    private func load() async {
        pending = await app.diagnostics.pending.count
        guard app.phase == .ready else { return }
        try? await app.loadDirectors()
        do { status = try await app.client.status(); statusError = nil } catch is CancellationError {
        } catch { statusError = error.localizedDescription }
    }
}

/// Server address (default films.heil.haus); http is allowed for localhost only.
struct ServerSection: View {
    @Environment(AppModel.self) private var app
    @State private var text = ""
    @State private var problem: String?
    @State private var checking = false

    var body: some View {
        Section {
            TextField("Address", text: $text, prompt: Text("https://films.heil.haus"))
                .urlField()
                .onSubmit { Task { await apply() } }
            HStack {
                Button("Connect") { Task { await apply() } }
                    .disabled(checking || text.trimmingCharacters(in: .whitespaces).isEmpty)
                if checking { ProgressView().controlSize(.small) }
                Spacer()
                if app.serverURL != ServerAddress.defaultURL {
                    Button("Use films.heil.haus") { text = ServerAddress.defaultURL.absoluteString; Task { await apply() } }
                        .font(.callout)
                }
            }
            .buttonStyle(.borderless)
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
        } header: { Text("Studio Server") } footer: {
            Text("Point the app at a local engine for testing, e.g. http://localhost:4848. Each server keeps its own sign-in.")
        }
        .onAppear { text = app.serverURL.absoluteString }
    }

    private func apply() async {
        problem = nil
        do {
            let url = try ServerAddress.parse(text)
            text = url.absoluteString
            checking = true
            await app.setServer(url)
            checking = false
            if case .unreachable(let m) = app.phase { problem = m }
        } catch {
            problem = error.localizedDescription
        }
    }
}
