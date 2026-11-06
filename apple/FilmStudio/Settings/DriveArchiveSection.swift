import SwiftUI
import FilmStudioKit

struct DriveArchiveSection: View {
    @Environment(AppModel.self) private var app
    @State private var status: DriveArchiveStatus?
    @State private var policy = DriveArchivePolicy()
    @State private var busy = false
    @State private var loaded = false
    @State private var problem: String?
    @State private var notice: String?

    private var changed: Bool { status.map { policy != $0.policy } ?? false }
    private var retention: Binding<Int> {
        Binding(get: { policy.removeLocalAfterHours ?? 0 }, set: { policy.removeLocalAfterHours = $0 == 0 ? nil : $0 })
    }

    var body: some View {
        Section {
            if let status {
                Label(status.connected ? "Connected" : "Not connected", systemImage: status.connected ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(status.connected ? .green : .secondary)
                LabeledContent("Folder", value: status.rootFolder)
                if let url = status.folderURL {
                    Button { Platform.open(url) } label: { Label("Open Google Drive Folder", systemImage: "arrow.up.right.square") }
                }
                Toggle("Automatically Back Up", isOn: $policy.enabled)
                    .disabled(busy)
                Picker("Upload Finished Projects", selection: $policy.uploadDelayHours) {
                    Text("Immediately").tag(0)
                    Text("After 1 Day").tag(24)
                    Text("After 2 Days").tag(48)
                }.disabled(busy || !policy.enabled)
                Picker("Keep Finished Videos on Server", selection: retention) {
                    Text("Always").tag(0)
                    Text("1 Day").tag(24)
                    Text("2 Days").tag(48)
                }.disabled(busy || !policy.enabled)
                Button("Save Backup Settings") { Task { await save() } }
                    .disabled(busy || !changed)
                Button("Back Up Finished Projects Now") { Task { await run() } }
                    .disabled(busy || !status.connected || changed)
                if changed { Text("Save your settings before starting a backup.").font(.caption).foregroundStyle(.secondary) }
                if status.busy == true {
                    Label("Backup in progress on the server", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let stats = status.stats {
                    let projects = Int(stats["projects"]?.double ?? 0)
                    let videos = Int(stats["videos"]?.double ?? 0)
                    LabeledContent("Backed Up", value: "\(projects) projects · \(videos) videos")
                    LabeledContent("Server Space Freed", value: ByteCountFormatter.string(fromByteCount: Int64(stats["localBytesFreed"]?.double ?? 0), countStyle: .file))
                }
                if let checked = status.lastRunAt.flatMap(ISODate.parse) {
                    LabeledContent("Last Backup Check", value: checked.formatted(date: .abbreviated, time: .shortened))
                }
                if let error = status.lastError, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            } else if !loaded {
                HStack { ProgressView().controlSize(.small); Text("Checking Google Drive…") }
            }
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
            HStack {
                Button("Refresh Backup Status") { Task { await load() } }.disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
        } header: { Text("Google Drive Backup") } footer: {
            Text("Each finished project gets its own folder with its videos and project files. Only backed-up finished videos are removed after verification and your retention period. Source clips and reference files stay on the server. Archived videos are restored when opened again. Backups continue when this app is closed.")
        }
        .task(id: app.serverURL) {
            status = nil; policy = DriveArchivePolicy(); loaded = false; problem = nil; notice = nil
            await load()
        }
    }

    private func load() async {
        guard app.phase == .ready, !busy else { return }
        busy = true
        defer { busy = false; loaded = true }
        do {
            let fresh = try await app.client.driveArchiveStatus()
            if !changed { policy = fresh.policy }
            status = fresh
            problem = nil
        } catch is CancellationError {
        } catch {
            status = nil
            problem = (error as? APIError)?.isMissingRoute == true
                ? "Google Drive backup is not available on this studio yet."
                : error.localizedDescription
        }
    }

    private func save() async {
        guard !busy else { return }
        busy = true; problem = nil; notice = nil
        defer { busy = false }
        do {
            let fresh = try await app.client.updateDriveArchivePolicy(policy)
            status = fresh; policy = fresh.policy
            notice = "Backup settings saved."
        } catch { problem = error.localizedDescription }
    }

    private func run() async {
        guard !busy, !changed else { return }
        busy = true; problem = nil; notice = nil
        defer { busy = false }
        do {
            try await app.client.runDriveArchive()
            notice = "Backup requested. The server will process eligible finished projects; refresh to check progress."
            status = try await app.client.driveArchiveStatus()
        } catch { problem = error.localizedDescription }
    }
}
