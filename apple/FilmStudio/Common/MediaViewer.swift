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

    @State private var upscale: Tool?
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        ScreenGate(id: "mediaViewer", params: ["id": item.id], title: "Media") {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    media
                        .frame(maxWidth: .infinity)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    info.padding(.horizontal, 4)
                }
                .padding(.horizontal, 12)
                .padding(.top, 8)
                .padding(.bottom, 120)
                .frame(maxWidth: 1100)
                .frame(maxWidth: .infinity)
            }
            .studioCanvas()
            .navigationTitle(item.isVideo ? "Video" : isAudio ? "Audio" : "Image")
            .inlineTitle()
            .toolbar { toolbar }
            .overlay(alignment: .bottom) {
                GlassEffectContainer(spacing: 12) {
                    VStack(spacing: 12) {
                        if let message {
                            Text(message).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                                .studioGlass()
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                        }
                        if scale > 1 {
                            Button {
                                withAnimation(.spring) { scale = 1; baseScale = 1 }
                            } label: {
                                Label("Fit", systemImage: "arrow.down.right.and.arrow.up.left").font(.subheadline.weight(.semibold))
                            }
                            .buttonStyle(.glass)
                            .transition(.scale.combined(with: .opacity))
                        }
                        actionBar
                    }
                }
                .padding(.bottom, 16)
            }
            .navigationDestination(item: $upscale) { t in
                ToolRunView(tool: t, prefillAsset: UploadedAsset(id: item.id, url: item.url, kind: item.isVideo ? "video" : "image"))
            }
            .task { if app.tools.isEmpty { await app.loadTools() } }
            .confirmationDialog("Remove from the library?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await onDelete?(); dismiss() } }
            } message: { Text("The file stays on the studio server; it's only hidden from the library.") }
        }
    }

    /// Share · Save · Remix, and the lime primary next step (Animate for stills, Upscale for clips).
    private var actionBar: some View {
        HStack(spacing: 8) {
            if app.config.isOn("shareMedia") {
                barButton("Share", "square.and.arrow.up") { export { MediaFiles.share($0) } }
            }
            #if os(iOS)
            if app.config.isOn("saveToPhotos"), !isAudio {
                barButton("Save", "arrow.down.to.line") {
                    export { file in
                        Task {
                            do { try await MediaFiles.saveToPhotos(file, isVideo: item.isVideo); Platform.haptic(); flash("Saved to Photos") } catch { flash(error.localizedDescription) }
                        }
                    }
                }
            }
            #else
            barButton("Save", "arrow.down.to.line") { export { MediaFiles.saveAs($0) } }
            #endif
            if !isAudio, app.config.isOn("create") || upscaleTool != nil {
                Menu {
                    if !item.isVideo, app.config.isOn("create") {
                        Button("Use as Start Frame", systemImage: "film") { app.openCreate(startFrame: asset, mode: .video) }
                        Button("Use as Reference", systemImage: "photo.on.rectangle") { app.openCreate(startFrame: asset, mode: .image) }
                    }
                    if app.config.isOn("create"), !item.prompt.isEmpty {
                        Button("Reuse Prompt", systemImage: "text.quote") {
                            app.openComposer(ComposerRequest(mode: item.isVideo ? .video : .image, model: app.catalog?.model(item.model)?.id, prompt: item.prompt))
                        }
                    }
                    if let t = upscaleTool { Button("Upscale", systemImage: "arrow.up.left.and.arrow.down.right") { upscale = t } }
                } label: {
                    VStack(spacing: 3) {
                        Image(systemName: "wand.and.stars").font(.system(size: 17, weight: .semibold))
                        Text("Remix").font(.system(size: 10, weight: .semibold))
                    }
                    .frame(width: 54, height: 44)
                    .foregroundStyle(.white)
                }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
            }
            if !isAudio {
                if !item.isVideo, app.config.isOn("create") {
                    Button { app.openCreate(startFrame: asset, mode: .video) } label: { Label("Animate", systemImage: "sparkle") }
                        .buttonStyle(.lime)
                } else if let t = upscaleTool {
                    Button { upscale = t } label: { Label("Upscale", systemImage: "sparkle") }
                        .buttonStyle(.lime)
                }
            }
        }
        .padding(6)
        .padding(.leading, 6)
        .studioGlass(Capsule())
    }

    private var asset: UploadedAsset { UploadedAsset(id: item.id, url: item.url, kind: item.isVideo ? "video" : "image") }

    /// The server's upscale tool for this kind of media, if it has one.
    private var upscaleTool: Tool? {
        guard app.config.isOn("tools") else { return nil }
        let out = item.isVideo ? "video" : "image"
        return app.tools.first { $0.id.localizedCaseInsensitiveContains("upscale") && $0.output == out }
    }

    private func barButton(_ title: String, _ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: symbol).font(.system(size: 17, weight: .semibold))
                Text(title).font(.system(size: 10, weight: .semibold))
            }
            .frame(width: 54, height: 44)
            .foregroundStyle(.white)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
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
            if let m = app.catalog?.model(item.model) {
                Text(m.label.uppercased()).font(.display(22, weight: .heavy)).foregroundStyle(.white)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                if !item.model.isEmpty { row("Model", app.catalog?.model(item.model)?.label ?? item.model) }
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
            Menu {
                #if os(macOS)
                Button("Save…", systemImage: "square.and.arrow.down") { export { MediaFiles.saveAs($0) } }
                    .keyboardShortcut("s")
                #endif
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
