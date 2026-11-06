import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import FilmStudioKit

/// Create a film or edit its brief. Defaults (models, length, look) come from the server config.
struct BriefEditor: View {
    let production: Production?
    let onSaved: (Production) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var brief = Brief()
    @State private var original = Brief()
    @State private var saving = false
    @State private var error: String?
    @State private var ready = false
    @State private var confirmDiscard = false
    // "+" — reference photos for the film and your own soundtrack.
    @State private var refPicks: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var importingFiles = false
    @State private var importingAudio = false
    @State private var adding = false
    @State private var addError: String?
    /// asset id → URL for thumbnails (server URLs on load, upload URLs after adding).
    @State private var refURL: [String: String] = [:]
    @State private var musicName: String?
    @FocusState private var focused: Field?
    private enum Field: Hashable { case title, script, style, length }
    private var dirty: Bool { ready && brief != original }

    private var isNew: Bool { production == nil }
    private var videoModel: ModelInfo? { app.catalog?.model(brief.videoModel) }
    private var clipChoices: [Double] {
        let d = videoModel?.durations ?? []
        return d.isEmpty ? [4, 5, 6, 8, 10, 15] : d
    }
    private var maxMinutes: Double { app.config.limit("filmMaxMinutes", default: 30) }

    var body: some View {
        NavigationStack {
            ScreenGate(id: "newFilm", title: isNew ? "New Film" : "Brief") {
                Form {
                    Section("Story") {
                        TextField("Title", text: $brief.title).focused($focused, equals: .title).submitLabel(.next)
                            .onSubmit { focused = .script }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Script").font(.caption).foregroundStyle(.secondary)
                            TextEditor(text: $brief.script)
                                .focused($focused, equals: .script)
                                .frame(minHeight: 180)
                                .font(.body)
                                .scrollContentBackground(.hidden)
                                .overlay(alignment: .topLeading) {
                                    if brief.script.isEmpty {
                                        Text("Paste a script, a treatment or a few lines of story. The director turns it into scenes and shots.")
                                            .foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5).allowsHitTesting(false)
                                    }
                                }
                        }
                        TextField("Visual style (optional) — e.g. 35 mm film, soft dawn light, muted greens", text: $brief.style, axis: .vertical)
                            .lineLimit(1...3)
                            .focused($focused, equals: .style)
                    }

                    Section {
                        HStack(spacing: 10) {
                            addMenu
                            if brief.refAssetIds.isEmpty && brief.musicAssetId.isEmpty && !adding {
                                Text("Add photos or audio").foregroundStyle(.secondary).lineLimit(1).fixedSize()
                            }
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(brief.refAssetIds, id: \.self) { id in refThumb(id) }
                                    if adding { ProgressView().frame(width: 56, height: 56) }
                                }
                            }
                        }
                        if !brief.musicAssetId.isEmpty {
                            HStack {
                                Label(musicName ?? "Your soundtrack", systemImage: "music.note").lineLimit(1)
                                Spacer()
                                Button(role: .destructive) { brief.musicAssetId = ""; musicName = nil; if brief.music == "upload" { brief.music = "off" } } label: { Image(systemName: "xmark.circle.fill") }
                                    .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Remove soundtrack")
                            }
                        }
                        if let addError { Text(addError).font(.footnote).foregroundStyle(.red) }
                    } header: { Text("References & audio") } footer: {
                        Text("Photos guide the look of every shot — places, props, wardrobe, mood. An audio file is laid under the finished film as its soundtrack (it is not lip-synced).")
                    }

                    Section {
                        // Type any length (e.g. 7 or 2.5 minutes); the +/− buttons still nudge it.
                        HStack(spacing: 10) {
                            Text("Length")
                            Spacer(minLength: 8)
                            TextField("5", value: $brief.targetMinutes, format: .number.precision(.fractionLength(0...1)))
                                #if os(iOS)
                                .keyboardType(.decimalPad)
                                #endif
                                .multilineTextAlignment(.trailing)
                                .frame(width: 64)
                                .focused($focused, equals: .length)
                                .accessibilityIdentifier("brief.lengthMinutes")
                            Text("min").foregroundStyle(.secondary)
                        }
                        // Exact amounts by dragging (half-minute steps); the typed number above stays in sync.
                        Slider(value: $brief.targetMinutes, in: 0.5...maxMinutes, step: 0.5) {
                            Text("Length")
                        } minimumValueLabel: {
                            Text("0.5").font(.caption).foregroundStyle(.secondary)
                        } maximumValueLabel: {
                            Text("\(Int(maxMinutes))").font(.caption).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier("brief.lengthSlider")
                        .accessibilityValue(brief.lengthText)
                        .onChange(of: brief.targetMinutes) { _, v in
                            let clamped = min(max(v, 0.5), maxMinutes)
                            if clamped != v { brief.targetMinutes = clamped }
                        }
                        Picker("Clip length", selection: $brief.clipSeconds) {
                            ForEach(clipChoices, id: \.self) { Text("\(Int($0)) s").tag($0) }
                        }
                    } header: { Text("Length") } footer: {
                        Text("≈ \(brief.shotCount) shots. Each shot is one clip from the video model.")
                    }

                    Section("Look") {
                        modelPicker("Video model", kind: "video", selection: $brief.videoModel)
                        modelPicker("Keyframe model", kind: "image", selection: $brief.imageModel)
                        Picker("Aspect ratio", selection: $brief.aspect) {
                            ForEach(aspects, id: \.self) { Text($0).tag($0) }
                        }
                        Picker("Resolution", selection: $brief.resolution) {
                            ForEach(resolutions, id: \.self) { Text($0).tag($0) }
                        }
                        Toggle("Keyframe every cut", isOn: $brief.keyframes)
                        Picker("Continuity", selection: $brief.continuity) {
                            Text("Extend clips").tag("extend")
                            Text("Last frame → next").tag("lastframe")
                            Text("Hard cuts").tag("cut")
                        }
                    }

                    Section {
                        DirectorPicker()
                    } header: { Text("Director") } footer: {
                        Text("Shared by all films; change it any time before planning.")
                    }

                    if app.config.isOn("narration") || app.config.isOn("music") { soundSection }

                    Section {
                        Toggle("Assemble automatically", isOn: $brief.autoAssemble)
                        Toggle("Fade between scenes", isOn: $brief.sceneFades)
                        Toggle("Screen each cut with Gemini", isOn: $brief.autoScreen)
                        Toggle("Check character likeness", isOn: $brief.likenessQA)
                    } footer: {
                        Text("Screening and likeness checks are paid Gemini calls. Turn them off for free or offline films.")
                    }

                    if let error { Section { Text(error).foregroundStyle(.red) } }
                }
                .studioForm()
                .scrollDismissesKeyboard(.interactively)
            }
            // A drag-down never throws a typed script away (QA-07).
            .interactiveDismissDisabled(dirty)
            .photosPicker(isPresented: $showPhotoPicker, selection: $refPicks, maxSelectionCount: 10, matching: .images, photoLibrary: .shared())
            .onChange(of: refPicks) { _, items in
                guard !items.isEmpty else { return }
                refPicks = []
                addPhotos { var out: [UploadedAsset] = []; for i in items { out.append(try await MediaUpload.upload(i, app: app)) }; return out }
            }
            .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.image, .audio], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result else { return }
                let audio = urls.filter { UTType(filenameExtension: $0.pathExtension)?.conforms(to: .audio) == true }
                let images = urls.filter { !audio.contains($0) }
                if let a = audio.first { addSoundtrack(a) }
                if !images.isEmpty { addPhotos { var out: [UploadedAsset] = []; for u in images { out.append(try await MediaUpload.imported(u, app: app)) }; return out } }
            }
            .fileImporter(isPresented: $importingAudio, allowedContentTypes: [.audio]) { result in
                if case .success(let url) = result { addSoundtrack(url) }
            }
            #if os(iOS)
            .fullScreenCover(isPresented: $showCamera) {
                CameraCapture { r in
                    showCamera = false
                    if case .photo(let data)? = r { addPhotos { [try await MediaUpload.image(data, app: app)] } }
                }
                .ignoresSafeArea()
            }
            #endif
            .onChange(of: brief.videoModel) { _, id in
                // Picking a free / offline video model for a new film turns the paid checks off with it.
                if isNew, ready, ["local", "handoff"].contains(app.catalog?.model(id)?.provider ?? "") { brief.autoScreen = false; brief.likenessQA = false }
            }
            .confirmationDialog("Discard this film?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                Button("Discard", role: .destructive) { dismiss() }
                Button("Keep Editing", role: .cancel) {}
            } message: { Text("The script and settings you entered will be lost.") }
            .navigationTitle(isNew ? "New Film" : "Brief")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { if dirty { confirmDiscard = true } else { dismiss() } } }
                #if os(iOS)
                // The script editor's keyboard covers most of the form: always offer a way out of it.
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = nil }.fontWeight(.semibold)
                }
                #endif
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button(isNew ? "Create" : "Save") { Task { await save() } }
                            .disabled(brief.title.trimmingCharacters(in: .whitespaces).isEmpty || brief.videoModel.isEmpty)
                    }
                }
            }
            .task {
                guard !ready else { return }
                await app.catalogIfNeeded()
                if let p = production { brief = p.brief } else { brief = defaults() }
                original = brief
                for (id, u) in zip(brief.refAssetIds, brief.refUrls) { refURL[id] = u }
                if !brief.musicAssetId.isEmpty { musicName = "Your soundtrack" }
                ready = true
            }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 680)
        #endif
    }

    private var aspects: [String] {
        let a = videoModel?.aspects ?? []
        return Array(Set((a.isEmpty ? ["16:9", "9:16", "1:1"] : a) + [brief.aspect])).sorted()
    }
    private var resolutions: [String] {
        let r = videoModel?.resolutions ?? []
        return Array(Set((r.isEmpty ? ["720p", "1080p"] : r) + [brief.resolution])).sorted()
    }

    @ViewBuilder private var soundSection: some View {
        Section {
            if app.config.isOn("narration") {
                Toggle("Narrator", isOn: $brief.narration)
                if brief.narration {
                    Picker("Voice from", selection: $brief.voiceProvider) {
                        Text("Best available").tag("auto")
                        ForEach(app.sound.voice) { v in Text(v.label).tag(v.id).disabled(!v.available) }
                    }
                    let provider = app.sound.voice.first { $0.id == (brief.voiceProvider == "auto" ? app.sound.voice.first(where: \.available)?.id : brief.voiceProvider) }
                    if let voices = provider?.voices, !voices.isEmpty {
                        Picker("Voice", selection: $brief.voice) {
                            Text("Default").tag("")
                            ForEach(voices) { Text($0.name).tag($0.id) }
                        }
                    }
                    TextField("Narrator style", text: $brief.narratorStyle)
                }
            }
            if app.config.isOn("music") {
                Picker("Music", selection: $brief.music) {
                    Text("No music").tag("off")
                    Text("AI score per scene").tag("ai").disabled(!app.sound.music.contains(where: \.available))
                    Text(brief.musicAssetId.isEmpty ? "Your music file…" : "Your music file").tag("upload")
                }
                .onChange(of: brief.music) { _, v in if v == "upload", brief.musicAssetId.isEmpty { importingAudio = true } }
                if brief.music == "ai" {
                    TextField("Overall feel (optional)", text: $brief.musicPrompt)
                }
                if brief.music != "off" {
                    LabeledContent("Music volume") {
                        Slider(value: $brief.musicVolume, in: 0...1).frame(maxWidth: 200)
                    }
                }
            }
        } header: { Text("Sound") } footer: {
            Text("Narration and music are mixed when the film is assembled — change them any time and re-assemble; clips aren't re-rendered.")
        }
    }

    private var addMenu: some View {
        Menu {
            #if os(iOS)
            if CameraCapture.isAvailable { Button("Camera", systemImage: "camera") { showCamera = true } }
            #endif
            Button("Photos", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
            Button("Files (photos or audio)", systemImage: "paperclip") { importingFiles = true }
            Button("Soundtrack (audio file)…", systemImage: "music.note") { importingAudio = true }
        } label: {
            Image(systemName: "plus").font(.system(size: 17, weight: .semibold)).foregroundStyle(.white)
                .frame(width: 36, height: 36).glassFill(Circle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .accessibilityLabel("Add photos or audio")
        .accessibilityIdentifier("brief.add")
    }

    private func refThumb(_ id: String) -> some View {
        AuthedImage(url: refURL[id])
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(alignment: .topTrailing) {
                Button { brief.refAssetIds.removeAll { $0 == id } } label: {
                    Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                }
                .buttonStyle(.plain).padding(2).accessibilityLabel("Remove reference photo")
            }
    }

    private func addPhotos(_ work: @escaping () async throws -> [UploadedAsset]) {
        adding = true; addError = nil
        Task {
            do {
                let assets = try await work()
                for a in assets where !brief.refAssetIds.contains(a.id) { brief.refAssetIds.append(a.id); refURL[a.id] = a.url }
            } catch { addError = error.localizedDescription; app.report(error, screen: "newFilm", action: "Add photo") }
            adding = false
        }
    }

    private func addSoundtrack(_ url: URL) {
        adding = true; addError = nil
        Task {
            do {
                let a = try await MediaUpload.imported(url, app: app)
                brief.musicAssetId = a.id; brief.music = "upload"; musicName = url.lastPathComponent
            } catch { addError = error.localizedDescription; app.report(error, screen: "newFilm", action: "Add soundtrack") }
            adding = false
        }
    }

    private func modelPicker(_ title: String, kind: String, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) {
            let groups = app.catalog?.groups(kind: kind, hiddenProviders: app.hiddenProviders) ?? []
            if !groups.flatMap(\.models).contains(where: { $0.id == selection.wrappedValue }) {
                Text(app.catalog?.model(selection.wrappedValue)?.label ?? (selection.wrappedValue.isEmpty ? "Choose…" : selection.wrappedValue)).tag(selection.wrappedValue)
            }
            ForEach(groups, id: \.provider) { g in
                Section(g.label) {
                    ForEach(g.models) { Text($0.label).tag($0.id) }
                }
            }
        }
    }

    /// A new brief from the server's defaults (config.defaults.film + preferred models).
    private func defaults() -> Brief {
        var b = Brief()
        let f = app.config.filmDefaults
        b.title = ""
        if let v = f["targetMinutes"]?.double { b.targetMinutes = v }
        if let v = f["clipSeconds"]?.double { b.clipSeconds = v }
        if let v = f["aspect"]?.string { b.aspect = v }
        if let v = f["resolution"]?.string { b.resolution = v }
        if let v = f["continuity"]?.string { b.continuity = v }
        if let v = f["keyframes"]?.bool { b.keyframes = v }
        if let v = f["narration"]?.bool { b.narration = v }
        if let v = f["music"]?.string { b.music = v }
        if let v = f["autoAssemble"]?.bool { b.autoAssemble = v }
        b.videoModel = app.catalog?.pick(kind: "video", preferred: app.config.defaultList("videoModels"), hiddenProviders: app.hiddenProviders)?.id ?? ""
        b.imageModel = app.catalog?.pick(kind: "image", preferred: app.config.defaultList("imageModels"), hiddenProviders: app.hiddenProviders)?.id ?? ""
        // Paid checks: server default if it says so, otherwise off for free / offline video models (QA-08).
        let freeVideo = ["local", "handoff"].contains(app.catalog?.model(b.videoModel)?.provider ?? "")
        b.autoScreen = f["autoScreen"]?.bool ?? !freeVideo
        b.likenessQA = f["likenessQA"]?.bool ?? !freeVideo
        if let m = app.catalog?.model(b.videoModel), !m.durations.isEmpty, !m.durations.contains(b.clipSeconds) {
            b.clipSeconds = m.durations.min(by: { abs($0 - b.clipSeconds) < abs($1 - b.clipSeconds) }) ?? b.clipSeconds
        }
        return b
    }

    private func save() async {
        saving = true
        error = nil
        do {
            let p: Production
            if let existing = production {
                let changes = brief.changes(from: original)
                p = changes.isEmpty ? existing : try await app.client.updateProduction(existing.id, changes)
            } else {
                p = try await app.client.createProduction(brief.json)
            }
            onSaved(p)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            app.report(error, screen: "newFilm", action: isNew ? "Create film" : "Save brief")
        }
        saving = false
    }
}
