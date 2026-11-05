import SwiftUI
import FilmStudioKit

/// Full-screen viewer for one image, video or audio result, with share / save / delete.
struct MediaViewer: View {
    let item: MediaItem
    var onDelete: (() async -> Void)?
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var busy: String?
    @State private var message: String?
    @State private var confirmDelete = false
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1

    private var isAudio: Bool { item.kind == "audio" }

    var body: some View {
        ScreenGate(id: "mediaViewer", params: ["id": item.id], title: "Media") {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    media
                        .frame(maxWidth: .infinity)
                        .background(Color.black.opacity(item.isVideo || isAudio ? 1 : 0))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    info.padding(.horizontal, 4)
                }
                .padding()
                .frame(maxWidth: 1100)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(item.isVideo ? "Video" : isAudio ? "Audio" : "Image")
            .inlineTitle()
            .toolbar { toolbar }
            .overlay(alignment: .bottom) {
                if let message {
                    Text(message).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                        .background(.regularMaterial, in: Capsule()).padding(.bottom, 24)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .confirmationDialog("Remove from the library?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await onDelete?(); dismiss() } }
            } message: { Text("The file stays on the studio server; it's only hidden from the library.") }
        }
    }

    @ViewBuilder private var media: some View {
        if item.isVideo || isAudio {
            EngineVideoPlayer(url: item.url)
                .aspectRatio(isAudio ? 3 : 16 / 9, contentMode: .fit)
                .frame(minHeight: isAudio ? 120 : 220)
        } else {
            AuthedImage(url: item.url, maxPixelSize: 3072, contentMode: .fit)
                .scaleEffect(scale)
                .gesture(MagnifyGesture()
                    .onChanged { scale = max(1, min(6, baseScale * $0.magnification)) }
                    .onEnded { _ in baseScale = scale })
                .onTapGesture(count: 2) { withAnimation(.spring) { scale = scale > 1 ? 1 : 2.5; baseScale = scale } }
                .frame(minHeight: 240)
                .accessibilityLabel(item.prompt.isEmpty ? "Image" : item.prompt)
        }
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !item.prompt.isEmpty {
                Text(item.prompt).font(.body).textSelection(.enabled)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !item.model.isEmpty { row("Model", item.model) }
                if let d = item.date { row("Created", d.formatted(date: .abbreviated, time: .shortened)) }
                if !item.resolution.isEmpty { row("Size", item.resolution) }
            }
            .font(.subheadline)
        }
    }

    private func row(_ k: String, _ v: String) -> some View {
        GridRow {
            Text(k).foregroundStyle(.secondary)
            Text(v).textSelection(.enabled)
        }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .trailing) {
            if let busy {
                ProgressView().controlSize(.small).help(busy)
            }
            if app.config.isOn("shareMedia") {
                Button("Share", systemImage: "square.and.arrow.up") { export { MediaFiles.share($0) } }.disabled(busy != nil)
            }
            Menu {
                #if os(iOS)
                if app.config.isOn("saveToPhotos"), !isAudio {
                    Button("Save to Photos", systemImage: "photo.badge.arrow.down") {
                        export { file in
                            Task {
                                do { try await MediaFiles.saveToPhotos(file, isVideo: item.isVideo); flash("Saved to Photos") } catch { flash(error.localizedDescription) }
                            }
                        }
                    }
                }
                #else
                Button("Save…", systemImage: "square.and.arrow.down") { export { MediaFiles.saveAs($0) } }
                    .keyboardShortcut("s")
                #endif
                if !item.isVideo, !isAudio, app.config.isOn("create") {
                    Button("Animate in Create", systemImage: "wand.and.stars") {
                        app.openCreate(startFrame: UploadedAsset(id: item.id, url: item.url, kind: "image"))
                    }
                }
                Button("Copy Prompt", systemImage: "doc.on.doc") { Platform.copy(item.prompt) }.disabled(item.prompt.isEmpty)
                OpenOnWebButton(path: app.config.presentation(for: "library").path ?? "/", title: "Library")
                if onDelete != nil, app.config.isOn("deleteMedia") {
                    Divider()
                    Button("Remove from Library", systemImage: "trash", role: .destructive) { confirmDelete = true }
                }
            } label: { Label("More", systemImage: "ellipsis.circle") }
        }
    }

    private func export(_ then: @escaping (URL) -> Void) {
        busy = "Downloading…"
        Task {
            do { then(try await MediaFiles.download(item.url, app: app)) } catch {
                flash(error.localizedDescription)
                app.report(error, screen: "mediaViewer", action: "Download")
            }
            busy = nil
        }
    }

    private func flash(_ text: String) {
        withAnimation { message = text }
        Task { try? await Task.sleep(for: .seconds(2.5)); withAnimation { message = nil } }
    }
}
