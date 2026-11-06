import SwiftUI
import FilmStudioKit

/// Everything you made: a dense masonry grid (visible clips autoplay muted), filter chips, long-press menu.
/// Generations in flight sit at the top as shimmering placeholders.
struct LibraryView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", videos = "Videos", images = "Images", films = "Films", characters = "Characters", uploads = "Uploads"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.heroNamespace) private var ns
    @State private var state: Loadable<[MediaItem]> = .loading
    @State private var films: [ProductionSummary] = []
    @State private var filter: Filter = .all
    @State private var search = ""
    @State private var searching = false
    @State private var open: MediaItem?
    @State private var openFilm: String?
    @State private var openCharacter: String?
    @State private var pendingDelete: MediaItem?
    @State private var exportTask: Task<Void, Never>?
    @State private var exportStatus: String?
    @State private var exportMessage: String? // success: a short toast
    @State private var exportError: String?   // failure: an alert
    @State private var downloadedFiles: [String: URL] = [:]
    @FocusState private var searchFocused: Bool

    private var filters: [Filter] {
        Filter.allCases.filter { f in
            switch f {
            case .films: app.config.isOn("films")
            case .characters: app.config.isOn("characters") && app.charactersAvailable == true
            case .uploads: state.value?.contains { $0.origin == "upload" } ?? false
            default: true
            }
        }
    }

    private var items: [MediaItem] {
        (state.value ?? []).filter { item in
            switch filter {
            case .uploads: guard item.origin == "upload" else { return false }
            case .videos: guard item.isVideo, item.isCreation else { return false }
            case .images: guard !item.isVideo, item.kind != "audio", item.isCreation else { return false }
            default: guard item.isCreation else { return false }
            }
            return search.isEmpty || item.prompt.localizedCaseInsensitiveContains(search) || item.model.localizedCaseInsensitiveContains(search)
        }
    }

    private var running: [GenerationStore.Run] {
        guard filter == .all || filter == .videos || filter == .images else { return [] }
        return app.generations.runs.filter { r in
            !r.isFinished || (r.isFinished && !r.succeeded && r.error != "Cancelled")
        }.filter { r in filter == .all || (filter == .videos) == (r.kind == "video") }
    }

    var body: some View {
        ScreenGate(id: "library", title: "Library") {
            ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    header.id("top")
                    chips
                    content
                }
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.immediately)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { searchFocused = false }.fontWeight(.semibold)
                }
            }
            .onChange(of: app.scrollToTopTick["library"]) { _, _ in withAnimation(.snappy) { proxy.scrollTo("top", anchor: .top) } }
            }
            .studioCanvas()
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationTitle("Library")
            .refreshable { await load() }
            .task(id: app.refreshTick) { await load() }
            .onChange(of: app.generations.lastFinished) { _, run in
                if run?.succeeded == true { Task { await load() } }
            }
            .navigationDestination(item: $open) { item in
                MediaViewer(item: item, onDelete: { await hide(item) }).zoomTransition("lib-\(item.id)", in: ns)
            }
            .navigationDestination(item: $openFilm) { FilmDetailView(id: $0) }
            .navigationDestination(item: $openCharacter) { CharacterDetailView(id: $0) }
            .confirmationDialog("Remove from the library?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { item in
                Button("Remove", role: .destructive) { Task { await hide(item) } }
            } message: { _ in Text("The file stays on the studio server; it's only hidden from the library.") }
            .safeAreaInset(edge: .bottom) {
                if let exportStatus {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(exportStatus).font(.subheadline.monospacedDigit())
                            #if os(iOS)
                            Text(exportStatus.hasPrefix("Downloading") || exportStatus.hasPrefix("Connection")
                                 ? "You can switch apps: the download keeps going."
                                 : "Keep Film Studio open until saving finishes.").font(.caption).foregroundStyle(.secondary)
                            #endif
                        }
                        Spacer()
                        if exportStatus.hasPrefix("Downloading") || exportStatus.hasPrefix("Connection") {
                            Button("Cancel") { exportTask?.cancel() }
                        }
                    }
                    .padding(14).studioGlass().padding()
                } else if let exportMessage {
                    Label(exportMessage, systemImage: "checkmark.circle.fill")
                        .font(.subheadline.weight(.semibold))
                        .padding(.horizontal, 16).padding(.vertical, 10).studioGlass(Capsule())
                        .padding(.bottom, 8)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .task(id: exportMessage) { try? await Task.sleep(for: .seconds(2.5)); withAnimation { self.exportMessage = nil } }
                }
            }
            .animation(.snappy, value: exportMessage)
            .alert("Export failed", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK", role: .cancel) { exportError = nil }
            } message: { Text(exportError ?? "") }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: 10) {
            if searching {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(Color.textTertiary)
                    TextField("Search prompts and models", text: $search).textFieldStyle(.plain).focused($searchFocused).plainField()
                        .submitLabel(.search)
                        .onSubmit { searchFocused = false } // the keyboard's Search key closes it
                }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .glassFill(Capsule(), interactive: false)
                Button("Cancel") { withAnimation(.snappy) { searching = false; search = "" } }.foregroundStyle(.white)
            } else {
                DisplayTitle("Library", size: 34, lineLimit: 1).foregroundStyle(.white)
                Spacer()
                Button { withAnimation(.snappy) { searching = true }; searchFocused = true } label: {
                    Image(systemName: "magnifyingglass").font(.system(size: 16, weight: .semibold)).frame(width: 40, height: 40)
                }
                .buttonStyle(.plain).foregroundStyle(.white).studioGlass(Circle(), interactive: true)
                .accessibilityLabel("Search")
                Menu {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                    OpenOnWebButton(path: app.config.presentation(for: "library").path ?? "/", title: "Library")
                } label: {
                    Image(systemName: "ellipsis").font(.system(size: 16, weight: .bold)).frame(width: 40, height: 40)
                }
                .menuIndicator(.hidden).buttonStyle(.plain).foregroundStyle(.white).studioGlass(Circle(), interactive: true)
                .accessibilityLabel("More")
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(filters) { f in
                    Button { withAnimation(.snappy) { filter = f } } label: { StudioChip(title: f.rawValue, selected: filter == f) }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(filter == f ? .isSelected : [])
                        .accessibilityIdentifier("libraryFilter.\(f.rawValue)") // distinct from the "Characters" tab button
                }
            }
        }
        .contentMargins(.horizontal, 16, for: .scrollContent)
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        switch filter {
        case .films: filmsGrid
        case .characters: charactersGrid
        default:
            switch state {
            case .loading: skeleton
            case .failed(let m): ErrorStateView(message: m) { await load() }.frame(minHeight: 400)
            case .unavailable: EmptyView()
            case .loaded:
                if items.isEmpty && running.isEmpty { empty } else { masonry }
            }
        }
    }

    private var columns: Int { sizeClass == .regular || verticalSizeClass == .compact || Platform.isMac ? 4 : 2 }

    /// Greedy masonry: each tile goes to the currently shortest column.
    private var masonry: some View {
        let cols = columns
        var heights = Array(repeating: 0.0, count: cols)
        var buckets = Array(repeating: [Cell](), count: cols)
        let cells = running.map(Cell.run) + items.map(Cell.media)
        for cell in cells {
            let i = heights.indices.min { heights[$0] < heights[$1] } ?? 0
            buckets[i].append(cell)
            heights[i] += 1 / cell.aspect
        }
        return HStack(alignment: .top, spacing: 4) {
            ForEach(0..<cols, id: \.self) { c in
                LazyVStack(spacing: 4) {
                    ForEach(buckets[c]) { cell in
                        switch cell {
                        case .run(let r): RunTile(run: r)
                        case .media(let m): mediaTile(m)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 4)
        .animation(.spring(response: 0.4, dampingFraction: 0.88), value: cells.map(\.id))
    }

    private func mediaTile(_ item: MediaItem) -> some View {
        Button { open = item } label: {
            Color.clear
                .aspectRatio(Cell.media(item).aspect, contentMode: .fit)
                .overlay { PreviewMediaView(preview: item.tilePreview, seed: item.id, symbol: item.isVideo ? "film" : "photo", cacheVideo: false, maxPixelSize: 600) }
                .overlay(alignment: .topTrailing) {
                    if item.isVideo { Image(systemName: "play.fill").font(.system(size: 9, weight: .black)).foregroundStyle(.white).padding(6).background(.black.opacity(0.5), in: Circle()).padding(6) }
                }
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(PressScale())
        .zoomSource("lib-\(item.id)", in: ns)
        .contextMenu { menu(for: item) } preview: {
            // Context-menu previews are hosted outside this view tree and don't inherit the environment (QA-01).
            AuthedImage(url: item.previewURL, maxPixelSize: 900, contentMode: .fill)
                .aspectRatio(Cell.media(item).aspect, contentMode: .fit)
                .frame(width: 300)
                .environment(app)
        }
        .accessibilityLabel("\(item.isVideo ? "Video" : "Image"): \(item.prompt.isEmpty ? item.model : item.prompt)")
    }

    private var skeleton: some View {
        HStack(alignment: .top, spacing: 4) {
            ForEach(0..<columns, id: \.self) { c in
                VStack(spacing: 4) {
                    ForEach(0..<4, id: \.self) { r in
                        RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.surface)
                            .aspectRatio((c + r) % 2 == 0 ? 0.75 : 1.3, contentMode: .fit)
                    }
                }
            }
        }
        .shimmer()
        .padding(.horizontal, 4)
        .accessibilityLabel("Loading your library")
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image(systemName: search.isEmpty ? "sparkles.rectangle.stack" : "magnifyingglass").font(.system(size: 44, weight: .semibold)).foregroundStyle(Color.textTertiary)
            DisplayTitle(search.isEmpty ? "Nothing here yet" : "No matches", size: 28).foregroundStyle(.white)
            Text(search.isEmpty ? "Images and videos you generate — and finished films — show up here." : "Try another word.")
                .font(.subheadline).foregroundStyle(Color.textSecondary).multilineTextAlignment(.center)
            if search.isEmpty, app.config.isOn("create") {
                Button { app.openComposer() } label: { Label("Create something", systemImage: "plus") }.buttonStyle(.ember).padding(.top, 6)
            }
        }
        .padding(32)
        .frame(maxWidth: .infinity, minHeight: 420)
    }

    /// Search applies to films too (by title).
    private var shownFilms: [ProductionSummary] {
        search.isEmpty ? films : films.filter { $0.title.localizedCaseInsensitiveContains(search) }
    }

    @ViewBuilder private var filmsGrid: some View {
        if !films.isEmpty, shownFilms.isEmpty {
            VStack(spacing: 10) {
                Image(systemName: "magnifyingglass").font(.system(size: 40, weight: .semibold)).foregroundStyle(Color.textTertiary)
                DisplayTitle("No matches", size: 28).foregroundStyle(.white)
                Text("No film title contains “\(search)”.").foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 300)
        } else if films.isEmpty {
            VStack(spacing: 14) {
                DisplayTitle("No films yet", size: 28).foregroundStyle(.white)
                Button { app.requestNewFilm = true; app.requestedTab = "films" } label: { Label("New film", systemImage: "plus") }.buttonStyle(.ember)
            }
            .frame(maxWidth: .infinity, minHeight: 360)
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 300), spacing: 12)], spacing: 16) {
                ForEach(shownFilms) { p in
                    Button { openFilm = p.id } label: { FilmCard(p: p) }.buttonStyle(PressScale())
                }
            }
            .padding(.horizontal, 16)
        }
    }

    private var charactersGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150, maximum: 240), spacing: 10)], spacing: 14) {
            ForEach(app.characters) { c in
                Button { openCharacter = c.id } label: { CharacterTile(c: c) }.buttonStyle(PressScale())
            }
        }
        .padding(.horizontal, 16)
    }

    @ViewBuilder private func menu(for item: MediaItem) -> some View {
        Button("Open", systemImage: "arrow.up.left.and.arrow.down.right") { open = item }
        if app.config.isOn("shareMedia") {
            Button("Share…", systemImage: "square.and.arrow.up") {
                export(item) { MediaFiles.share($0) }
            }
            .disabled(exportTask != nil)
        }
        #if os(iOS)
        Button("Save to Files…", systemImage: "folder") {
            export(item) { file in
                exportStatus = "Choose where to save…"
                if try await MediaFiles.saveToFiles(file) { exportMessage = "Saved to Files" }
            }
        }
        .disabled(exportTask != nil)
        if app.config.isOn("saveToPhotos"), item.kind != "audio" {
            Button("Save to Photos", systemImage: "photo.badge.arrow.down") {
                export(item) { file in
                    exportStatus = "Saving to Photos…"
                    try await MediaFiles.saveToPhotos(file, isVideo: item.isVideo)
                    Platform.haptic()
                    exportMessage = "Saved to Photos"
                }
            }
            .disabled(exportTask != nil)
        }
        #endif
        if !item.isVideo, app.config.isOn("create") {
            Button("Animate", systemImage: "play.rectangle") { app.openCreate(startFrame: UploadedAsset(id: item.id, url: item.url, kind: "image")) }
            Button("Use as Reference", systemImage: "photo.on.rectangle") { app.openCreate(startFrame: UploadedAsset(id: item.id, url: item.url, kind: "image"), mode: .image) }
        }
        Button("Copy Prompt", systemImage: "doc.on.doc") { Platform.copy(item.prompt) }
        if app.config.isOn("deleteMedia") {
            Divider()
            Button("Remove from Library", systemImage: "trash", role: .destructive) { pendingDelete = item }
        }
    }

    // MARK: Data

    private func export(_ item: MediaItem, then: @escaping (URL) async throws -> Void) {
        guard exportTask == nil else { return }
        exportStatus = "Downloading…"
        exportTask = Task {
            defer { exportStatus = nil; exportTask = nil }
            do {
                try await MediaFiles.withExportTime {
                    let file: URL
                    if let cached = downloadedFiles[item.url], FileManager.default.fileExists(atPath: cached.path) {
                        file = cached
                    } else {
                        file = try await MediaFiles.download(item.url, app: app) { exportStatus = $0 }
                        downloadedFiles[item.url] = file
                    }
                    try Task.checkCancellation()
                    exportStatus = "Preparing export…"
                    try await then(MediaFiles.named(file, for: item))
                }
            } catch is CancellationError {
                exportMessage = "Download cancelled"
            } catch {
                exportError = error.localizedDescription
                app.report(error, screen: "library", action: "Export")
            }
        }
    }

    private func load() async {
        async let f: [ProductionSummary]? = app.config.isOn("films") ? try? await app.fetchProductions() : nil
        do {
            let list = try await app.fetchMedia()
            withAnimation(.snappy) { state = .loaded(list) }
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.localizedDescription) }
            app.report(error, screen: "library", action: "Load library")
        }
        if let list = await f { films = list }
    }

    private func hide(_ item: MediaItem) async {
        do {
            try await app.client.hideMedia(item.id)
            if case .loaded(var list) = state {
                list.removeAll { $0.id == item.id }
                withAnimation { state = .loaded(list) }
            }
            if open == item { open = nil }
        } catch {
            app.report(error, screen: "library", action: "Remove item")
        }
    }
}

private enum Cell: Identifiable {
    case run(GenerationStore.Run)
    case media(MediaItem)
    var id: String {
        switch self { case .run(let r): "run-\(r.id)"; case .media(let m): m.id }
    }
    /// Width / height.
    var aspect: Double {
        switch self {
        case .run(let r): r.kind == "video" ? 16 / 9 : 1
        case .media(let m): max(0.45, min(m.aspectRatio ?? (m.isVideo ? 16 / 9 : 1), 2.2))
        }
    }
}

/// A generation in flight (shimmer + percent) or one that failed.
private struct RunTile: View {
    let run: GenerationStore.Run
    @Environment(AppModel.self) private var app
    var body: some View {
        Color.clear
            .aspectRatio(run.kind == "video" ? 16 / 9 : 1, contentMode: .fit)
            .background(Color.surface)
            .shimmer(!run.isFinished)
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 3) {
                    if run.isFinished {
                        Label("Failed", systemImage: "exclamationmark.triangle.fill").font(.label(12, weight: .heavy)).foregroundStyle(.red)
                    } else {
                        Text(run.job?.fraction.map { "GENERATING \(Int($0 * 100))%" } ?? "GENERATING").font(.label(12, weight: .heavy)).foregroundStyle(Color.ember)
                    }
                    Text(run.isFinished ? run.statusText : run.title).font(.caption2).foregroundStyle(Color.textSecondary).lineLimit(2)
                }
                .padding(8)
            }
            .overlay(alignment: .topTrailing) {
                Button { run.isFinished ? app.generations.remove(run.id) : app.generations.cancel(run.id, app: app) } label: {
                    Image(systemName: "xmark").font(.system(size: 10, weight: .bold)).foregroundStyle(.white).padding(6).background(.black.opacity(0.5), in: Circle())
                }
                .buttonStyle(.plain).padding(6)
                .accessibilityLabel(run.isFinished ? "Remove" : "Cancel")
            }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .accessibilityElement(children: .contain)
    }
}

struct FilmCard: View {
    let p: ProductionSummary
    var body: some View {
        Color.clear
            .aspectRatio(16 / 9, contentMode: .fit)
            .overlay { PreviewMediaView(preview: p.cover.map { MediaPreview(url: $0, kind: "image") }, seed: p.id, symbol: "film.stack") }
            .bottomScrim(0.9, height: 0.6)
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    HStack(spacing: 6) {
                        MediaBadge(text: p.status.label, ember: p.status == .done)
                        if p.shots > 0 {
                            // A finished film that skipped shots: say what's in the cut, not an "incomplete" fraction.
                            Text(p.status == .done && p.done < p.shots ? "\(p.done) of \(p.shots) shots used" : "\(p.done)/\(p.shots) shots")
                                .font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.8)).monospacedDigit()
                        }
                    }
                    DisplayTitle(p.title, size: 26).foregroundStyle(.white)
                    if p.shots > 0, p.done < p.shots, p.status.isLive {
                        ProgressView(value: Double(p.done), total: Double(p.shots)).tint(.ember).frame(maxWidth: 220)
                    }
                }
                .padding(14)
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.hairline))
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .accessibilityElement(children: .combine)
    }
}

struct CharacterTile: View {
    let c: StudioCharacter
    var body: some View {
        Color.clear
            .aspectRatio(3 / 4, contentMode: .fit)
            .overlay { PreviewMediaView(preview: c.coverImageURL.map { MediaPreview(url: $0, kind: "image") }, seed: c.id, symbol: "person.fill") }
            .bottomScrim(0.85, height: 0.5)
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 2) {
                    DisplayTitle(c.name, size: 24, lineLimit: 1).foregroundStyle(.white)
                    Text(c.isProcessing ? "Processing…" : "\(c.refs.count) reference\(c.refs.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.white.opacity(0.75))
                }
                .padding(12)
            }
            .overlay(alignment: .topTrailing) {
                if c.sheet?.approved == true { MediaBadge(text: "Soul ID", ember: true).padding(8) }
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.hairline))
            .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .accessibilityElement(children: .combine)
    }
}
