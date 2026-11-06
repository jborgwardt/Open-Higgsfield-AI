import SwiftUI
import FilmStudioKit

struct ProjectDriveArchiveSection: View {
    let productionID: String
    let canBackUp: Bool
    @Environment(AppModel.self) private var app
    @State private var archive: ProjectDriveArchive?
    @State private var busy = false
    @State private var problem: String?
    @State private var notice: String?

    var body: some View {
        Section {
            if let archive {
                Label(archive.label, systemImage: archive.status == "verified" ? "checkmark.icloud.fill" : "icloud")
                    .foregroundStyle(archive.status == "verified" ? .green : .secondary)
                if let url = archive.filmURL {
                    // The movie itself: watch, download or share it from Google Drive.
                    Button { Platform.open(url) } label: { Label("Open Finished Film in Google Drive", systemImage: "play.rectangle.fill") }
                        .fontWeight(.semibold)
                        .accessibilityIdentifier("drive.finishedFilm")
                }
                if let url = archive.folderURL {
                    Button { Platform.open(url) } label: { Label("Open Project Folder", systemImage: "folder") }
                        .accessibilityIdentifier("drive.projectFolder")
                }
                if let date = archive.verifiedAt.flatMap(ISODate.parse) {
                    LabeledContent("Verified", value: date.formatted(date: .abbreviated, time: .shortened))
                }
                if archive.localOffloaded {
                    Button("Restore Video to Studio") { Task { await restore() } }.disabled(busy)
                }
                if let error = archive.error, !error.isEmpty { Text(error).font(.caption).foregroundStyle(.red) }
            }
            Button("Back Up This Project Now") { Task { await backUp() } }
                .disabled(busy || !canBackUp || archive?.status == "uploading")
            Button("Refresh Backup Status") { Task { await load() } }.disabled(busy)
            if busy { ProgressView().controlSize(.small) }
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
            if let notice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        } header: { Text("Google Drive") } footer: {
            Text(canBackUp ? "“Open Finished Film” goes straight to the movie in Google Drive, to watch, download or share it. The project folder also holds every source clip and the project files." : "Finish rendering and assembling the film before backing it up.")
        }
        .task(id: productionID) { await load() }
    }

    private func load() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            archive = try await app.client.projectDriveArchive(productionID)
            problem = nil
        } catch is CancellationError {
        } catch {
            problem = (error as? APIError)?.isMissingRoute == true
                ? "Google Drive backup is not available on this studio yet."
                : error.localizedDescription
        }
    }

    private func backUp() async {
        guard !busy else { return }
        busy = true; problem = nil; notice = nil
        defer { busy = false }
        do {
            archive = try await app.client.backUpProjectToDrive(productionID)
            notice = "Backup requested. You can leave this screen while the server works."
        } catch { problem = error.localizedDescription }
    }

    private func restore() async {
        guard !busy else { return }
        busy = true; problem = nil; notice = nil
        defer { busy = false }
        do {
            try await app.client.restoreProjectFromDrive(productionID)
            archive = try await app.client.projectDriveArchive(productionID)
            notice = "Video restored to the studio."
        } catch { problem = error.localizedDescription }
    }
}
