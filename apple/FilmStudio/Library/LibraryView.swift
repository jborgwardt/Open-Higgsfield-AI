import SwiftUI
import FilmStudioKit

struct LibraryView: View {
    enum Filter: String, CaseIterable, Identifiable {
        case all = "All", images = "Images", videos = "Videos"
        var id: String { rawValue }
    }

    @Environment(AppModel.self) private var app
    @State private var state: Loadable<[MediaItem]> = .loading
    @State private var filter: Filter = .all
    @State private var search = ""
    @State private var open: MediaItem?
    @State private var pendingDelete: MediaItem?

    private var items: [MediaItem] {
        let all = state.value ?? []
        return all.filter { item in
            (filter == .all || (filter == .videos) == item.isVideo)
                && (search.isEmpty || item.prompt.localizedCaseInsensitiveContains(search) || item.model.localizedCaseInsensitiveContains(search))
        }
    }

    var body: some View {
        Group {
            switch state {
            case .loading: LoadingView(text: "Loading your library…")
            case .failed(let m): ErrorStateView(message: m) { await load() }
            case .unavailable: EmptyView()
            case .loaded:
                if items.isEmpty { empty } else { grid }
            }
        }
        .navigationTitle("Library")
        .searchable(text: $search, prompt: "Search prompts and models")
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("Show", selection: $filter) {
                    ForEach(Filter.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
            }
            ToolbarItem(placement: .trailing) {
                Menu {
                    Button("Refresh", systemImage: "arrow.clockwise") { Task { await load() } }
                    OpenOnWebButton(path: app.config.presentation(for: "library").path ?? "/", title: "Library")
                } label: { Label("More", systemImage: "ellipsis.circle") }
            }
        }
        .refreshable { await load() }
        .task(id: app.refreshTick) { await load() }
        .onChange(of: app.generations.lastFinished) { _, run in
            if run?.succeeded == true { Task { await load() } }
        }
        .navigationDestination(item: $open) { item in
            MediaViewer(item: item, onDelete: { await hide(item) })
        }
        .confirmationDialog("Remove from the library?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), titleVisibility: .visible, presenting: pendingDelete) { item in
            Button("Remove", role: .destructive) { Task { await hide(item) } }
        } message: { _ in Text("The file stays on the studio server; it's only hidden from the library.") }
    }

    private var empty: some View {
        ContentUnavailableView {
            Label(search.isEmpty ? "Nothing here yet" : "No matches", systemImage: search.isEmpty ? "photo.on.rectangle.angled" : "magnifyingglass")
        } description: {
            Text(search.isEmpty ? "Images and videos you generate — and finished films — show up here." : "Try another word.")
        } actions: {
            if search.isEmpty, app.config.isOn("create") {
                Button("Create Something") { app.requestedTab = "explore" }.buttonStyle(.borderedProminent)
            }
        }
    }

    private var grid: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Platform.isMac ? 180 : 112, maximum: 320), spacing: 3)], spacing: 3) {
                ForEach(items) { item in
                    Button { open = item } label: { MediaTile(item: item) }
                        .buttonStyle(.plain)
                        .contextMenu { menu(for: item) } preview: {
                            AuthedImage(url: item.previewURL, maxPixelSize: 900, contentMode: .fit).frame(minWidth: 280, minHeight: 200)
                        }
                        .accessibilityLabel("\(item.isVideo ? "Video" : "Image"): \(item.prompt.isEmpty ? item.model : item.prompt)")
                }
            }
            .padding(.horizontal, Platform.isMac ? 12 : 0)
            Text("\(items.count) item\(items.count == 1 ? "" : "s")").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 16)
        }
    }

    @ViewBuilder private func menu(for item: MediaItem) -> some View {
        Button("Open", systemImage: "arrow.up.left.and.arrow.down.right") { open = item }
        if app.config.isOn("shareMedia") {
            Button("Share…", systemImage: "square.and.arrow.up") {
                Task { if let f = try? await MediaFiles.download(item.url, app: app) { MediaFiles.share(f) } }
            }
        }
        #if os(iOS)
        if app.config.isOn("saveToPhotos") {
            Button("Save to Photos", systemImage: "photo.badge.arrow.down") {
                Task { if let f = try? await MediaFiles.download(item.url, app: app) { try? await MediaFiles.saveToPhotos(f, isVideo: item.isVideo); Platform.haptic() } }
            }
        }
        #endif
        if !item.isVideo, app.config.isOn("create") {
            Button("Animate in Create", systemImage: "wand.and.stars") {
                app.openCreate(startFrame: UploadedAsset(id: item.id, url: item.url, kind: "image"))
            }
        }
        Button("Copy Prompt", systemImage: "doc.on.doc") { Platform.copy(item.prompt) }
        if app.config.isOn("deleteMedia") {
            Divider()
            Button("Remove from Library", systemImage: "trash", role: .destructive) { pendingDelete = item }
        }
    }

    private func load() async {
        do {
            let list = try await app.client.media()
            state = .loaded(list)
        } catch is CancellationError {
        } catch {
            if state.value == nil { state = .failed(error.localizedDescription) }
            app.report(error, screen: "library", action: "Load library")
        }
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

struct MediaTile: View {
    let item: MediaItem
    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay { AuthedImage(url: item.previewURL, maxPixelSize: 480) }
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if item.isVideo {
                    Image(systemName: "play.fill")
                        .font(.caption2.weight(.bold))
                        .padding(5)
                        .background(.black.opacity(0.55), in: Circle())
                        .foregroundStyle(.white)
                        .padding(6)
                }
            }
            .contentShape(Rectangle())
    }
}
