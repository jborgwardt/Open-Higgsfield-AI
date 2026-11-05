import SwiftUI
import FilmStudioKit

/// Home: one-tap create cards, then server-ordered sections (tools, characters, models, recent, films).
struct ExploreView: View {
    enum Route: Hashable {
        case create(mode: String, model: String?)
        case tool(Tool)
        case allTools
        case character(String)
        case media(MediaItem)
        case films
    }

    @Environment(AppModel.self) private var app
    @State private var tools: [Tool] = []
    @State private var recent: [MediaItem] = []
    @State private var route: Route?

    private var explore: AppConfig.Explore { app.config.explore }

    var body: some View {
        ScreenGate(id: "explore", title: "Explore") {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 30) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(explore.title).font(.largeTitle.weight(.bold))
                        if !explore.subtitle.isEmpty { Text(explore.subtitle).font(.subheadline).foregroundStyle(.secondary) }
                    }
                    .padding(.horizontal)
                    ForEach(explore.sections, id: \.self) { section($0) }
                }
                .padding(.vertical)
                .frame(maxWidth: 1400)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle("Explore")
            .inlineTitle()
            .navigationDestination(for: Route.self) { destination($0) }
            .navigationDestination(item: $route) { destination($0) }
            .refreshable { await load() }
            .task(id: app.refreshTick) { await load() }
            .onChange(of: app.pendingStartFrame, initial: true) { _, asset in
                // "Animate in Create" from the library, when Create isn't its own tab.
                if asset != nil, !app.config.visibleTabs.contains(where: { $0.id == "create" }) { route = .create(mode: "video", model: nil) }
            }
        }
    }

    // MARK: Sections

    @ViewBuilder private func section(_ id: String) -> some View {
        switch id {
        case "create" where app.config.isOn("create"): createCards
        case "tools" where app.config.isOn("tools"): toolsSection
        case "characters" where app.config.isOn("characters"): charactersSection
        case "models" where app.config.isOn("create"): modelsSection
        case "recent": recentSection
        case "films" where app.config.isOn("films"): filmsCard
        default: EmptyView()
        }
    }

    private var createCards: some View {
        let cards = explore.cards.filter { c in c.tool.map { t in tools.contains { $0.id == t } } ?? true }
        return LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), spacing: 12)], spacing: 12) {
            ForEach(cards) { card in
                NavigationLink(value: card.tool.flatMap { t in tools.first { $0.id == t } }.map(Route.tool) ?? .create(mode: card.mode ?? "image", model: card.model)) {
                    FeatureCard(seed: card.id, symbol: card.sfSymbol, title: card.title, subtitle: card.subtitle)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal)
    }

    @ViewBuilder private var toolsSection: some View {
        if !tools.isEmpty {
            ForEach(Tool.grouped(tools), id: \.category) { group in
                VStack(alignment: .leading, spacing: 10) {
                    SectionHeader(title: group.category, link: group.category == Tool.grouped(tools).first?.category ? ("All Tools", Route.allTools) : nil)
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(alignment: .top, spacing: 12) {
                            ForEach(group.tools) { t in
                                NavigationLink(value: Route.tool(t)) { ToolTile(tool: t) }.buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal)
                    }
                }
            }
        }
    }

    @ViewBuilder private var charactersSection: some View {
        if app.charactersAvailable == true {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Characters", tab: "characters")
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 14) {
                        Button { app.requestedTab = "characters" } label: {
                            VStack(spacing: 6) {
                                Circle().fill(Color.tileBackground).frame(width: 72, height: 72)
                                    .overlay(Image(systemName: "plus").font(.title2).foregroundStyle(Color.accentColor))
                                Text("Add").font(.caption)
                            }
                        }
                        .buttonStyle(.plain)
                        ForEach(app.characters) { c in
                            NavigationLink(value: Route.character(c.id)) {
                                VStack(spacing: 6) {
                                    AuthedImage(url: c.coverImageURL, maxPixelSize: 240).frame(width: 72, height: 72).clipShape(Circle())
                                    Text(c.name).font(.caption).lineLimit(1).frame(width: 80)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
    }

    @ViewBuilder private var modelsSection: some View {
        let video = app.catalog?.groups(kind: "video", hiddenProviders: app.hiddenProviders).flatMap(\.models) ?? []
        let image = app.catalog?.groups(kind: "image", hiddenProviders: app.hiddenProviders).flatMap(\.models) ?? []
        if !(video + image).isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Models")
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 12) {
                        ForEach(video + image) { m in
                            NavigationLink(value: Route.create(mode: m.kind, model: m.id)) {
                                ModelTile(model: m, provider: app.catalog?.providerLabel(m.provider) ?? m.provider)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
    }

    @ViewBuilder private var recentSection: some View {
        if !recent.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionHeader(title: "Recent", tab: "library")
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 6) {
                        ForEach(recent) { item in
                            NavigationLink(value: Route.media(item)) { MediaTile(item: item).frame(width: 120, height: 120).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous)) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }
            }
        }
    }

    private var filmsCard: some View {
        Button {
            if app.config.visibleTabs.contains(where: { $0.id == "films" }) { app.requestedTab = "films" } else { route = .films }
        } label: {
            FeatureCard(seed: "films", symbol: "film.stack", title: "Make a Film", subtitle: "Paste a script; every shot is planned, rendered and cut together on the server.", wide: true)
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
    }

    @ViewBuilder private func destination(_ r: Route) -> some View {
        switch r {
        case .create(let mode, let model): CreateView(initialMode: mode == "image" ? .image : .video, initialModel: model)
        case .tool(let t): ToolRunView(tool: t)
        case .allTools: ToolsView()
        case .character(let id): CharacterDetailView(id: id)
        case .media(let item): MediaViewer(item: item)
        case .films: FilmsView()
        }
    }

    private func load() async {
        async let t: [Tool]? = app.config.isOn("tools") ? try? await app.client.tools() : nil
        async let m: [MediaItem]? = try? await app.client.media()
        if app.catalog == nil { await app.reloadCatalog() }
        if app.charactersAvailable == nil { await app.loadCharacters() }
        tools = await t ?? []
        recent = Array((await m ?? []).prefix(12))
    }
}

private struct SectionHeader: View {
    let title: String
    var link: (String, ExploreView.Route)?
    var tab: String?
    @Environment(AppModel.self) private var app
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(.title3.weight(.semibold))
            Spacer()
            if let link {
                NavigationLink(link.0, value: link.1).font(.subheadline)
            } else if let tab, app.config.visibleTabs.contains(where: { $0.id == tab }) {
                Button("See All") { app.requestedTab = tab }.font(.subheadline).buttonStyle(.borderless)
            }
        }
        .padding(.horizontal)
    }
}

/// A deterministic gradient per id, so placeholder art is stable and varied.
struct SeededGradient: View {
    let seed: String
    var body: some View {
        let h = Double(seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % 360) / 360
        LinearGradient(colors: [Color(hue: h, saturation: 0.65, brightness: 0.55), Color(hue: (h + 0.12).truncatingRemainder(dividingBy: 1), saturation: 0.75, brightness: 0.3)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

private struct FeatureCard: View {
    let seed: String
    let symbol: String
    let title: String
    let subtitle: String
    var wide = false
    var body: some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: symbol).font(.title.weight(.semibold)).padding(.bottom, 6)
                Text(title).font(.title3.weight(.bold))
                if !subtitle.isEmpty { Text(subtitle).font(.caption).opacity(0.85).lineLimit(2).multilineTextAlignment(.leading) }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.right.circle.fill").font(.title2).opacity(0.9)
        }
        .foregroundStyle(.white)
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: wide ? 110 : 132, alignment: .bottomLeading)
        .background(SeededGradient(seed: seed))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

private struct ToolTile: View {
    let tool: Tool
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ZStack {
                if let t = tool.thumbnail {
                    AuthedImage(url: t, maxPixelSize: 480)
                } else {
                    SeededGradient(seed: tool.id)
                    Image(systemName: tool.sfSymbol).font(.system(size: 34, weight: .semibold)).foregroundStyle(.white.opacity(0.92))
                }
            }
            .frame(width: 150, height: 188)
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text(tool.title).font(.subheadline.weight(.semibold)).lineLimit(1)
            Text(tool.description).font(.caption).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
        }
        .frame(width: 150)
        .contentShape(Rectangle())
    }
}

private struct ModelTile: View {
    let model: ModelInfo
    let provider: String
    var body: some View {
        ZStack(alignment: .bottomLeading) {
            if let t = model.thumbnail { AuthedImage(url: t, maxPixelSize: 480) } else { SeededGradient(seed: model.id) }
            LinearGradient(colors: [.clear, .black.opacity(0.55)], startPoint: .center, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 2) {
                Label(model.isVideo ? "Video" : "Image", systemImage: model.isVideo ? "film" : "photo").font(.caption2.weight(.semibold)).opacity(0.85)
                Text(model.label).font(.subheadline.weight(.bold)).lineLimit(2)
                Text(provider).font(.caption2).opacity(0.8).lineLimit(1)
            }
            .foregroundStyle(.white)
            .padding(10)
        }
        .frame(width: 190, height: 120)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
    }
}
