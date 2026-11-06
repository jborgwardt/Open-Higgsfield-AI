import SwiftUI
import FilmStudioKit

/// Save / share a finished film straight from its page (no need to open the player first).
/// Same download path as the viewer: background-safe, resumable, downloaded once, named after the film.
struct FilmExportRow: View {
    let title: String
    let masterURL: String
    @Environment(AppModel.self) private var app
    @State private var status: String?
    @State private var message: String?
    @State private var task: Task<Void, Never>?
    @State private var failure: String?
    @State private var shareFrame: CGRect = .zero

    private var item: MediaItem {
        MediaItem(id: "master-export", url: masterURL, kind: "videos", model: "Long-form master", prompt: title)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                #if os(iOS)
                exportButton("Save to Photos", "photo.badge.arrow.down", prominent: true) { file in
                    try await MediaFiles.saveToPhotos(file, isVideo: true)
                    return "Saved to Photos"
                }
                exportButton("Save to Files", "folder") { file in
                    try await MediaFiles.saveToFiles(file) ? "Saved to Files" : nil
                }
                #else
                exportButton("Save…", "arrow.down.to.line", prominent: true) { file in
                    try MediaFiles.saveAs(file) ? "Saved" : nil
                }
                #endif
                exportButton("Share", "square.and.arrow.up") { file in
                    MediaFiles.share(file, anchor: shareFrame)
                    return nil
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { shareFrame = $0 }
            }
            if let status {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(status).font(.caption.monospacedDigit()).foregroundStyle(.secondary).lineLimit(2)
                    Spacer(minLength: 0)
                    if status.hasPrefix("Downloading") || status.hasPrefix("Connection") {
                        Button("Cancel") { task?.cancel() }.font(.caption.weight(.semibold))
                    }
                }
                #if os(iOS)
                if status.hasPrefix("Downloading") || status.hasPrefix("Connection") {
                    Text("You can switch apps: the download keeps going.").font(.caption2).foregroundStyle(.tertiary)
                }
                #endif
            } else if let message {
                Label(message, systemImage: "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(.green)
            }
        }
        .alert("Couldn't save the film", isPresented: Binding(get: { failure != nil }, set: { if !$0 { failure = nil } })) {
            Button("OK", role: .cancel) { failure = nil }
        } message: { Text(failure ?? "") }
    }

    private func exportButton(_ label: String, _ icon: String, prominent: Bool = false,
                              _ then: @escaping (URL) async throws -> String?) -> some View {
        Button { run(then) } label: {
            VStack(spacing: 4) {
                Image(systemName: icon).font(.system(size: 18, weight: .semibold)).frame(height: 22)
                Text(label).font(.caption.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .foregroundStyle(prominent ? Color.onEmber : .primary)
        }
        .glassButton(prominent: prominent)
        .disabled(task != nil)
        .accessibilityIdentifier("film.export.\(label)")
    }

    private func run(_ then: @escaping (URL) async throws -> String?) {
        guard task == nil else { return }
        message = nil
        status = "Downloading…"
        task = Task {
            defer { status = nil; task = nil }
            do {
                try await MediaFiles.withExportTime {
                    let file = try await MediaFiles.download(masterURL, app: app) { status = $0 }
                    try Task.checkCancellation()
                    status = "Preparing…"
                    if let done = try await then(MediaFiles.named(file, for: item)) {
                        withAnimation { message = done }
                        Platform.haptic()
                    }
                }
            } catch is CancellationError {
                message = nil
            } catch {
                failure = error.localizedDescription
                app.report(error, screen: "film", action: "Save film")
            }
        }
    }
}
