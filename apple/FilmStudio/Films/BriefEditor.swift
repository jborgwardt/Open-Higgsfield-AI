import SwiftUI
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
                            Stepper("Length", value: $brief.targetMinutes, in: 0.5...maxMinutes, step: brief.targetMinutes < 2 ? 0.5 : 1)
                                .labelsHidden()
                        }
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
                    if brief.music == "upload" { Text("Your music file").tag("upload") }
                }
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
