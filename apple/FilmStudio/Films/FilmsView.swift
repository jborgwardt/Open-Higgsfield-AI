import SwiftUI
import FilmStudioKit

/// Long-form productions.
struct FilmsView: View {
    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[ProductionSummary]> = .loading
    @State private var creating = false
    @State private var opened: String?
    @State private var pendingDelete: ProductionSummary?

    var body: some View {
        ScreenGate(id: "films", title: "Films") {
            Group {
                switch state {
                case .loading: LoadingView(text: "Loading films…")
                case .failed(let m): ErrorStateView(message: m) { await load() }
                case .unavailable: EmptyView()
                case .loaded(let list):
                    ScrollView {
                        VStack(alignment: .leading, spacing: 18) {
                            header
                            if list.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    DisplayTitle("Script to screen", size: 28).foregroundStyle(.white)
                                    Text("Write or paste a script, choose a length, and the director plans every shot. Rendering runs on the studio server — you can close the app.")
                                        .font(.subheadline).foregroundStyle(Color.textSecondary)
                                    Button { creating = true } label: { Label("New Film", systemImage: "plus") }.buttonStyle(.ember)
                                }
                                .padding(20)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Color.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                                .padding(.horizontal, 16)
                            } else {
                                LazyVGrid(columns: [GridItem(.adaptive(minimum: 320), spacing: 12)], spacing: 14) {
                                    ForEach(list) { p in
                                        // A button + navigationDestination(item:): value links don't fire when Films itself
                                        // was pushed with a destination link (Profile → Films on iPhone, QA-05).
                                        Button { opened = p.id } label: { FilmCard(p: p) }
                                            .buttonStyle(PressScale())
                                            .contextMenu {
                                                Button("Delete Film…", systemImage: "trash", role: .destructive) { pendingDelete = p }
                                            }
                                    }
                                }
                                .padding(.horizontal, 16)
                            }
                        }
                        .padding(.bottom, 24)
                    }
                }
            }
            .studioCanvas()
            .navigationTitle("Films")
            .inlineTitle()
            .navigationDestination(item: $opened) { id in FilmDetailView(id: id) }
            .toolbar {
                #if os(iOS)
                // The big FILMS header is the title; the ember "New film" is the create action.
                ToolbarItem(placement: .principal) { Text("") }
                #else
                ToolbarItem(placement: .trailing) {
                    Button("New Film", systemImage: "plus") { creating = true }.keyboardShortcut("n", modifiers: [.command, .shift])
                        .tint(.ember)
                }
                #endif
                ToolbarItem(placement: .trailing) {
                    Menu {
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        OpenOnWebButton(path: app.config.presentation(for: "films").path ?? "/", title: "Films")
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                }
            }
            .refreshable { await load() }
            .task(id: app.refreshTick) { await poll() }
            .onChange(of: app.requestNewFilm, initial: true) { _, v in if v { creating = true; app.requestNewFilm = false } }
            .sheet(isPresented: $creating) {
                BriefEditor(production: nil) { p in
                    Task { await load() }
                    opened = p.id
                }
                .environment(app)
            }
            .confirmationDialog("Delete this film?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { p in
                Button("Delete “\(p.title)”", role: .destructive) { Task { await delete(p) } }
            } message: { _ in Text("The production and its plan are deleted. Rendered clips stay in the library.") }
        }
    }

    /// Reload now, then keep the list fresh (fast while something renders).
    private func poll() async {
        await load()
        while !Task.isCancelled {
            let live = state.value?.contains { $0.status.isLive } ?? false
            try? await Task.sleep(for: app.config.interval(live ? "productionMs" : "productionIdleMs", default: live ? 2000 : 15000))
            if Task.isCancelled { break }
            await load()
        }
    }

    private func load() async {
        do { state = .loaded(try await app.fetchProductions()) } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.localizedDescription) }
        }
    }

    private func delete(_ p: ProductionSummary) async {
        do {
            try await app.client.deleteProduction(p.id)
            await load()
        } catch { app.report(error, screen: "films", action: "Delete film") }
    }
}

extension FilmsView {
    var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                DisplayTitle("Films", size: 34, lineLimit: 1).foregroundStyle(.white)
                Spacer()
                Button { creating = true } label: { Label("New film", systemImage: "plus") }.buttonStyle(.ember(.small))
            }
            Text("Long-form: every shot planned, rendered and cut on the server.").font(.subheadline).foregroundStyle(Color.textSecondary)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }
}

/// One production: plan, render, assemble, watch.
extension Brief {
    var lengthText: String { targetMinutes < 1 ? "\(Int((targetMinutes * 60).rounded())) s" : "\(targetMinutes.formatted()) min" }
}

struct FilmDetailView: View {
    let id: String
    @Environment(AppModel.self) private var app
    @State private var production: Production?
    @State private var error: String?
    @State private var busy: String?
    @State private var editingBrief = false
    @State private var shot: Shot?
    @State private var playMaster = false
    @State private var actionError: String?
    @State private var askDirector = false
    @State private var confirmReplan = false

    var body: some View {
        ScreenGate(id: "filmDetail", params: ["id": id], title: production?.title ?? "Film") {
            Group {
                if let p = production { content(p) }
                else if let error { ErrorStateView(message: error) { await load() } }
                else { LoadingView() }
            }
            .navigationTitle(production?.title ?? "Film")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .trailing) {
                    Menu {
                        Button("Edit Brief…", systemImage: "slider.horizontal.3") { editingBrief = true }.disabled(production == nil)
                        if let p = production, !p.shots.isEmpty, p.status != .running, p.status != .planning {
                            Button("Re-plan from the Script…", systemImage: "arrow.triangle.2.circlepath") { confirmReplan = true }
                        }
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                        OpenOnWebButton(path: (app.config.presentation(for: "filmDetail").path ?? app.config.presentation(for: "films").path ?? "/").replacingOccurrences(of: "{id}", with: id), title: production?.title ?? "Film")
                    } label: { Label("More", systemImage: "ellipsis.circle") }
                }
            }
            .task(id: app.refreshTick) { await poll() }
            .refreshable { await load() }
            .sheet(isPresented: $editingBrief) {
                if let p = production {
                    BriefEditor(production: p) { updated in production = updated }.environment(app)
                }
            }
            .sheet(item: $shot) { s in
                ShotSheet(productionID: id, shot: s, narrationOn: production?.brief.narration ?? false) { updated in production = updated }
                    .environment(app)
            }
            .navigationDestination(isPresented: $playMaster) {
                if let m = production?.master {
                    MediaViewer(item: MediaItem(id: "master-\(id)", url: m.url, kind: "videos", model: "Long-form master", prompt: production?.title ?? ""))
                }
            }
            .sheet(isPresented: $askDirector) {
                DirectorSheet { Task { await plan() } }.environment(app)
            }
            .confirmationDialog("Re-plan this film?", isPresented: $confirmReplan, titleVisibility: .visible) {
                Button("Re-plan", role: .destructive) { Task { await plan() } }
            } message: { Text("The director writes a new shot list from the script. Shots rendered so far are replaced.") }
            .alert("Couldn't do that", isPresented: Binding(get: { actionError != nil }, set: { if !$0 { actionError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: { Text(actionError ?? "") }
        }
    }

    @ViewBuilder private func content(_ p: Production) -> some View {
        List {
            Section { header(p) }
            Section { actions(p) }
            if p.shots.isEmpty {
                Section {
                    Text(p.status == .planning ? "The director is writing the shot list…" : "No shots yet. Write a script in the brief, then plan with the director.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(Array(p.sceneGroups.enumerated()), id: \.offset) { i, g in
                Section {
                    ForEach(g.shots) { s in
                        Button { shot = s } label: { ShotRow(shot: s) }.buttonStyle(.plain)
                    }
                } header: {
                    Text(g.scene.map { sc in
                        let t = sc.title.trimmingCharacters(in: .whitespaces)
                        return t.isEmpty || t.lowercased().hasPrefix("scene") ? "Scene \(i + 1)" : "Scene \(i + 1) · \(t)"
                    } ?? "Shots")
                } footer: {
                    if let summary = g.scene?.summary.nonEmpty { Text(summary) }
                }
            }
            if !p.log.isEmpty {
                Section {
                    DisclosureGroup("Activity") {
                        ForEach(p.log.suffix(15).reversed()) { l in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(l.msg).font(.caption)
                                if let d = ISODate.parse(l.at) { Text(d.formatted(date: .omitted, time: .shortened)).font(.caption2).foregroundStyle(.tertiary) }
                            }
                        }
                    }
                }
            }
        }
    }

    private func header(_ p: Production) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let m = p.master {
                Button { playMaster = true } label: {
                    ZStack {
                        AuthedImage(url: p.shots.first?.stillURL, maxPixelSize: 1200)
                            .aspectRatio(16 / 9, contentMode: .fill)
                        Label("Play film · \((m.duration ?? 0).clock)", systemImage: "play.fill")
                            .font(.headline)
                            .padding(.horizontal, 18).padding(.vertical, 12)
                            .studioGlass(interactive: true)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Play film")
            }
            HStack(spacing: 8) {
                StatusBadge(text: p.assembling ? "Assembling" : p.status.label, tint: p.assembling ? .purple : p.status.tint, spinning: p.isLive)
                if !p.shots.isEmpty { Text("\(p.doneCount)/\(p.shots.count) shots").font(.subheadline).foregroundStyle(.secondary).monospacedDigit() }
                Spacer()
                Text("\(p.brief.lengthText) · \(Int(p.brief.clipSeconds)) s clips").font(.caption).foregroundStyle(.secondary)
            }
            if !p.shots.isEmpty { ProgressView(value: Double(p.doneCount), total: Double(max(p.shots.count, 1))) }
            if let plan = p.plan, !plan.logline.isEmpty { Text(plan.logline).font(.callout).italic() }
            if !p.message.isEmpty { Text(p.message).font(.caption).foregroundStyle(.secondary) }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func actions(_ p: Production) -> some View {
        let canPlan = p.status != .running && p.status != .planning
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                if p.shots.isEmpty || p.status == .draft {
                    Button { Task { await plan() } } label: {
                        HStack {
                            if busy == "Plan" { ProgressView().controlSize(.small) } else { Image(systemName: "wand.and.stars") }
                            Text("Plan with Director")
                        }
                        .font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
                    }
                    .glassButton(prominent: true)
                    .controlSize(.large)
                    .disabled(!canPlan || busy != nil || p.brief.script.trimmingCharacters(in: .whitespaces).isEmpty)
                } else if p.status == .running || p.running {
                    actionButton("Pause", "pause.fill", prominent: false) { try await app.client.productionAction(id, "pause") }
                } else if !p.shots.allSatisfy({ $0.status == .done || $0.status == .skipped }) {
                    actionButton(p.doneCount > 0 ? "Resume" : "Render", "play.fill", prominent: true) { try await app.client.productionAction(id, "start") }
                }
                if p.doneCount > 0 {
                    actionButton(p.master == nil ? "Assemble" : "Re-assemble", "film.stack", prominent: p.master == nil && p.shots.allSatisfy { $0.status == .done || $0.status == .skipped }, disabled: !p.canAssemble) { try await app.client.productionAction(id, "assemble") }
                }
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
        if p.brief.script.trimmingCharacters(in: .whitespaces).isEmpty, p.shots.isEmpty {
            Button("Write the script…") { editingBrief = true }
        }
        if p.shots.isEmpty || canPlan {
            LabeledContent("Director", value: app.directors.map { $0.describe($0.current) } ?? "…")
                .font(.callout)
                .task { if app.directors == nil { try? await app.loadDirectors() } }
        }
    }

    private func actionButton(_ title: String, _ icon: String, prominent: Bool, disabled: Bool = false, _ work: @escaping () async throws -> Production) -> some View {
        Button {
            Task { await run(title, work) }
        } label: {
            HStack {
                if busy == title { ProgressView().controlSize(.small) } else { Image(systemName: icon) }
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        }
        .glassButton(prominent: prominent)
        .controlSize(.large)
        .disabled(disabled || busy != nil)
    }

    private func run(_ title: String, _ work: () async throws -> Production) async {
        busy = title
        do { production = try await work(); Platform.haptic() } catch let e as APIError where e.needsDirector {
            askDirector = true
        } catch {
            actionError = error.localizedDescription
            app.report(error, screen: "filmDetail", action: title)
        }
        busy = nil
    }

    /// Planning needs an explicitly chosen director; ask for one first instead of failing.
    private func plan() async {
        if app.directors?.current?.isChosen != true { try? await app.loadDirectors() }
        guard app.directors?.current?.isChosen == true else { askDirector = true; return }
        await run("Plan") { try await app.client.productionAction(id, "plan") }
    }

    private func poll() async {
        await load()
        while !Task.isCancelled {
            let live = production?.isLive ?? false
            try? await Task.sleep(for: app.config.interval(live ? "productionMs" : "productionIdleMs", default: live ? 2000 : 15000))
            if Task.isCancelled { break }
            await load()
        }
    }

    private func load() async {
        do { production = try await app.client.production(id); error = nil } catch is CancellationError {
        } catch {
            if production == nil { self.error = error.localizedDescription }
        }
    }
}

private struct ShotRow: View {
    let shot: Shot
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ZStack(alignment: .bottomLeading) {
                AuthedImage(url: shot.stillURL, maxPixelSize: 360)
                    .frame(width: 112, height: 63)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text("\(shot.index + 1)")
                    .font(.caption2.weight(.bold)).monospacedDigit()
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 4))
                    .foregroundStyle(.white)
                    .padding(4)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(shot.title.nonEmpty ?? "Shot \(shot.index + 1)").font(.subheadline.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    StatusBadge(text: shot.status.label, tint: shot.status.tint, spinning: shot.status == .running)
                }
                Text(shot.prompt).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                if let e = shot.error, shot.status == .error || shot.status == .pending {
                    Text(e).font(.caption2).foregroundStyle(.red).lineLimit(2)
                } else if !shot.message.isEmpty, shot.status == .running {
                    Text(shot.message).font(.caption2).foregroundStyle(.blue).lineLimit(1)
                }
            }
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

/// A shot: watch it, edit the prompt or narration, re-render or skip.
struct ShotSheet: View {
    let productionID: String
    let shot: Shot
    let narrationOn: Bool
    let onChange: (Production) -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var narration = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScreenGate(id: "shotDetail", params: ["id": productionID, "shot": shot.id], title: "Shot \(shot.index + 1)") {
                Form {
                    Section {
                        Group {
                            if let v = shot.videoUrl { EngineVideoPlayer(url: v, autoplay: false) }
                            else { AuthedImage(url: shot.stillURL, maxPixelSize: 1400, contentMode: .fit) }
                        }
                        .aspectRatio(16 / 9, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .listRowInsets(EdgeInsets())
                        HStack {
                            StatusBadge(text: shot.status.label, tint: shot.status.tint, spinning: shot.status == .running)
                            if let d = shot.clipDuration { Text(String(format: "%.1f s", d)).font(.caption).foregroundStyle(.secondary) }
                            Spacer()
                            if shot.attempts > 0 { Text("\(shot.attempts) attempt\(shot.attempts == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary) }
                        }
                        if let e = shot.error { Text(e).font(.caption).foregroundStyle(.red) }
                    }
                    Section {
                        TextField("Prompt", text: $prompt, axis: .vertical).lineLimit(4...14)
                            .disabled(!app.config.isOn("editShotPrompt"))
                    } header: { Text("Prompt") } footer: {
                        Text("Each shot is rendered on its own, so describe who is on screen, the place, light and camera.")
                    }
                    if narrationOn, app.config.isOn("narration") {
                        Section("Narration") {
                            TextField("What the narrator says over this shot", text: $narration, axis: .vertical).lineLimit(2...6)
                        }
                    }
                    Section {
                        Button("Save Changes") { Task { await save(reset: false) } }
                            .disabled(busy || (prompt == shot.prompt && narration == shot.narration))
                        Button("Save & Re-render This Shot") { Task { await save(reset: true) } }
                            .disabled(busy || shot.status == .running)
                        if shot.status != .skipped {
                            Button("Skip This Shot", role: .destructive) { Task { await patch(["skip": true]) } }.disabled(busy)
                        }
                    } footer: {
                        Text("Re-rendering keeps the approved keyframe. Re-assemble the film afterwards.")
                    }
                    if let error { Section { Text(error).foregroundStyle(.red) } }
                }
                .studioForm()
            }
            .navigationTitle("Shot \(shot.index + 1)")
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                if busy { ToolbarItem(placement: .confirmationAction) { ProgressView() } }
            }
            .onAppear { prompt = shot.prompt; narration = shot.narration }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 640)
        #endif
    }

    private func save(reset: Bool) async {
        var body: [String: JSONValue] = [:]
        if prompt != shot.prompt { body["prompt"] = .string(prompt) }
        if narration != shot.narration { body["narration"] = .string(narration) }
        if reset { body["reset"] = true; body["keepKeyframe"] = true }
        await patch(body, render: reset)
    }

    /// `render`: after a reset, start the queue too, so the shot doesn't sit "Queued" until Resume (QA-21).
    private func patch(_ body: [String: JSONValue], render: Bool = false) async {
        guard !body.isEmpty else { dismiss(); return }
        busy = true
        do {
            var p = try await app.client.updateShot(productionID, shot.id, body)
            if render, !p.running, p.status != .running, p.status != .planning {
                p = try await app.client.productionAction(productionID, "start")
            }
            onChange(p)
            dismiss()
        } catch {
            self.error = error.localizedDescription
            app.report(error, screen: "shotDetail", action: "Update shot")
        }
        busy = false
    }
}
