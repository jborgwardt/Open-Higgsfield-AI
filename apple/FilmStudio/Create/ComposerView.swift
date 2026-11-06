import SwiftUI
import PhotosUI
import FilmStudioKit

/// What to open the composer with (from a feed tile, the Create button, "Animate", "Use as start frame"…).
struct ComposerRequest: Identifiable, Hashable {
    enum Mode: String, CaseIterable, Identifiable {
        case video, image
        var id: String { rawValue }
        var title: String { rawValue.capitalized }
        var symbol: String { self == .video ? "film" : "photo" }
    }
    var id = UUID()
    var mode: Mode?
    var model: String?
    var prompt: String?
    /// aspect / duration / resolution and anything else the feed item preconfigures.
    var params: [String: JSONValue] = [:]
    var startFrame: UploadedAsset?
    /// Preset or feature shown on the stage instead of the model.
    var title: String?
    var subtitle: String?
    var preview: MediaPreview?
    /// Zoom-transition source.
    var sourceID: String?
}

/// Full-screen composer: media stage on top, a floating glass card with prompt, option chips and Generate.
struct ComposerView: View {
    var request: ComposerRequest?
    /// Shows a close button (iPhone full-screen cover).
    var dismissable = false

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @AppStorage("create.mode") private var mode: ComposerRequest.Mode = .video
    @AppStorage("create.imageModel") private var imageModelID = ""
    @AppStorage("create.videoModel") private var videoModelID = ""
    @State private var prompt = ""
    @State private var aspect = ""
    @State private var duration: Double = 0
    @State private var resolution = ""
    @State private var startFrame: UploadedAsset?
    @State private var endFrame: UploadedAsset?
    @State private var references: [UploadedAsset] = []
    @State private var selectedCharacters: Set<String> = []
    @State private var stageTitle: String?
    @State private var stageSubtitle: String?
    @State private var stagePreview: MediaPreview?
    @State private var applied: UUID?
    @State private var pickingModel = false
    @State private var pick: PhotosPickerItem?
    @State private var pickTarget = AttachTarget.start
    @State private var showPicker = false
    /// Reference photos (several at once) and a reference video.
    @State private var refPicks: [PhotosPickerItem] = []
    @State private var showRefPicker = false
    @State private var videoPick: PhotosPickerItem?
    @State private var showVideoPicker = false
    @State private var referenceVideo: UploadedAsset?
    /// "+" menu: Camera · Photos & videos · Files, then "Use as…" for photos.
    @State private var addPicks: [PhotosPickerItem] = []
    @State private var showAddPicker = false
    @State private var showCamera = false
    @State private var importingFile = false
    @State private var pendingPhotos: [UploadedAsset] = []
    @State private var videoToolRoute: VideoToolRoute?
    @State private var uploading = false
    /// The picked photo, shown at once while it uploads.
    @State private var uploadThumb: CGImage?
    @State private var uploadError: String?
    @State private var currentRun: UUID?
    @State private var open: MediaItem?
    @State private var dropTargeted = false
    @FocusState private var promptFocused: Bool

    enum AttachTarget { case start, end, reference }
    /// A picked reference video opens the matching video tool with the clip (and prompt) filled in.
    struct VideoToolRoute: Identifiable { let id = UUID(); let tool: Tool; let clip: UploadedAsset; let prompt: String }
    /// Tools that take a reference video, in the order offered.
    private static let videoToolIDs: [(id: String, title: String, icon: String)] = [
        ("video-edit", "Edit this video with a prompt", "wand.and.stars"),
        ("motion-control", "Copy its motion onto a photo or character", "figure.walk.motion"),
        ("restyle", "Restyle it (new look, same motion)", "paintpalette"),
        ("recast", "Swap a person or object in it", "person.2.crop.square.stack"),
        ("extend", "Continue it (what happens next)", "arrow.right.to.line"),
    ]
    private var videoRefLimit: Int { model.map { $0.isVideo ? $0.caps.refs : max(1, $0.refs) } ?? 0 }

    private var kind: String { mode == .image ? "image" : "video" }
    private var model: ModelInfo? {
        let id = mode == .image ? imageModelID : videoModelID
        if let m = app.catalog?.model(id), m.available, m.kind == kind { return m }
        return app.catalog?.pick(kind: kind, preferred: app.config.defaultList(mode == .image ? "imageModels" : "videoModels"), hiddenProviders: app.hiddenProviders)
    }
    private var maxPrompt: Int { Int(app.config.limit("promptMaxChars", default: 6000)) }
    private var canGenerate: Bool {
        guard let model, !uploading, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !model.requiresStartImage || startFrame != nil
    }
    private var run: GenerationStore.Run? { currentRun.flatMap { id in app.generations.runs.first { $0.id == id } } }

    var body: some View {
        ScreenGate(id: "create", title: "Create") {
            ZStack(alignment: .bottom) {
                stage.ignoresSafeArea()
                VStack(spacing: 0) {
                    topBar
                    Spacer(minLength: 0)
                    stageCaption
                    composerCard
                }
            }
            .background(Color.canvas.ignoresSafeArea())
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .sheet(isPresented: $pickingModel) {
                ModelPickerSheet(mode: mode, selected: model?.id) { m in
                    withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                        mode = m.isVideo ? .video : .image
                        if m.isVideo { videoModelID = m.id } else { imageModelID = m.id }
                        stageTitle = nil; stageSubtitle = nil; stagePreview = nil; currentRun = nil
                    }
                }
                .environment(app)
            }
            .photosPicker(isPresented: $showPicker, selection: $pick, matching: .images, photoLibrary: .shared())
            .photosPicker(isPresented: $showRefPicker, selection: $refPicks, maxSelectionCount: max(1, videoRefLimit - references.count), matching: .images, photoLibrary: .shared())
            .photosPicker(isPresented: $showVideoPicker, selection: $videoPick, matching: .videos, photoLibrary: .shared())
            .photosPicker(isPresented: $showAddPicker, selection: $addPicks, maxSelectionCount: 10, matching: .any(of: [.images, .videos]), photoLibrary: .shared())
            .onChange(of: addPicks) { _, items in
                guard !items.isEmpty else { return }
                addPicks = []
                receive { try await withThrowingTaskGroup(of: (Int, UploadedAsset).self) { g in
                    for (i, item) in items.enumerated() { g.addTask { (i, try await MediaUpload.upload(item, app: app)) } }
                    var out: [(Int, UploadedAsset)] = []
                    for try await r in g { out.append(r) }
                    return out.sorted { $0.0 < $1.0 }.map(\.1)
                } }
            }
            .fileImporter(isPresented: $importingFile, allowedContentTypes: [.image, .movie], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                receive { var out: [UploadedAsset] = []; for u in urls { out.append(try await MediaUpload.imported(u, app: app)) }; return out }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $showCamera) {
                CameraCapture { result in
                    showCamera = false
                    guard let result else { return }
                    switch result {
                    case .photo(let data): receive { [try await MediaUpload.image(data, app: app)] }
                    case .video(let url): receive { defer { try? FileManager.default.removeItem(at: url) }; return [try await MediaUpload.file(url, app: app)] }
                    }
                }
                .ignoresSafeArea()
            }
            #endif
            .confirmationDialog(pendingPhotos.count == 1 ? "Use this photo as…" : "Use these \(pendingPhotos.count) photos as…", isPresented: Binding(get: { !pendingPhotos.isEmpty }, set: { if !$0 { pendingPhotos = [] } }), titleVisibility: .visible) {
                if let m = model {
                    if m.caps.i2v { Button("Start frame") { usePhotos(as: .start) } }
                    if m.caps.end, pendingPhotos.count >= 1 { Button(pendingPhotos.count >= 2 ? "Start + end frame" : "End frame") { usePhotos(as: .end) } }
                    if m.caps.refs > 0 { Button("Reference photos (keeps the subject)") { usePhotos(as: .reference) } }
                }
                Button("Cancel", role: .cancel) { pendingPhotos = [] }
            }
            .onChange(of: refPicks) { _, items in
                guard !items.isEmpty else { return }
                refPicks = []
                pickTarget = .reference
                for item in items { attach { try await MediaUpload.upload(item, app: app) } }
            }
            .onChange(of: videoPick) { _, item in
                guard let item else { return }
                videoPick = nil
                uploading = true
                uploadError = nil
                Task {
                    do {
                        let clip = try await MediaUpload.upload(item, app: app)
                        referenceVideo = clip
                    } catch {
                        uploadError = error.localizedDescription
                        app.report(error, screen: "create", action: "Upload video")
                    }
                    uploading = false
                }
            }
            .confirmationDialog("Use this video to…", isPresented: Binding(get: { referenceVideo != nil && videoToolRoute == nil }, set: { if !$0 { referenceVideo = nil } }), titleVisibility: .visible) {
                if !Self.videoToolIDs.contains(where: { t in app.tools.contains { $0.id == t.id } }) {
                    Button("Open Tools") { referenceVideo = nil; app.requestedTab = "tools" }
                }
                ForEach(Self.videoToolIDs, id: \.id) { t in
                    if let tool = app.tools.first(where: { $0.id == t.id }), let clip = referenceVideo {
                        Button(t.title) { videoToolRoute = VideoToolRoute(tool: tool, clip: clip, prompt: prompt) }
                    }
                }
                Button("Cancel", role: .cancel) { referenceVideo = nil }
            } message: {
                if !Self.videoToolIDs.contains(where: { t in app.tools.contains { $0.id == t.id } }) {
                    Text("This studio has no video tools connected yet (they need a video provider such as ApiMart or fal).")
                }
            }
            .sheet(item: $videoToolRoute, onDismiss: { referenceVideo = nil }) { r in
                NavigationStack {
                    ToolRunView(tool: r.tool, prefill: r.prompt.isEmpty ? [:] : ["prompt": .string(r.prompt)], prefillAsset: r.clip)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { videoToolRoute = nil } } }
                }
                .environment(app)
            }
            .onChange(of: pick) { _, item in
                guard let item else { return }
                pick = nil
                attach { try await MediaUpload.upload(item, app: app) { img in Task { @MainActor in uploadThumb = img } } }
            }
            #if os(iOS)
            .fullScreenCover(item: $open) { item in NavigationStack { MediaViewer(item: item) }.environment(app) }
            #else
            .navigationDestination(item: $open) { MediaViewer(item: $0) }
            #endif
            .task(id: app.refreshTick) { if app.catalog == nil { await app.reloadCatalog() } }
            .onAppear {
                apply(request)
                #if DEBUG
                if UserDefaults.standard.bool(forKey: "openModelPicker") { pickingModel = true }
                if let p = UserDefaults.standard.string(forKey: "samplePrompt"), prompt.isEmpty { prompt = p }
                #endif
            }
            .onChange(of: request?.id) { _, _ in apply(request) }
            .onChange(of: app.composerDraft?.id) { _, _ in
                // iPad / Mac: a tile opened Create while it was already showing.
                if let d = app.composerDraft { apply(d); app.composerDraft = nil }
            }
            .onChange(of: model?.id, initial: true) { _, _ in normalizeOptions() }
        }
    }

    // MARK: Stage

    /// The big media area: the running / finished result, the start frame, the preset or model example.
    @ViewBuilder private var stage: some View {
        GeometryReader { geo in
            ZStack {
                if let run, !run.isFinished {
                    ZStack {
                        PreviewMediaView(preview: displayPreview, seed: model?.id ?? "stage", autoplay: .never).blur(radius: 24).opacity(0.5)
                        Color.black.opacity(0.35)
                    }
                    .shimmer()
                } else if let item = run?.resultItem {
                    PreviewMediaView(preview: item.tilePreview, seed: item.id, autoplay: .always, cacheVideo: false, maxPixelSize: 1600)
                        .overlay {
                            // The finished result, clearly marked as such (not the start frame it came from).
                            Image(systemName: item.isVideo ? "play.fill" : "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: 26, weight: .bold)).foregroundStyle(.white)
                                .frame(width: 68, height: 68).studioGlass(Circle())
                        }
                        .onTapGesture { open = item }
                        .transition(.opacity.combined(with: .scale(scale: 1.04)))
                } else if uploading, let uploadThumb {
                    Image(decorative: uploadThumb, scale: 1).resizable().scaledToFill().blur(radius: 6).shimmer()
                } else {
                    PreviewMediaView(preview: displayPreview, seed: model?.id ?? "stage", symbol: mode.symbol, autoplay: .always, maxPixelSize: 1600)
                }
            }
            .frame(width: geo.size.width, height: geo.size.height)
            .overlay {
                LinearGradient(stops: [.init(color: .black.opacity(0.55), location: 0), .init(color: .clear, location: 0.18),
                                       .init(color: .clear, location: 0.42), .init(color: .black.opacity(0.92), location: 0.78), .init(color: .black, location: 1)],
                               startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)
            }
            .overlay { if dropTargeted { RoundedRectangle(cornerRadius: 0).strokeBorder(Color.ember, lineWidth: 3) } }
        }
        .dropDestination(for: ImportedImage.self) { items, _ in
            guard let first = items.first, app.config.isOn("dragAndDrop") else { return false }
            pickTarget = mode == .video ? .start : .reference
            attach { try await MediaUpload.image(first.data, app: app) }
            return true
        } isTargeted: { dropTargeted = $0 }
        .animation(.spring(response: 0.45, dampingFraction: 0.88), value: run?.isFinished)
    }

    private var displayPreview: MediaPreview? {
        if let startFrame, mode == .video || references.isEmpty { return MediaPreview(url: startFrame.url, kind: "image") }
        if let r = references.first { return MediaPreview(url: r.url, kind: "image") }
        return stagePreview ?? model?.preview
    }

    @ViewBuilder private var stageCaption: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let run, !run.isFinished {
                HStack(spacing: 8) {
                    ProgressView().tint(.ember).controlSize(.small)
                    Text(run.job?.fraction.map { "GENERATING \(Int($0 * 100))%" } ?? "GENERATING").font(.label(13, weight: .heavy)).foregroundStyle(Color.ember)
                }
                Text(run.statusText).font(.footnote).foregroundStyle(Color.textSecondary).lineLimit(1)
            } else if let run, run.isFinished, !run.succeeded {
                Label(run.statusText, systemImage: "exclamationmark.triangle.fill").font(.footnote.weight(.semibold)).foregroundStyle(.red).lineLimit(2)
            } else if run?.succeeded == true {
                MediaBadge(text: "Ready · tap to open", ember: true)
            } else {
                if let badge = model.map({ app.catalog?.providerLabel($0.provider) ?? $0.provider }), stageTitle == nil { MediaBadge(text: badge) }
                // Landscape iPhone: a one-line caption so it doesn't run into the stage glyph (QA-14).
                DisplayTitle(stageTitle ?? model?.displayName ?? (app.catalog == nil ? "Loading models" : "No \(kind) models"), size: verticalSizeClass == .compact ? 24 : 40,
                             lineLimit: verticalSizeClass == .compact ? 1 : 2)
                    .foregroundStyle(.white)
                if verticalSizeClass != .compact, let sub = (stageSubtitle ?? model?.blurb)?.nonEmpty {
                    Text(sub).font(.subheadline).foregroundStyle(Color.textSecondary).lineLimit(2)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.bottom, 14)
        .frame(maxWidth: 760)
        .animation(.easeOut(duration: 0.2), value: run?.statusText)
    }

    private var topBar: some View {
        HStack(spacing: 10) {
            if dismissable {
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 15, weight: .bold)).frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .studioGlass(Circle(), interactive: true)
                .accessibilityLabel("Close")
                .keyboardShortcut(.cancelAction)
            }
            Spacer(minLength: 0)
            ModeSwitch(mode: Binding(get: { mode }, set: { m in
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { mode = m; currentRun = nil }
            }))
            Spacer(minLength: 0)
            Menu {
                Button("Reload Models", systemImage: "arrow.clockwise") { Task { await app.reloadCatalog() } }
                OpenOnWebButton(path: app.config.presentation(for: "create").path ?? "/", title: "Create")
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 15, weight: .bold)).frame(width: 40, height: 40)
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .studioGlass(Circle(), interactive: true)
            .accessibilityLabel("More")
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    // MARK: Composer card

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if startFrame != nil || endFrame != nil || !references.isEmpty || uploading || uploadError != nil { attachments }
            TextField("Describe your shot — subject, action, place, light, camera…", text: $prompt, axis: .vertical)
                .font(.system(size: 17))
                .foregroundStyle(.white)
                .lineLimit(1...6)
                .focused($promptFocused)
                .textFieldStyle(.plain)
                .onChange(of: prompt) { _, v in if v.count > maxPrompt { prompt = String(v.prefix(maxPrompt)) } }
                .accessibilityLabel("Prompt")
            chips
            HStack(alignment: .center, spacing: 12) {
                if let hint = costHint {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("COST").font(.label(10, weight: .heavy)).foregroundStyle(Color.textTertiary)
                        Text(hint).font(.caption.weight(.semibold)).foregroundStyle(Color.textSecondary).lineLimit(1)
                    }
                    .fixedSize()
                }
                Button(action: generate) {
                    HStack(spacing: 8) {
                        // Say why Generate is waiting instead of just greying it out (QA-19).
                        if uploading { ProgressView().controlSize(.small).tint(Color.onEmber); Text("Uploading…") }
                        else { Text("Generate"); Image(systemName: "sparkle") }
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.ember(.large, fullWidth: true))
                .disabled(!canGenerate)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityHint(model?.requiresStartImage == true && startFrame == nil ? "\(model?.displayName ?? "This model") needs a start frame" : "")
            }
            if let m = model, m.requiresStartImage, startFrame == nil {
                Text("\(m.displayName) needs a start frame — tap + and add a photo.").font(.caption).foregroundStyle(Color.textSecondary)
            }
        }
        .padding(16)
        .studioGlass(RoundedRectangle(cornerRadius: 28, style: .continuous))
        .padding(.horizontal, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: 760)
        #if os(iOS)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { promptFocused = false }
            }
        }
        #endif
    }

    private var costHint: String? { model?.price }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                addMenu
                Button { pickingModel = true } label: {
                    StudioChip(title: model?.displayName ?? "Model", systemImage: mode.symbol, selected: true, showsChevron: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Model: \(model?.displayName ?? "none")")
                if let m = model {
                    if !m.aspects.isEmpty {
                        optionMenu(title: aspect, icon: "aspectratio", options: m.aspects.map { ($0, $0) }) { aspect = $0 }
                    }
                    if m.isVideo, !m.durations.isEmpty {
                        optionMenu(title: "\(Int(duration))s", icon: "clock", options: m.durations.map { ("\(Int($0)) s", String($0)) }) { duration = Double($0) ?? duration }
                    }
                    if !m.resolutions.isEmpty {
                        optionMenu(title: resolution, icon: "sparkles.tv", options: m.resolutions.map { ($0, $0) }) { resolution = $0 }
                    }
                    if app.config.isOn("characterPicker"), app.charactersAvailable == true, !app.characters.isEmpty { characterMenu }
                }
            }
            .padding(.vertical, 1)
        }
        .scrollClipDisabled()
    }

    private func optionMenu(title: String, icon: String, options: [(String, String)], pick: @escaping (String) -> Void) -> some View {
        Menu {
            ForEach(options, id: \.1) { o in Button(o.0) { pick(o.1) } }
        } label: {
            StudioChip(title: title.isEmpty ? "—" : title, systemImage: icon, showsChevron: true)
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
    }

    private var characterMenu: some View {
        Menu {
            ForEach(app.characters) { c in
                Toggle(c.name, isOn: Binding(get: { selectedCharacters.contains(c.id) }, set: { on in
                    if on { selectedCharacters.insert(c.id) } else { selectedCharacters.remove(c.id) }
                }))
            }
        } label: {
            let names = app.characters.filter { selectedCharacters.contains($0.id) }.map(\.name)
            StudioChip(title: names.isEmpty ? "Character" : names.joined(separator: ", "), systemImage: "person.crop.square", selected: !names.isEmpty, showsChevron: true)
        }
        #if os(iOS)
        .menuActionDismissBehavior(.disabled)
        #endif
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
    }

    /// "+": Camera · Photos & videos · Files. Photos then ask how to use them; a video opens the video tools.
    private var addMenu: some View {
        Menu {
            #if os(iOS)
            if CameraCapture.isAvailable { Button("Camera", systemImage: "camera") { showCamera = true } }
            #endif
            Button("Photos & videos", systemImage: "photo.on.rectangle") { showAddPicker = true }
            Button("Files", systemImage: "paperclip") { importingFile = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 36, height: 36)
                .background(Color.white.opacity(0.12), in: Circle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Add photo or video")
        .accessibilityIdentifier("composer.add")
    }

    /// Upload whatever was picked, then sort it: videos → video tools, photos → frame/reference (asks when there's a choice).
    private func receive(_ work: @escaping () async throws -> [UploadedAsset]) {
        uploading = true
        uploadError = nil
        Task {
            do {
                let assets = try await work()
                let videos = assets.filter { $0.kind.hasPrefix("video") }
                let photos = assets.filter { !$0.kind.hasPrefix("video") }
                if let v = videos.first { referenceVideo = v }
                if !photos.isEmpty { routePhotos(photos) }
            } catch {
                uploadError = error.localizedDescription
                app.report(error, screen: "create", action: "Add media")
            }
            uploading = false
        }
    }

    private func routePhotos(_ photos: [UploadedAsset]) {
        guard let m = model else { return }
        if !m.isVideo { // image models: everything is a reference
            withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { references = Array((references + photos).prefix(max(1, m.refs))) }
            return
        }
        let options = (m.caps.i2v ? 1 : 0) + (m.caps.refs > 0 ? 1 : 0)
        if options <= 1 { pendingPhotos = photos; usePhotos(as: m.caps.refs > 0 && !m.caps.i2v ? .reference : .start) }
        else { pendingPhotos = photos }
    }

    private func usePhotos(as target: AttachTarget) {
        let photos = pendingPhotos
        pendingPhotos = []
        guard let m = model, !photos.isEmpty else { return }
        withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
            switch target {
            case .start:
                startFrame = photos[0]
                if !m.caps.refsWithImage { references = [] }
            case .end:
                if photos.count >= 2 { startFrame = photos[0]; endFrame = photos[1] } else { endFrame = photos[0] }
                if !m.caps.refsWithImage { references = [] }
            case .reference:
                references = Array((references + photos).prefix(m.caps.refs))
                if !m.caps.refsWithImage { startFrame = nil; endFrame = nil }
            }
            currentRun = nil
        }
    }

    @ViewBuilder private func attachMenu(_ m: ModelInfo) -> some View {
        if m.isVideo {
            // Reference photos keep a subject/character consistent; some models can't combine them with a start frame.
            let refsBlockFrames = !references.isEmpty && !m.caps.refsWithImage
            let framesBlockRefs = startFrame != nil && !m.caps.refsWithImage
            Menu {
                Section("Photos") {
                    Button(startFrame == nil ? "Start frame…" : "Replace start frame…", systemImage: "photo") { pickTarget = .start; showPicker = true }
                        .disabled(refsBlockFrames)
                    if m.caps.end { Button(endFrame == nil ? "End frame…" : "Replace end frame…", systemImage: "photo.badge.checkmark") { pickTarget = .end; showPicker = true }.disabled(refsBlockFrames) }
                    if m.caps.refs > 0 {
                        Button(references.isEmpty ? "Reference photos (up to \(m.caps.refs))…" : "Add reference photos (\(references.count)/\(m.caps.refs))…", systemImage: "person.crop.rectangle.stack") { showRefPicker = true }
                            .disabled(framesBlockRefs || references.count >= m.caps.refs)
                    }
                }
                Section("Video") {
                    Button("Reference video…", systemImage: "film") { showVideoPicker = true }
                }
                if refsBlockFrames || framesBlockRefs {
                    Text("\(m.displayName): start frame or reference photos, not both")
                }
            } label: {
                StudioChip(title: startFrame == nil && references.isEmpty ? "Add photo / video" : (references.isEmpty ? "Frames" : "References \(references.count)"), systemImage: "plus")
            }
            .menuIndicator(.hidden)
            .buttonStyle(.plain)
        } else {
            Menu {
                if references.count < max(1, m.refs) {
                    Button(m.refs > 1 ? "Reference photos (up to \(m.refs))…" : "Reference photo…", systemImage: "photo.on.rectangle") { showRefPicker = true }
                }
                Button("Reference video…", systemImage: "film") { showVideoPicker = true }
            } label: { StudioChip(title: references.isEmpty ? "Add photo / video" : "References \(references.count)", systemImage: "plus") }
                .menuIndicator(.hidden)
                .buttonStyle(.plain)
        }
    }

    private var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if let startFrame { thumb(startFrame, label: mode == .video ? "START" : "REF") { self.startFrame = nil } }
                if let endFrame { thumb(endFrame, label: "END") { self.endFrame = nil } }
                ForEach(references) { r in thumb(r, label: "REF") { references.removeAll { $0.id == r.id } } }
                if uploading {
                    ZStack {
                        if let uploadThumb { Image(decorative: uploadThumb, scale: 1).resizable().scaledToFill().opacity(0.55) }
                        ProgressView().tint(.ember)
                    }
                    .frame(width: 54, height: 54)
                    .background(Color.surfaceHigh)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(alignment: .bottomLeading) { Text("UPLOADING").font(.label(8, weight: .heavy)).lineLimit(1).fixedSize().foregroundStyle(.white).padding(.horizontal, 4).background(.black.opacity(0.6), in: Capsule()).padding(3) }
                    .padding(.top, 5)
                    .accessibilityLabel("Uploading")
                }
                if let uploadError { Text(uploadError).font(.caption).foregroundStyle(.red).lineLimit(2).frame(maxWidth: 220, alignment: .leading) }
            }
        }
    }

    private func thumb(_ a: UploadedAsset, label: String, remove: @escaping () -> Void) -> some View {
        AuthedImage(url: a.url, maxPixelSize: 200, quiet: true)
            .frame(width: 54, height: 54)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(alignment: .bottomLeading) { Text(label).font(.label(9, weight: .heavy)).foregroundStyle(Color.onEmber).padding(.horizontal, 4).background(Color.ember, in: Capsule()).padding(3) }
            .overlay(alignment: .topTrailing) {
                Button(action: { withAnimation { remove() } }) {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 18)).foregroundStyle(.white, .black.opacity(0.7))
                }
                .buttonStyle(.plain)
                .offset(x: 5, y: -5)
                .accessibilityLabel("Remove \(label.lowercased())")
            }
            .padding(.top, 5).padding(.trailing, 5)
    }

    // MARK: Actions

    private func apply(_ r: ComposerRequest?) {
        guard let r, applied != r.id else { return }
        applied = r.id
        if let m = r.model.flatMap({ app.catalog?.model($0) }) {
            mode = m.isVideo ? .video : .image
            if m.isVideo { videoModelID = m.id } else { imageModelID = m.id }
        } else if let mode = r.mode ?? r.params["mode"]?.string.flatMap(ComposerRequest.Mode.init(rawValue:)) {
            self.mode = mode
            if let id = r.model { if mode == .video { videoModelID = id } else { imageModelID = id } }
        }
        if let p = r.prompt?.nonEmpty ?? r.params["prompt"]?.string?.nonEmpty { prompt = p }
        if let a = r.params["aspect"]?.string { aspect = a }
        if let d = r.params["duration"]?.double { duration = d }
        if let res = r.params["resolution"]?.string { resolution = res }
        if let s = r.startFrame {
            if mode == .video { startFrame = s } else { references = [s] }
        }
        stageTitle = r.title
        stageSubtitle = r.subtitle
        stagePreview = r.preview
        currentRun = nil
        normalizeOptions()
    }

    private func normalizeOptions() {
        guard let m = model else { return }
        let defAspect = app.config.defaultString("aspect") ?? "16:9"
        if !m.aspects.contains(aspect) { aspect = m.aspects.contains(defAspect) ? defAspect : (m.aspects.first ?? "") }
        let defDur = app.config.defaultDouble("videoDuration") ?? 8
        if m.isVideo, !m.durations.contains(duration) { duration = m.durations.contains(defDur) ? defDur : (m.durations.first ?? 0) }
        if !m.resolutions.contains(resolution) { resolution = m.resolutionDefault.flatMap { m.resolutions.contains($0) ? $0 : nil } ?? m.resolutions.first ?? "" }
        if !m.caps.end { endFrame = nil }
        if m.isVideo, references.count > m.caps.refs { references = Array(references.prefix(m.caps.refs)) }
        if !m.isVideo, m.refs == 0 { references = [] }
        if !m.isVideo, m.refs > 0, references.count > m.refs { references = Array(references.prefix(m.refs)) }
    }

    private func attach(_ work: @escaping () async throws -> UploadedAsset) {
        uploading = true
        uploadError = nil
        let target = pickTarget
        Task {
            do {
                let a = try await work()
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) {
                    switch target {
                    case .start: startFrame = a
                    case .end: endFrame = a
                    case .reference: references.append(a)
                    }
                    currentRun = nil
                }
            } catch {
                uploadError = error.localizedDescription
                app.report(error, screen: "create", action: "Upload")
            }
            uploading = false
            uploadThumb = nil
        }
    }

    private func generate() {
        guard let m = model, canGenerate else { return }
        let refs = references.map(\.id)
        var request = GenerateRequest(
            model: m.id,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            aspect: aspect.nonEmpty,
            duration: m.isVideo && duration > 0 ? duration : nil,
            resolution: resolution.nonEmpty,
            startImage: m.isVideo ? startFrame?.id : refs.first,
            endImage: m.isVideo && m.caps.end ? endFrame?.id : nil,
            references: m.isVideo ? Array(refs.prefix(m.caps.refs)) : Array(refs.dropFirst()),
            characters: Array(selectedCharacters)
        )
        request.refMode = m.isVideo && !refs.isEmpty && m.caps.refs > 0
        let client = app.client
        Platform.impact()
        promptFocused = false
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            currentRun = app.generations.start(title: m.displayName, subtitle: request.prompt, kind: m.kind, source: "create", app: app) {
                try await client.generate(request)
            }
        }
    }
}

/// Image / Video switch in a glass capsule; the selected side is ember.
private struct ModeSwitch: View {
    @Binding var mode: ComposerRequest.Mode
    @Namespace private var ns
    var body: some View {
        HStack(spacing: 2) {
            ForEach(ComposerRequest.Mode.allCases) { m in
                Button { mode = m } label: {
                    Text(m.title.uppercased())
                        .font(.label(13, weight: .heavy))
                        .tracking(0.6)
                        .foregroundStyle(mode == m ? Color.onEmber : .white)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .background {
                            if mode == m { Capsule().fill(Color.ember).matchedGeometryEffect(id: "mode", in: ns) }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(mode == m ? .isSelected : [])
            }
        }
        .padding(3)
        .studioGlass(Capsule())
    }
}

// MARK: - Model picker

/// Model cards with preview media, provider badge and blurb; Video / Image.
struct ModelPickerSheet: View {
    let mode: ComposerRequest.Mode
    let selected: String?
    let onPick: (ModelInfo) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var shown: ComposerRequest.Mode = .video
    @State private var search = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    Picker("Kind", selection: $shown) {
                        ForEach(ComposerRequest.Mode.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 16)
                    let groups = app.catalog?.groups(kind: shown.rawValue, hiddenProviders: app.hiddenProviders) ?? []
                    if groups.isEmpty {
                        ContentUnavailableView("No \(shown.rawValue) models connected", systemImage: "puzzlepiece.extension",
                                               description: Text("Connect a provider on the studio server. Settings shows what's online."))
                    }
                    ForEach(groups, id: \.provider) { g in
                        let models = g.models.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) || $0.blurb.localizedCaseInsensitiveContains(search) }
                        if !models.isEmpty {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(g.label.uppercased()).font(.label(12, weight: .heavy)).tracking(0.8).foregroundStyle(Color.textTertiary).padding(.horizontal, 16)
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 158, maximum: 260), spacing: 10)], spacing: 14) {
                                    ForEach(models) { m in
                                        Button {
                                            onPick(m)
                                            Platform.selection()
                                            dismiss()
                                        } label: { ModelCard(model: m, provider: g.label, selected: m.id == selected) }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .padding(.horizontal, 16)
                            }
                        }
                    }
                }
                .padding(.vertical, 12)
            }
            .studioCanvas()
            .searchable(text: $search, prompt: "Search models")
            .navigationTitle("Models")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onAppear { shown = mode }
        }
        .presentationDetents([.large])
        .presentationBackground(Color.canvas)
        #if os(macOS)
        .frame(minWidth: 620, minHeight: 640)
        #endif
    }
}

private struct ModelCard: View {
    let model: ModelInfo
    let provider: String
    let selected: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Color.clear
                .aspectRatio(model.isVideo ? 16 / 11 : 4 / 5, contentMode: .fit)
                .overlay { PreviewMediaView(preview: model.preview, seed: model.id, symbol: model.isVideo ? "film" : "photo") }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(selected ? Color.ember : Color.hairline, lineWidth: selected ? 2.5 : 1))
                .overlay(alignment: .topTrailing) {
                    if selected { Image(systemName: "checkmark.circle.fill").font(.title3).foregroundStyle(Color.onEmber, Color.ember).padding(7) }
                }
            Text(model.displayName.uppercased()).font(.display(19, weight: .heavy)).foregroundStyle(.white).lineLimit(2, reservesSpace: true)
            Text(model.blurb.nonEmpty ?? " ").font(.caption).foregroundStyle(Color.textSecondary).lineLimit(2, reservesSpace: true)
            Text(capabilities).font(.caption2.weight(.medium)).foregroundStyle(Color.textTertiary).lineLimit(1)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private var capabilities: String {
        var parts: [String] = []
        if model.isVideo {
            if model.caps.i2v { parts.append("start frame") }
            if model.caps.end { parts.append("end frame") }
            if let d = model.durations.max() { parts.append("≤\(Int(d))s") }
        } else if model.refs > 0 { parts.append("\(model.refs) ref\(model.refs == 1 ? "" : "s")") }
        if let r = model.resolutions.last { parts.append(r) }
        if let p = model.price { parts.append(p) }
        return parts.joined(separator: " · ")
    }
}

// MARK: - Runs (tool screens)

/// Generations in flight / finished for a screen (used by tool forms).
struct RunsSection: View {
    let source: String
    @Binding var open: MediaItem?
    @Environment(AppModel.self) private var app

    var body: some View {
        let runs = app.generations.runs(from: source)
        if !runs.isEmpty {
            Section {
                ForEach(runs) { run in
                    HStack(spacing: 12) {
                        ZStack {
                            if let item = run.resultItem, !item.previewURL.isEmpty {
                                AuthedImage(url: item.previewURL, maxPixelSize: 200)
                            } else {
                                Rectangle().fill(Color.surfaceHigh).shimmer(!run.isFinished)
                                if run.isFinished {
                                    Image(systemName: run.succeeded ? (run.kind == "audio" ? "waveform" : "film") : "exclamationmark.triangle").foregroundStyle(run.succeeded ? Color.secondary : Color.red)
                                }
                            }
                        }
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(run.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                            Text(run.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            HStack(spacing: 6) {
                                if !run.isFinished, let f = run.job?.fraction { ProgressView(value: f).tint(.ember).frame(maxWidth: 120) }
                                Text(run.statusText).font(.caption2).foregroundStyle(run.error != nil || run.job?.status == .error ? .red : .secondary).lineLimit(2)
                            }
                        }
                        Spacer(minLength: 0)
                        if !run.isFinished {
                            Button { app.generations.cancel(run.id, app: app) } label: { Image(systemName: "stop.circle") }
                                .buttonStyle(.borderless).accessibilityLabel("Cancel")
                        }
                    }
                    .contentShape(Rectangle())
                    .onTapGesture { if let item = run.resultItem { open = item } }
                    .swipeActions { Button("Remove", role: .destructive) { app.generations.remove(run.id) } }
                    .contextMenu { Button("Remove", systemImage: "xmark", role: .destructive) { app.generations.remove(run.id) } }
                }
            } header: {
                HStack {
                    Text("Recent")
                    Spacer()
                    if runs.contains(where: \.isFinished) {
                        Button("Clear") { app.generations.clearFinished(source: source) }.font(.caption).buttonStyle(.borderless)
                    }
                }
            }
        }
    }
}
