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
    @State private var exportError: String?
    @State private var exportTask: Task<Void, Never>?
    @State private var downloadedFile: (source: String, file: URL)?
    @State private var confirmDelete = false
    @State private var scale: CGFloat = 1
    @State private var baseScale: CGFloat = 1

    private var isAudio: Bool { item.kind == "audio" }

    @State private var upscale: Tool?
    @Environment(\.horizontalSizeClass) private var sizeClass

    @State private var expanded = false

    /// "1280×720" → 16:9; unknown → 16:9 for clips, square for stills.
    private var aspect: CGFloat {
        let parts = item.resolution.split(whereSeparator: { $0 == "×" || $0 == "x" }).compactMap { Double($0) }
        if parts.count == 2, parts[0] > 0, parts[1] > 0 { return parts[0] / parts[1] }
        return isAudio ? 3 : item.isVideo ? 16 / 9 : 1
    }

    var body: some View {
        // Immersive: the media fills the screen on black, prompt + actions float over a scrim, and the floating
        // tab bar steps aside so nothing covers the action bar (QA-04).
        ScreenGate(id: "mediaViewer", params: ["id": item.id], title: "Media") {
            ZStack {
                Color.black.ignoresSafeArea()
                media
                    .aspectRatio(aspect, contentMode: .fit)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(.bottom, 150)
                    .contextMenu { exportMenu }
            }
            .navigationTitle(item.isVideo ? "Video" : isAudio ? "Audio" : "Image")
            .inlineTitle()
            #if os(iOS)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar { ToolbarItem(placement: .principal) { Text("") } }
            #endif
            .toolbar { toolbar }
            .overlay(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 12) {
                    if let busy {
                        HStack(spacing: 10) {
                            ProgressView().controlSize(.small)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(busy).font(.subheadline.monospacedDigit())
                                #if os(iOS)
                                Text(busy.hasPrefix("Downloading") || busy.hasPrefix("Connection")
                                     ? "You can switch apps: the download keeps going."
                                     : "Keep Film Studio open until saving finishes.").font(.caption).foregroundStyle(.secondary)
                                #endif
                            }
                            Spacer()
                            if busy.hasPrefix("Downloading") || busy.hasPrefix("Connection") {
                                Button("Cancel") { exportTask?.cancel() }
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 10).studioGlass()
                    }
                    if let message {
                        Text(message).font(.subheadline.weight(.medium)).padding(.horizontal, 16).padding(.vertical, 10)
                            .studioGlass()
                            .frame(maxWidth: .infinity)
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                    if scale > 1 {
                        Button {
                            withAnimation(.spring) { scale = 1; baseScale = 1 }
                        } label: {
                            Label("Fit", systemImage: "arrow.down.right.and.arrow.up.left").font(.subheadline.weight(.semibold))
                        }
                        .buttonStyle(.glass)
                        .frame(maxWidth: .infinity)
                        .transition(.scale.combined(with: .opacity))
                    }
                    info
                    GlassEffectContainer(spacing: 12) { actionBar }
                        .frame(maxWidth: .infinity)
                }
                .padding(.horizontal, 16)
                .padding(.top, 40)
                .padding(.bottom, 12)
                .frame(maxWidth: 900)
                .frame(maxWidth: .infinity)
                .background(alignment: .bottom) {
                    LinearGradient(colors: [.clear, .black.opacity(0.85), .black], startPoint: .top, endPoint: .bottom)
                        .ignoresSafeArea(edges: .bottom)
                        .allowsHitTesting(false)
                }
            }
            .navigationDestination(item: $upscale) { t in
                ToolRunView(tool: t, prefillAsset: UploadedAsset(id: item.id, url: item.url, kind: item.isVideo ? "video" : "image"))
            }
            .task { if app.tools.isEmpty { await app.loadTools() } }
            .onAppear { app.immersiveDepth += 1 }
            .onDisappear { app.immersiveDepth = max(0, app.immersiveDepth - 1) }
            .confirmationDialog("Remove from the library?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Remove", role: .destructive) { Task { await onDelete?(); dismiss() } }
            } message: { Text("The file stays on the studio server; it's only hidden from the library.") }
            .alert("Export failed", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK", role: .cancel) { exportError = nil }
            } message: { Text(exportError ?? "") }
        }
    }

    /// Keep every export destination visible; creative actions sit on a second row on a phone.
    private var actionBar: some View {
        Group {
            #if os(iOS)
            VStack(spacing: 6) {
                HStack(spacing: 8) { exportActions }
                if !isAudio { HStack(spacing: 8) { creativeActions } }
            }
            #else
            HStack(spacing: 8) { exportActions; creativeActions }
            #endif
        }
        .padding(8)
        #if os(macOS)
        .studioGlass(Capsule())
        #else
        .studioGlass(RoundedRectangle(cornerRadius: 26))
        #endif
    }

    @ViewBuilder private var exportActions: some View {
        if app.config.isOn("shareMedia") {
            barButton("Share", "square.and.arrow.up") { export { MediaFiles.share($0) } }
        }
        #if os(iOS)
        if app.config.isOn("saveToPhotos"), !isAudio {
            barButton("Save to Photos", "photo.badge.arrow.down") { saveToPhotos() }
        }
        barButton("Save to Files", "folder") { saveToFiles() }
        #else
        barButton("Save…", "arrow.down.to.line") { export { if try MediaFiles.saveAs($0) { flash("Saved") } } }
        #endif
    }

    @ViewBuilder private var exportMenu: some View {
        #if os(iOS)
        if app.config.isOn("saveToPhotos"), !isAudio {
            Button("Save to Photos", systemImage: "photo.badge.arrow.down") { saveToPhotos() }
                .disabled(busy != nil)
        }
        Button("Save to Files…", systemImage: "folder") { saveToFiles() }.disabled(busy != nil)
        #else
        Button("Save…", systemImage: "arrow.down.to.line") { export { if try MediaFiles.saveAs($0) { flash("Saved") } } }
            .disabled(busy != nil)
            .keyboardShortcut("s")
        #endif
        if app.config.isOn("shareMedia") {
            Button("Share…", systemImage: "square.and.arrow.up") { export { MediaFiles.share($0) } }.disabled(busy != nil)
        }
    }

    #if os(iOS)
    private func saveToPhotos() {
        export { file in
            busy = "Saving to Photos…"
            try await MediaFiles.saveToPhotos(file, isVideo: item.isVideo)
            Platform.haptic()
            flash("Saved to Photos")
        }
    }

    private func saveToFiles() {
        export { file in
            busy = "Choose where to save…"
            if try await MediaFiles.saveToFiles(file) { flash("Saved to Files") }
        }
    }
    #endif

    @ViewBuilder private var creativeActions: some View {
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
                    Image(systemName: "slider.horizontal.3").font(.system(size: 17, weight: .semibold))
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
                Button { app.openCreate(startFrame: asset, mode: .video) } label: { Label("Animate", systemImage: "play.rectangle") }
                    .buttonStyle(.ember)
            } else if let t = upscaleTool, item.model != "Long-form master" {
                // A finished film's next step is saving/sharing it, not a paid upscale (still in the Remix menu).
                Button { upscale = t } label: { Label("Upscale", systemImage: "arrow.up.left.and.arrow.down.right") }
                    .buttonStyle(.ember)
            }
        }
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
            .frame(width: title.count > 8 ? 88 : 54, height: 44)
            .foregroundStyle(.white)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(busy != nil)
    }

    @ViewBuilder private var media: some View {
        if item.isVideo || isAudio {
            EngineVideoPlayer(url: item.url)
        } else {
            AuthedImage(url: item.url, maxPixelSize: 3072, contentMode: .fit)
                .scaleEffect(scale)
                .gesture(MagnifyGesture()
                    .onChanged { scale = max(1, min(6, baseScale * $0.magnification)) }
                    .onEnded { _ in baseScale = scale })
                .onTapGesture(count: 2) { withAnimation(.spring) { scale = scale > 1 ? 1 : 2.5; baseScale = scale } }
                .accessibilityLabel(item.prompt.isEmpty ? "Image" : item.prompt)
        }
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let m = app.catalog?.model(item.model) {
                Text(m.displayName.uppercased()).font(.display(22, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
            } else if !item.model.isEmpty {
                Text(item.model.uppercased()).font(.display(22, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
            }
            if !item.prompt.isEmpty {
                Text(item.prompt).font(.subheadline).foregroundStyle(.white.opacity(0.82))
                    .lineLimit(expanded ? 12 : 2)
                    .textSelection(.enabled)
                    .onTapGesture { withAnimation(.snappy) { expanded.toggle() } }
            }
            let facts = [item.date?.formatted(date: .abbreviated, time: .shortened), item.resolution.nonEmpty].compactMap { $0 }
            if !facts.isEmpty {
                Text(facts.joined(separator: " · ")).font(.caption.monospacedDigit()).foregroundStyle(Color.textTertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .trailing) {
            if let busy {
                ProgressView().controlSize(.small).help(busy)
            }
            Menu {
                exportMenu
                Divider()
                Button("Copy Prompt", systemImage: "doc.on.doc") { Platform.copy(item.prompt) }.disabled(item.prompt.isEmpty)
                OpenOnWebButton(path: app.config.presentation(for: "library").path ?? "/", title: "Library")
                if onDelete != nil, app.config.isOn("deleteMedia") {
                    Divider()
                    Button("Remove from Library", systemImage: "trash", role: .destructive) { confirmDelete = true }
                }
            } label: { Label("More", systemImage: "ellipsis.circle") }
        }
    }

    private func export(_ then: @escaping (URL) async throws -> Void) {
        guard exportTask == nil else { return }
        busy = "Downloading…"
        exportTask = Task {
            defer { busy = nil; exportTask = nil }
            do {
                try await MediaFiles.withExportTime {
                    let file: URL
                    if let downloadedFile, downloadedFile.source == item.url, FileManager.default.fileExists(atPath: downloadedFile.file.path) {
                        file = downloadedFile.file
                    } else {
                        file = try await MediaFiles.download(item.url, app: app) { busy = $0 }
                        downloadedFile = (item.url, file)
                    }
                    try Task.checkCancellation()
                    busy = "Preparing export…"
                    try await then(MediaFiles.named(file, for: item))
                }
            } catch is CancellationError {
                flash("Download cancelled")
            } catch {
                exportError = error.localizedDescription
                app.report(error, screen: "mediaViewer", action: "Export")
            }
        }
    }

    private func flash(_ text: String) {
        withAnimation { message = text }
        Task { try? await Task.sleep(for: .seconds(2.5)); withAnimation { message = nil } }
    }
}
