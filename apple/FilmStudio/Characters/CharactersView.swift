import SwiftUI
import PhotosUI
import FilmStudioKit

/// Recurring characters with reference photos, so faces stay consistent across shots.
struct CharactersView: View {
    @Environment(AppModel.self) private var app
    @State private var loaded = false
    @State private var error: String?
    @State private var creating = false
    @State private var opened: String?

    var body: some View {
        ScreenGate(id: "characters", title: "Characters") {
            Group {
                if app.charactersAvailable == false {
                    NotDeployedView(title: "Characters are on their way", systemImage: "person.crop.rectangle.stack",
                                    message: "This studio server doesn't have the Characters feature yet. It appears here automatically once the server is updated.",
                                    webPath: app.config.presentation(for: "characters").path) { await load() }
                } else if !loaded {
                    LoadingView(text: "Loading characters…")
                } else if let error, app.characters.isEmpty {
                    ErrorStateView(message: error) { await load() }
                } else if app.characters.isEmpty {
                    ContentUnavailableView {
                        Label("No characters yet", systemImage: "person.crop.rectangle.stack")
                    } description: {
                        Text("Add the people in your films once — a few sharp photos from different angles — and every shot keeps their face.")
                    } actions: {
                        Button("New Character") { creating = true }.buttonStyle(.glassProminent)
                    }
                } else {
                    grid
                }
            }
            .navigationTitle("Characters")
            .toolbar {
                if app.charactersAvailable == true {
                    ToolbarItem(placement: .trailing) { Button("New Character", systemImage: "plus") { creating = true } }
                }
            }
            .refreshable { await load() }
            .task(id: app.refreshTick) { await load() }
            .navigationDestination(item: $opened) { CharacterDetailView(id: $0) }
            .sheet(isPresented: $creating) {
                NewCharacterSheet { c in
                    Task { await load(); opened = c?.id }
                }
                .environment(app)
            }
        }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 14)], spacing: 18) {
                ForEach(app.characters) { c in
                    Button { opened = c.id } label: { CharacterCard(c: c) }.buttonStyle(.plain)
                }
            }
            .padding()
        }
    }

    private func load() async {
        await app.loadCharacters()
        loaded = true
        error = app.charactersAvailable == nil ? "Couldn't load characters." : nil
    }
}

private struct CharacterCard: View {
    let c: StudioCharacter
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Color.clear
                .aspectRatio(3 / 4, contentMode: .fit)
                .overlay { AuthedImage(url: c.coverImageURL, maxPixelSize: 600) }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    if c.sheet?.approved == true {
                        Image(systemName: "checkmark.seal.fill").foregroundStyle(.white, .green).font(.title3).padding(8)
                    }
                }
            Text(c.name).font(.headline).lineLimit(1)
            Text("\(c.refs.count) reference\(c.refs.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct NewCharacterSheet: View {
    let onCreated: (StudioCharacter?) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var lookNotes = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    TextField("Who they are (optional)", text: $description, axis: .vertical).lineLimit(2...5)
                    TextField("Look notes — hair, beard, wardrobe (optional)", text: $lookNotes, axis: .vertical).lineLimit(2...5)
                } footer: { Text("Next you'll add reference photos.") }
                if let error { Section { Text(error).foregroundStyle(.red) } }
            }
            .studioForm()
            .navigationTitle("New Character")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if saving { ProgressView() } else {
                        Button("Create") { Task { await save() } }.disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 360)
        #endif
    }

    private func save() async {
        saving = true
        do {
            let c = try await app.client.createCharacter(name: name.trimmingCharacters(in: .whitespaces), description: description, lookNotes: lookNotes)
            onCreated(c)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            app.report(error, screen: "characters", action: "Create character")
        }
        saving = false
    }
}

/// One character: references with quality, angle coverage, guided capture, sheet, voice.
struct CharacterDetailView: View {
    let id: String
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var coverage: Coverage?
    @State private var addPhotos: [PhotosPickerItem] = []
    @State private var addVideo: PhotosPickerItem?
    @State private var working: String?
    @State private var error: String?
    @State private var capturing = false
    @State private var editing = false
    @State private var sheetJob: Job?
    @State private var confirmDelete = false

    private var character: StudioCharacter? { app.characters.first { $0.id == id } }

    var body: some View {
        ScreenGate(id: "characterDetail", params: ["id": id], title: character?.name ?? "Character") {
            Group {
                if let c = character { content(c) } else { LoadingView() }
            }
            .navigationTitle(character?.name ?? "Character")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .trailing) {
                    Menu {
                        Button("Edit Details…", systemImage: "pencil") { editing = true }
                        OpenOnWebButton(path: app.config.presentation(for: "characters").path ?? "/", title: "Characters")
                        Divider()
                        Button("Delete Character…", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                }
            }
            .task(id: app.refreshTick) {
                await refresh()
                // Photos are graded (and videos cut) in the background: keep refreshing until that's done.
                while !Task.isCancelled, character?.isProcessing == true {
                    try? await Task.sleep(for: app.config.interval("characterMs", default: 3000))
                    await refresh()
                }
            }
            .refreshable { await refresh() }
            .onChange(of: addPhotos) { _, items in
                guard !items.isEmpty else { return }
                addPhotos = []
                Task { await upload(items, angle: nil) }
            }
            .onChange(of: addVideo) { _, item in
                guard let item else { return }
                addVideo = nil
                Task { await upload([item], angle: nil) }
            }
            .sheet(isPresented: $capturing) {
                if let c = character {
                    CaptureGuideView(character: c, coverage: coverage) { await refresh() }.environment(app)
                }
            }
            .sheet(isPresented: $editing) {
                if let c = character { EditCharacterSheet(character: c) { await refresh() }.environment(app) }
            }
            .confirmationDialog("Delete \(character?.name ?? "this character")?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task {
                        do { try await app.client.deleteCharacter(id); await app.loadCharacters(); dismiss() } catch { self.error = error.localizedDescription }
                    }
                }
            }
        }
    }

    @ViewBuilder private func content(_ c: StudioCharacter) -> some View {
        List {
            Section {
                HStack(alignment: .top, spacing: 14) {
                    AuthedImage(url: c.coverImageURL, maxPixelSize: 400)
                        .frame(width: 88, height: 110)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(c.name).font(.title3.weight(.semibold))
                        if !c.description.isEmpty { Text(c.description).font(.callout).foregroundStyle(.secondary) }
                        if !c.lookNotes.isEmpty { Text(c.lookNotes).font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }

            coverageSection(c)

            Section {
                if c.refs.isEmpty {
                    Text("No reference photos yet.").foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 10) {
                            ForEach(c.refs) { r in RefTile(ref: r) { await deleteRef(r) } }
                        }
                        .padding(.vertical, 6)
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                }
                if app.config.isOn("guidedCapture") {
                    Button { capturing = true } label: { Label("Guided Capture", systemImage: "camera.viewfinder") }
                }
                PhotosPicker(selection: $addPhotos, maxSelectionCount: 15, matching: .images) { Label("Add Photos", systemImage: "photo.badge.plus") }
                if app.config.isOn("videoRefImport") {
                    PhotosPicker(selection: $addVideo, matching: .videos) { Label("Import Head-Turn Video", systemImage: "video.badge.plus") }
                }
            } header: {
                HStack {
                    Text("References")
                    if let working { Spacer(); ProgressView().controlSize(.mini); Text(working).textCase(nil) }
                }
            } footer: {
                if app.config.isOn("videoRefImport") { Text(app.config.capture.videoInstruction) }
            }

            if app.config.isOn("characterSheet") { sheetSection(c) }
            if app.config.isOn("narration") { voiceSection(c) }
            if let error { Section { Text(error).foregroundStyle(.red) } }
        }
    }

    @ViewBuilder private func coverageSection(_ c: StudioCharacter) -> some View {
        let steps = app.config.capture.checklist
        Section {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                ForEach(steps) { s in
                    let have = coverage?.has(s.id) ?? c.refs.contains { $0.angle == s.id }
                    HStack(spacing: 6) {
                        Image(systemName: have ? "checkmark.circle.fill" : "circle").foregroundStyle(have ? .green : .secondary)
                        Text(s.title).font(.caption).lineLimit(1)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 6).padding(.horizontal, 8)
                    .background(Color.tileBackground, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .accessibilityLabel("\(s.title): \(have ? "done" : "missing")")
                }
            }
            .padding(.vertical, 4)
            ForEach(coverage?.tips ?? [], id: \.self) { tip in
                Label(tip, systemImage: "lightbulb").font(.caption).foregroundStyle(.secondary)
            }
        } header: {
            let done = steps.filter { coverage?.has($0.id) ?? false }.count
            Text("Angles · \(done)/\(steps.count)")
        }
    }

    @ViewBuilder private func sheetSection(_ c: StudioCharacter) -> some View {
        Section {
            if let sheet = c.sheet {
                AuthedImage(url: sheet.url, maxPixelSize: 1600, contentMode: .fit)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .listRowInsets(EdgeInsets())
                if sheet.approved {
                    Label("Approved — used as this character's reference", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                } else {
                    Button { Task { await approveSheet() } } label: { Label("Approve Sheet", systemImage: "checkmark.seal") }
                }
            }
            if let job = sheetJob, !job.status.isFinished {
                HStack {
                    ProgressView(value: job.fraction ?? 0)
                    Text(job.message.nonEmpty ?? "Drawing the sheet…").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Button { Task { await makeSheet() } } label: {
                    Label(c.sheet == nil ? "Generate Character Sheet" : "Generate a New Sheet", systemImage: "rectangle.grid.3x2")
                }
                .disabled(c.refs.isEmpty)
            }
        } header: { Text("Character sheet") } footer: {
            Text("A turnaround sheet built from the references. Once approved, it keeps the face consistent in every shot.")
        }
    }

    @ViewBuilder private func voiceSection(_ c: StudioCharacter) -> some View {
        let eleven = app.sound.voice.first { $0.id == "eleven" }
        if let eleven, eleven.available, !eleven.voices.isEmpty {
            Section("Voice") {
                Picker("ElevenLabs voice", selection: Binding(get: { c.voice?.voiceId ?? "" }, set: { v in Task { await setVoice(v) } })) {
                    Text("None").tag("")
                    ForEach(eleven.voices) { Text($0.name).tag($0.id) }
                }
            }
        }
    }

    // MARK: Actions

    private func refresh() async {
        await app.loadCharacters()
        coverage = try? await app.client.coverage(id)
    }

    private func upload(_ items: [PhotosPickerItem], angle: String?) async {
        error = nil
        var ids: [String] = []
        for (i, item) in items.enumerated() {
            working = items.count > 1 ? "Uploading \(i + 1)/\(items.count)…" : "Uploading…"
            do { ids.append(try await MediaUpload.upload(item, app: app).id) } catch {
                self.error = error.localizedDescription
                app.report(error, screen: "characterDetail", action: "Upload reference")
            }
        }
        if !ids.isEmpty {
            working = "Checking quality…"
            do { try await app.client.addCharacterRefs(id, assetIds: ids, angle: angle) } catch {
                self.error = error.localizedDescription
                app.report(error, screen: "characterDetail", action: "Add references")
            }
        }
        working = nil
        await refresh()
    }

    private func deleteRef(_ r: StudioCharacter.Ref) async {
        do { try await app.client.deleteCharacterRef(id, assetId: r.assetId); await refresh() } catch { self.error = error.localizedDescription }
    }

    private func makeSheet() async {
        error = nil
        do {
            let jobId = try await app.client.makeCharacterSheet(id)
            sheetJob = try await app.client.job(jobId)
            let done = try await app.client.waitForJob(jobId, every: app.config.interval("characterMs", default: 3000)) { j in
                await MainActor.run { sheetJob = j }
            }
            sheetJob = done
            if done.status == .error { error = done.error ?? done.message }
            await refresh()
        } catch {
            self.error = error.localizedDescription
            sheetJob = nil
            app.report(error, screen: "characterDetail", action: "Generate sheet")
        }
    }

    private func approveSheet() async {
        do { try await app.client.approveCharacterSheet(id); await refresh(); Platform.haptic() } catch { self.error = error.localizedDescription }
    }

    private func setVoice(_ voiceId: String) async {
        let value: JSONValue = voiceId.isEmpty ? .null : ["provider": "eleven", "voiceId": .string(voiceId)]
        do { try await app.client.updateCharacter(id, ["voice": value]); await refresh() } catch { self.error = error.localizedDescription }
    }
}

private struct RefTile: View {
    let ref: StudioCharacter.Ref
    let onDelete: () async -> Void
    @Environment(AppModel.self) private var app
    @State private var confirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            AuthedImage(url: ref.url, maxPixelSize: 360)
                .frame(width: 96, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(alignment: .topLeading) {
                    if let s = ref.quality?.normalizedScore {
                        Text("\(Int(s * 100))")
                            .font(.caption2.weight(.bold)).monospacedDigit()
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(s >= 0.7 ? Color.green : s >= 0.45 ? Color.orange : Color.red, in: Capsule())
                            .foregroundStyle(.white)
                            .padding(5)
                            .accessibilityLabel("Quality \(Int(s * 100))")
                    }
                }
                .overlay(alignment: .bottomTrailing) {
                    if ref.kind == "video-frame" { Image(systemName: "video.fill").font(.caption2).padding(4).background(.black.opacity(0.5), in: Circle()).foregroundStyle(.white).padding(4) }
                }
            Text(angleTitle).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            if ref.isAnalyzing {
                HStack(spacing: 3) { ProgressView().controlSize(.mini); Text("Checking…") }.font(.caption2).foregroundStyle(.secondary)
            } else if let issue = ref.error ?? ref.quality?.issues.first {
                Text(issue).font(.caption2).foregroundStyle(.orange).lineLimit(2)
            }
        }
        .frame(width: 96)
        .contextMenu {
            Button("Remove Reference", systemImage: "trash", role: .destructive) { confirm = true }
        }
        .confirmationDialog("Remove this reference?", isPresented: $confirm) {
            Button("Remove", role: .destructive) { Task { await onDelete() } }
        }
    }

    private var angleTitle: String {
        if ref.kind == "sheet" || ref.angle == "turnaround" { return "Sheet" }
        guard let a = ref.angle, a != "unknown" else { return ref.kind == "video-frame" ? "Video frame" : "Photo" }
        return app.config.capture.checklist.first { $0.id == a }?.title ?? a
    }
}

private struct EditCharacterSheet: View {
    let character: StudioCharacter
    let onSaved: () async -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var description = ""
    @State private var lookNotes = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
                TextField("Description", text: $description, axis: .vertical).lineLimit(2...6)
                TextField("Look notes", text: $lookNotes, axis: .vertical).lineLimit(2...6)
                if let error { Text(error).foregroundStyle(.red) }
            }
            .studioForm()
            .navigationTitle("Edit Character")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        Task {
                            do {
                                try await app.client.updateCharacter(character.id, ["name": .string(name), "description": .string(description), "lookNotes": .string(lookNotes)])
                                await onSaved()
                                dismiss()
                            } catch { self.error = error.localizedDescription }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear { name = character.name; description = character.description; lookNotes = character.lookNotes }
        }
        #if os(macOS)
        .frame(minWidth: 460, minHeight: 360)
        #endif
    }
}
