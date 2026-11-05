import SwiftUI
import FilmStudioKit

/// Image and video generation with any available engine model.
struct CreateView: View {
    enum Mode: String, CaseIterable, Identifiable { case image = "Image", video = "Video"; var id: String { rawValue } }

    var initialMode: Mode?
    var initialModel: String?
    @Environment(AppModel.self) private var app
    @AppStorage("create.mode") private var mode: Mode = .video
    @State private var appliedInitial = false
    @AppStorage("create.imageModel") private var imageModelID = ""
    @AppStorage("create.videoModel") private var videoModelID = ""
    @State private var prompt = ""
    @State private var aspect = ""
    @State private var duration: Double = 0
    @State private var resolution = ""
    @State private var startFrame: UploadedAsset?
    @State private var endFrame: UploadedAsset?
    @State private var selectedCharacters: Set<String> = []
    @State private var pickingModel = false
    @State private var open: MediaItem?
    @State private var loadError: String?
    @FocusState private var promptFocused: Bool

    private var kind: String { mode == .image ? "image" : "video" }
    private var model: ModelInfo? {
        let id = mode == .image ? imageModelID : videoModelID
        if let m = app.catalog?.model(id), m.available, m.kind == kind { return m }
        return app.catalog?.pick(kind: kind, preferred: app.config.defaultList(mode == .image ? "imageModels" : "videoModels"), hiddenProviders: app.hiddenProviders)
    }
    private var maxPrompt: Int { Int(app.config.limit("promptMaxChars", default: 6000)) }
    private var canGenerate: Bool {
        guard let model, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !model.requiresStartImage || startFrame != nil
    }

    var body: some View {
        ScreenGate(id: "create", title: "Create") {
            Form {
                Section {
                    Picker("Make", selection: $mode) {
                        ForEach(Mode.allCases) { Label($0.rawValue, systemImage: $0 == .image ? "photo" : "film").tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                }

                Section {
                    Button { pickingModel = true } label: { modelRow }
                        .buttonStyle(.plain)
                } header: { Text("Model") } footer: {
                    if app.catalog == nil, let loadError { Text(loadError).foregroundStyle(.red) }
                }

                Section("Prompt") {
                    TextField("Describe the shot — subject, action, place, light, camera…", text: $prompt, axis: .vertical)
                        .lineLimit(4...12)
                        .focused($promptFocused)
                        .onChange(of: prompt) { _, v in if v.count > maxPrompt { prompt = String(v.prefix(maxPrompt)) } }
                    if prompt.count > maxPrompt * 8 / 10 {
                        Text("\(prompt.count)/\(maxPrompt)").font(.caption).foregroundStyle(.secondary)
                    }
                }

                if let model { optionsSection(model) }
                if let model, app.config.isOn("startEndFrames"), model.acceptsStartImage { framesSection(model) }
                if app.config.isOn("characterPicker"), app.charactersAvailable == true, !app.characters.isEmpty { charactersSection }

                Section {
                    Button(action: generate) {
                        Label(mode == .image ? "Generate Image" : "Generate Video", systemImage: "sparkles")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(!canGenerate)
                    .keyboardShortcut(.return, modifiers: .command)
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                } footer: {
                    if let m = model, m.requiresStartImage, startFrame == nil { Text("\(m.label) needs a start frame.") }
                }

                RunsSection(source: "create", open: $open)
            }
            .studioForm()
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(mode == .image ? "Create Image" : "Create Video")
            .toolbar {
                #if os(iOS)
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { promptFocused = false }
                }
                #endif
                ToolbarItem(placement: .trailing) {
                    Menu {
                        Button("Reload Models", systemImage: "arrow.clockwise") { Task { await app.reloadCatalog() } }
                        OpenOnWebButton(path: app.config.presentation(for: "create").path ?? "/", title: "Create")
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                }
            }
            .sheet(isPresented: $pickingModel) {
                ModelPicker(kind: kind, selected: model?.id) { m in
                    if mode == .image { imageModelID = m.id } else { videoModelID = m.id }
                }
                .environment(app)
            }
            .navigationDestination(item: $open) { MediaViewer(item: $0) }
            .task(id: app.refreshTick) {
                if app.catalog == nil {
                    await app.reloadCatalog()
                    if app.catalog == nil { loadError = "Couldn't load the model list. Pull to retry." }
                }
            }
            .onAppear {
                guard !appliedInitial else { return }
                appliedInitial = true
                if let initialMode { mode = initialMode }
                if let initialModel { if mode == .image { imageModelID = initialModel } else { videoModelID = initialModel } }
            }
            .onChange(of: model?.id, initial: true) { _, _ in normalizeOptions() }
            .onChange(of: app.pendingStartFrame, initial: true) { _, asset in
                guard let asset else { return }
                mode = .video
                startFrame = asset
                app.pendingStartFrame = nil
            }
            .onChange(of: app.generations.lastFinished) { _, run in
                if let run, run.source == "create", let item = run.resultItem { open = item }
            }
            .refreshable { await app.reloadCatalog() }
        }
    }

    private var modelRow: some View {
        HStack(spacing: 12) {
            Image(systemName: mode == .image ? "photo.artframe" : "film.stack").font(.title3).foregroundStyle(Color.accentColor).frame(width: 30)
            VStack(alignment: .leading, spacing: 2) {
                Text(model?.label ?? (app.catalog == nil ? "Loading models…" : "No \(kind) models connected")).font(.body.weight(.medium))
                if let m = model {
                    Text([app.catalog?.providerLabel(m.provider), m.blurb.nonEmpty].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }

    @ViewBuilder private func optionsSection(_ m: ModelInfo) -> some View {
        Section("Options") {
            if !m.aspects.isEmpty {
                Picker("Aspect ratio", selection: $aspect) {
                    ForEach(m.aspects, id: \.self) { Text($0).tag($0) }
                }
            }
            if m.isVideo, !m.durations.isEmpty {
                Picker("Duration", selection: $duration) {
                    ForEach(m.durations, id: \.self) { Text("\(Int($0)) s").tag($0) }
                }
            }
            if !m.resolutions.isEmpty {
                Picker("Resolution", selection: $resolution) {
                    ForEach(m.resolutions, id: \.self) { Text($0).tag($0) }
                }
            }
        }
    }

    @ViewBuilder private func framesSection(_ m: ModelInfo) -> some View {
        Section {
            MediaSlot(title: m.isVideo ? "Start frame" : "Reference image", subtitle: m.isVideo ? "Optional — the clip starts from this image" : "Optional — edit or restyle this image", asset: $startFrame)
            if m.isVideo, m.caps.end {
                MediaSlot(title: "End frame", subtitle: "Optional — the clip ends on this image", asset: $endFrame)
            }
        } header: { Text(m.isVideo ? "Frames" : "Reference") } footer: {
            if app.config.isOn("dragAndDrop"), Platform.isMac || Platform.isPad { Text("Drag images here from Photos, Finder or Safari.") }
        }
    }

    private var charactersSection: some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(app.characters) { c in
                        let on = selectedCharacters.contains(c.id)
                        Button {
                            if on { selectedCharacters.remove(c.id) } else { selectedCharacters.insert(c.id) }
                        } label: {
                            VStack(spacing: 6) {
                                AuthedImage(url: c.coverImageURL, maxPixelSize: 200)
                                    .frame(width: 58, height: 58)
                                    .clipShape(Circle())
                                    .overlay(Circle().strokeBorder(on ? Color.accentColor : .clear, lineWidth: 3))
                                Text(c.name).font(.caption).lineLimit(1).frame(width: 70)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                .padding(.vertical, 4)
            }
        } header: { Text("Characters") } footer: { Text("Selected characters' reference photos keep faces consistent.") }
    }

    private func normalizeOptions() {
        guard let m = model else { return }
        let defAspect = app.config.defaultString("aspect") ?? "16:9"
        if !m.aspects.contains(aspect) { aspect = m.aspects.contains(defAspect) ? defAspect : (m.aspects.first ?? "") }
        let defDur = app.config.defaultDouble("videoDuration") ?? 8
        if m.isVideo, !m.durations.contains(duration) { duration = m.durations.contains(defDur) ? defDur : (m.durations.first ?? 0) }
        if !m.resolutions.contains(resolution) { resolution = m.resolutionDefault.flatMap { m.resolutions.contains($0) ? $0 : nil } ?? m.resolutions.first ?? "" }
        if !m.caps.end { endFrame = nil }
    }

    private func generate() {
        guard let m = model, canGenerate else { return }
        let request = GenerateRequest(
            model: m.id,
            prompt: prompt.trimmingCharacters(in: .whitespacesAndNewlines),
            aspect: aspect.nonEmpty,
            duration: m.isVideo && duration > 0 ? duration : nil,
            resolution: resolution.nonEmpty,
            startImage: startFrame?.id,
            endImage: m.caps.end ? endFrame?.id : nil,
            characters: Array(selectedCharacters)
        )
        let client = app.client
        app.generations.start(title: m.label, subtitle: request.prompt, kind: m.kind, source: "create", app: app) {
            try await client.generate(request)
        }
        promptFocused = false
    }
}

/// Generations in flight / finished, for a screen.
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
                                Rectangle().fill(Color.tileBackground)
                                if !run.isFinished {
                                    ProgressView(value: run.job?.fraction ?? 0).progressViewStyle(.circular)
                                } else {
                                    Image(systemName: run.succeeded ? (run.kind == "audio" ? "waveform" : "film") : "exclamationmark.triangle").foregroundStyle(run.succeeded ? Color.secondary : Color.red)
                                }
                            }
                        }
                        .frame(width: 56, height: 56)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(run.title).font(.subheadline.weight(.medium)).lineLimit(1)
                            Text(run.subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            HStack(spacing: 6) {
                                if !run.isFinished, let f = run.job?.fraction { ProgressView(value: f).frame(maxWidth: 120) }
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

/// Available models of a kind, grouped by provider, with blurbs.
struct ModelPicker: View {
    let kind: String
    let selected: String?
    let onPick: (ModelInfo) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""

    var body: some View {
        NavigationStack {
            List {
                let groups = app.catalog?.groups(kind: kind, hiddenProviders: app.hiddenProviders) ?? []
                if groups.isEmpty {
                    ContentUnavailableView("No \(kind) models connected", systemImage: "puzzlepiece.extension", description: Text("Connect a provider on the studio server. Settings shows what's online."))
                }
                ForEach(groups, id: \.provider) { g in
                    let models = g.models.filter { search.isEmpty || $0.label.localizedCaseInsensitiveContains(search) || $0.blurb.localizedCaseInsensitiveContains(search) }
                    if !models.isEmpty {
                        Section(g.label) {
                            ForEach(models) { m in
                                Button {
                                    onPick(m)
                                    dismiss()
                                } label: {
                                    HStack(alignment: .top) {
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(m.label).font(.body.weight(.medium)).foregroundStyle(.primary)
                                            if !m.blurb.isEmpty { Text(m.blurb).font(.caption).foregroundStyle(.secondary) }
                                            Text(capabilities(m)).font(.caption2).foregroundStyle(.tertiary)
                                        }
                                        Spacer()
                                        if m.id == selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor).fontWeight(.semibold) }
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .searchable(text: $search)
            .navigationTitle(kind == "image" ? "Image Models" : "Video Models")
            .inlineTitle()
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 520)
        #endif
    }

    private func capabilities(_ m: ModelInfo) -> String {
        var parts: [String] = []
        if m.isVideo {
            if m.caps.t2v { parts.append("text → video") }
            if m.caps.i2v { parts.append("start frame") }
            if m.caps.end { parts.append("end frame") }
            if let d = m.durations.max() { parts.append("up to \(Int(d)) s") }
        } else if m.refs > 0 { parts.append("\(m.refs) reference image\(m.refs == 1 ? "" : "s")") }
        if let r = m.resolutions.last { parts.append(r) }
        return parts.joined(separator: " · ")
    }
}
