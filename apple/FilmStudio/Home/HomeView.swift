import SwiftUI
import FilmStudioKit

/// Home: a vertically scrolling, media-first feed. Sections, order, featured items, previews and copy all come
/// from the engine (GET /feed, or built from the catalog/tools/characters/library on older engines).
struct HomeView: View {
    enum Route: Hashable {
        case tool(Tool, prefill: [String: JSONValue])
        case allTools
        case character(String)
        case characters
        case media(MediaItem)
        case films
    }

    @Environment(AppModel.self) private var app
    @Environment(\.heroNamespace) private var ns
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var route: Route?
    @State private var loading = false

    var body: some View {
        ScreenGate(id: "explore", title: "Home") {
            ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 34) {
                    header.id("top")
                    if let feed = app.feed, !feed.isEmpty {
                        ForEach(feed.sections) { section($0) }
                    } else if loading || app.feed == nil {
                        skeleton
                    } else {
                        ContentUnavailableView("Nothing to show yet", systemImage: "sparkles", description: Text("Connect a provider on the studio server and pull to refresh."))
                    }
                }
                .padding(.bottom, 24)
                .frame(maxWidth: 1500)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: app.scrollToTopTick["explore"]) { _, _ in withAnimation(.snappy) { proxy.scrollTo("top", anchor: .top) } }
            }
            .studioCanvas()
            #if os(iOS)
            .toolbar(.hidden, for: .navigationBar)
            #endif
            .navigationTitle("Home")
            .navigationDestination(for: Route.self) { destination($0) }
            .navigationDestination(item: $route) { destination($0) }
            .refreshable { await reload() }
            .task(id: app.refreshTick) { await reload() }
        }
    }

    private func reload() async {
        loading = true
        await app.loadFeed()
        loading = false
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            Image("BrandMark").resizable().frame(width: 30, height: 30).accessibilityHidden(true)
            Text("FILM STUDIO").font(.display(26)).tracking(0.2).foregroundStyle(.white)
            Spacer()
            if app.config.isOn("create"), sizeClass == .regular || Platform.isMac {
                Button { app.openComposer() } label: { Label("Create", systemImage: "sparkle") }
                    .buttonStyle(.lime(.small))
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .accessibilityElement(children: .contain)
    }

    // MARK: Sections

    @ViewBuilder private func section(_ s: FeedSection) -> some View {
        switch s.style {
        case .hero: HeroCarousel(section: s, open: open)
        case .grid: PortraitGrid(section: s, open: open, more: s.more.map { m in { act(m, item: nil) } })
        case .chips: ChipCloud(section: s, open: open)
        default: Shelf(section: s, open: open, more: s.more.map { m in { act(m, item: nil) } })
        }
    }

    private var skeleton: some View {
        VStack(alignment: .leading, spacing: 30) {
            RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color.surface)
                .aspectRatio(1.6, contentMode: .fit).shimmer().padding(.horizontal, 16)
            ForEach(0..<2, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 4).fill(Color.surface).frame(width: 160, height: 22).padding(.horizontal, 16)
                    HStack(spacing: 10) {
                        ForEach(0..<3, id: \.self) { _ in RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.surface).frame(width: 150, height: 200) }
                    }
                    .shimmer()
                    .padding(.leading, 16)
                }
            }
        }
        .accessibilityLabel("Loading")
    }

    // MARK: Actions

    private func open(_ item: FeedItem) {
        Platform.selection()
        act(item.action, item: item)
    }

    private func act(_ a: FeedAction, item: FeedItem?) {
        // Only tabs this window can actually switch to (on iPhone Films and Tools aren't in the bar): push otherwise.
        let tabs = app.reachableTabs.isEmpty ? Set(app.config.visibleTabs.map(\.id)) : app.reachableTabs
        switch a.type {
        case "create", "model":
            app.openComposer(ComposerRequest(
                mode: a.param("mode").flatMap(ComposerRequest.Mode.init(rawValue:)), model: a.model, prompt: a.param("prompt"), params: a.params,
                title: item?.kind == "model" ? nil : item?.title, subtitle: item?.kind == "model" ? nil : item?.subtitle,
                preview: item?.preview, sourceID: item?.id))
        case "preset" where a.toolId == nil:
            app.openComposer(ComposerRequest(model: a.model, prompt: a.param("prompt"), params: a.params, title: item?.title, subtitle: item?.subtitle, preview: item?.preview, sourceID: item?.id))
        case "tool", "preset":
            Task { await openTool(a) }
        case "tools": if tabs.contains("tools") { app.requestedTab = "tools" } else { route = .allTools }
        case "films":
            if a.flag("new") { app.requestNewFilm = true } // FilmsView opens the brief as soon as it appears
            if tabs.contains("films") { app.requestedTab = "films" } else { route = .films }
        case "characters", "character":
            if let id = a.param("id") { route = .character(id); break }
            if a.flag("new") { app.requestNewCharacter = true }
            if tabs.contains("characters") { app.requestedTab = "characters" } else { route = .characters }
        case "library", "media":
            if let id = a.param("assetId") ?? a.param("id") { Task { await openMedia(id) } }
            else if tabs.contains("library") { app.requestedTab = "library" }
        case "web": app.webSheet = .init(path: a.param("path") ?? "/", title: item?.title ?? "")
        case "tab": if let t = a.param("tab"), tabs.contains(t) { app.requestedTab = t }
        default:
            if a.model != nil { app.openComposer(ComposerRequest(model: a.model, params: a.params, sourceID: item?.id)) }
        }
    }

    /// Recent tiles open the item itself (the library list is fetched if Home came from the server feed).
    private func openMedia(_ id: String) async {
        if let m = app.recentMedia.first(where: { $0.id == id }) { route = .media(m); return }
        if let list = try? await app.fetchMedia(), let m = list.first(where: { $0.id == id }) { route = .media(m); return }
        if app.reachableTabs.contains("library") { app.requestedTab = "library" }
    }

    private func openTool(_ a: FeedAction) async {
        if app.tools.isEmpty { await app.loadTools() }
        guard let id = a.toolId, let tool = app.tools.first(where: { $0.id == id }) else { route = .allTools; return }
        var prefill = a.params
        // A preset preselects whichever select input offers it.
        if let preset = a.presetId, let input = tool.inputs.first(where: { $0.kind == .select && $0.options.contains { $0.value == preset } }) {
            prefill[input.key] = .string(preset)
        }
        route = .tool(tool, prefill: prefill)
    }

    @ViewBuilder private func destination(_ r: Route) -> some View {
        switch r {
        case .tool(let t, let prefill): ToolRunView(tool: t, prefill: prefill)
        case .allTools: ToolsView()
        case .character(let id): CharacterDetailView(id: id)
        case .characters: CharactersView()
        case .media(let item): MediaViewer(item: item).zoomTransition("media:\(item.id)", in: ns) // = the feed tile's id
        case .films: FilmsView()
        }
    }
}

// MARK: - Hero

private struct HeroCarousel: View {
    let section: FeedSection
    let open: (FeedItem) -> Void
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.heroNamespace) private var ns
    @State private var current: String?
    /// Two cards side by side on iPad and in iPhone landscape, so a hero never fills the whole screen (QA-14).
    private var perPage: Int { sizeClass == .regular || verticalSizeClass == .compact ? 2 : 1 }

    var body: some View {
        VStack(spacing: 12) {
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(section.items) { item in
                        Button { open(item) } label: { HeroCard(item: item) }
                            .buttonStyle(PressScale())
                            .containerRelativeFrame(.horizontal, count: perPage, spacing: 12)
                            .zoomSource(item.id, in: ns)
                            .id(item.id)
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $current)
            if section.items.count > 1 {
                HStack(spacing: 6) {
                    ForEach(section.items) { item in
                        Capsule().fill(item.id == (current ?? section.items.first?.id) ? Color.lime : Color.white.opacity(0.25))
                            .frame(width: item.id == (current ?? section.items.first?.id) ? 18 : 6, height: 6)
                    }
                }
                .animation(.spring(response: 0.3, dampingFraction: 0.8), value: current)
                .accessibilityHidden(true)
            }
        }
    }
}

private struct HeroCard: View {
    let item: FeedItem
    var body: some View {
        Color.clear
            .aspectRatio(max(1.2, min(item.aspect ?? 1.6, 2.2)), contentMode: .fit)
            .overlay { PreviewMediaView(preview: item.preview, seed: item.id, symbol: item.sfSymbol, maxPixelSize: 1400) }
            .bottomScrim(0.9, height: 0.65)
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 6) {
                    if let badge = item.badge { MediaBadge(text: badge) }
                    DisplayTitle(item.title, size: 38).foregroundStyle(.white)
                    HStack(alignment: .bottom, spacing: 12) {
                        if !item.subtitle.isEmpty {
                            Text(item.subtitle).font(.subheadline).foregroundStyle(.white.opacity(0.78)).lineLimit(2).multilineTextAlignment(.leading)
                        }
                        Spacer(minLength: 0)
                        Text("TRY")
                            .font(.label(13, weight: .heavy))
                            .foregroundStyle(Color.onLime)
                            .padding(.horizontal, 14).padding(.vertical, 8)
                            .background(Color.lime, in: Capsule())
                    }
                }
                .padding(18)
            }
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.hairline))
            .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([item.title, item.subtitle].filter { !$0.isEmpty }.joined(separator: ". "))
            .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Shelf

private struct Shelf: View {
    let section: FeedSection
    let open: (FeedItem) -> Void
    var more: (() -> Void)?
    @Environment(\.heroNamespace) private var ns

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StudioSectionHeader(title: section.title, subtitle: section.subtitle, action: more)
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 10) {
                    ForEach(section.items) { item in
                        Button { open(item) } label: { ShelfTile(item: item) }
                            .buttonStyle(PressScale())
                            .zoomSource(item.id, in: ns)
                    }
                }
                .scrollTargetLayout()
            }
            .contentMargins(.horizontal, 16, for: .scrollContent)
            .scrollTargetBehavior(.viewAligned)
        }
    }
}

private struct ShelfTile: View {
    let item: FeedItem
    private let height: CGFloat = Platform.isMac || Platform.isPad ? 230 : 196
    private var width: CGFloat { max(124, min(height * (item.aspect ?? 0.8), 330)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            PreviewMediaView(preview: item.preview, seed: item.id, symbol: item.sfSymbol, maxPixelSize: 700)
                .frame(width: width, height: height)
                .overlay(alignment: .topLeading) { if let b = item.badge { MediaBadge(text: b).padding(8) } }
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.hairline))
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title.uppercased()).font(.display(17, weight: .heavy)).foregroundStyle(.white).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !item.subtitle.isEmpty {
                    Text(item.subtitle).font(.caption).foregroundStyle(Color.textSecondary).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .frame(width: width, alignment: .leading)
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge) // captions under a fixed-width tile can't grow forever
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([item.title, item.subtitle].filter { !$0.isEmpty }.joined(separator: ". "))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Portrait grid (effects / presets)

private struct PortraitGrid: View {
    let section: FeedSection
    let open: (FeedItem) -> Void
    var more: (() -> Void)?
    @State private var expanded = false
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.heroNamespace) private var ns

    var body: some View {
        let limit = sizeClass == .regular ? 12 : 9
        let shown = expanded ? section.items : Array(section.items.prefix(limit))
        VStack(alignment: .leading, spacing: 12) {
            StudioSectionHeader(title: section.title, subtitle: section.subtitle, action: more)
            if Set(shown.map { $0.aspect ?? 9 / 16 }).count > 1 {
                masonry(shown)
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: sizeClass == .regular ? 150 : 104), spacing: 8)], spacing: 8) {
                    ForEach(shown) { tile($0) }
                }
                .padding(.horizontal, 16)
            }
            if section.items.count > limit {
                Button(expanded ? "Show less" : "Show all \(section.items.count)") { withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { expanded.toggle() } }
                    .buttonStyle(.darkPill)
                    .frame(maxWidth: .infinity)
            }
        }
    }

    /// Mixed aspect ratios (Recent): greedy masonry columns, so 9:16 clips don't leave black gaps (QA-11).
    private func masonry(_ items: [FeedItem]) -> some View {
        let cols = sizeClass == .regular ? 4 : 2
        var heights = Array(repeating: 0.0, count: cols)
        var buckets = Array(repeating: [FeedItem](), count: cols)
        for item in items {
            let i = heights.indices.min { heights[$0] < heights[$1] } ?? 0
            buckets[i].append(item)
            heights[i] += 1 / max(0.3, item.aspect ?? 9 / 16)
        }
        return HStack(alignment: .top, spacing: 8) {
            ForEach(0..<cols, id: \.self) { c in
                VStack(spacing: 8) { ForEach(buckets[c]) { tile($0) } }
            }
        }
        .padding(.horizontal, 16)
    }

    private func tile(_ item: FeedItem) -> some View {
        Button { open(item) } label: {
            Color.clear
                .aspectRatio(item.aspect ?? 9 / 16, contentMode: .fit)
                .overlay { PreviewMediaView(preview: item.preview, seed: item.id, symbol: item.sfSymbol, maxPixelSize: 600) }
                .bottomScrim(0.85, height: 0.5)
                .overlay(alignment: .bottomLeading) {
                    Text(item.title.uppercased()).font(.display(16, weight: .heavy)).foregroundStyle(.white).lineLimit(2).padding(10)
                }
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(item.title)
                .accessibilityAddTraits(.isButton)
        }
        .buttonStyle(PressScale())
        .zoomSource(item.id, in: ns)
    }
}

// MARK: - Chip cloud

private struct ChipCloud: View {
    let section: FeedSection
    let open: (FeedItem) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StudioSectionHeader(title: section.title, subtitle: section.subtitle)
            FlowLayout(spacing: 8) {
                ForEach(section.items) { item in
                    Button { open(item) } label: { StudioChip(title: item.title, systemImage: item.sfSymbol) }
                        .buttonStyle(PressScale())
                }
            }
            .padding(.horizontal, 16)
        }
    }
}

/// Wrapping row layout for chips.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += line + spacing; line = 0 }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            line = max(line, s.height)
        }
        return CGSize(width: min(maxX, width), height: y + line)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, line: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += line + spacing; line = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            line = max(line, s.height)
        }
    }
}

/// Subtle spring press for media tiles.
struct PressScale: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .opacity(configuration.isPressed ? 0.9 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.7), value: configuration.isPressed)
    }
}
