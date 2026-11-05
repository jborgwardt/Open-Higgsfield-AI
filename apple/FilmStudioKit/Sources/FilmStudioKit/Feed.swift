import Foundation

// The Higgsfield-style home feed (GET /feed). Everything on Home — section order, titles, featured items,
// preview media and copy — comes from the engine. When the route is missing (older engines) the app builds
// the same shape from /catalog + /tools + /characters + /media with `FeedBuilder`.

// MARK: - Preview media

/// Example media for a model, tool, preset or feed item: a muted looping clip and/or a still.
public struct MediaPreview: Sendable, Hashable {
    public var url: String?
    public var poster: String?
    public var kind: String? // "video" | "image"

    public init(url: String? = nil, poster: String? = nil, kind: String? = nil) {
        self.url = url?.nonEmpty; self.poster = poster?.nonEmpty; self.kind = kind?.nonEmpty
    }

    /// Reads `previewUrl` / `previewPoster` / `previewKind`, or a nested `preview: { url, poster, kind }`.
    init?(_ c: KeyedDecodingContainer<AnyKey>, fallbackStill: String? = nil) {
        let nested = c.json("preview")
        let url = c.string("previewUrl") ?? nested?["url"]?.string ?? (nested?.string)
        let poster = c.string("previewPoster") ?? nested?["poster"]?.string
        let kind = c.string("previewKind") ?? nested?["kind"]?.string
        let p = MediaPreview(url: url, poster: poster ?? (url == nil ? fallbackStill : nil), kind: kind)
        if p.isEmpty { return nil }
        self = p
    }

    public var isEmpty: Bool { url == nil && poster == nil }

    public var isVideo: Bool {
        if let kind { return kind.hasPrefix("video") }
        guard let u = url?.lowercased() else { return false }
        return [".mp4", ".mov", ".m4v", ".webm", ".m3u8"].contains { u.hasSuffix($0) || u.contains("\($0)?") }
    }

    /// The still to show first (the poster for clips, the image itself otherwise).
    public var still: String? { poster ?? (isVideo ? nil : url) }
    /// The clip to loop, if any.
    public var video: String? { isVideo ? url : nil }
}

// MARK: - Feed

public struct FeedStyle: OpenEnum {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let hero = FeedStyle(rawValue: "hero")
    public static let shelf = FeedStyle(rawValue: "shelf")
    public static let grid = FeedStyle(rawValue: "grid")
    public static let chips = FeedStyle(rawValue: "chips")
}

/// What tapping a feed item does.
public struct FeedAction: Sendable, Hashable, Encodable {
    /// create | tool | preset | films | characters | character | library | media | tools | web | tab
    public var type: String
    public var model: String?
    public var toolId: String?
    public var presetId: String?
    public var params: [String: JSONValue]

    public init(type: String, model: String? = nil, toolId: String? = nil, presetId: String? = nil, params: [String: JSONValue] = [:]) {
        self.type = type; self.model = model; self.toolId = toolId; self.presetId = presetId; self.params = params
    }

    init(_ v: JSONValue?) {
        type = v?["type"]?.string ?? (v?["toolId"] != nil ? "tool" : v?["model"] != nil ? "create" : "none")
        model = v?["model"]?.string
        toolId = v?["toolId"]?.string ?? v?["tool"]?.string
        presetId = v?["presetId"]?.string ?? v?["preset"]?.string
        params = v?["params"]?.object ?? [:]
    }

    public func param(_ key: String) -> String? { params[key]?.string?.nonEmpty }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(type, forKey: "type")
        try c.encodeIfPresent(model, forKey: "model")
        try c.encodeIfPresent(toolId, forKey: "toolId")
        try c.encodeIfPresent(presetId, forKey: "presetId")
        if !params.isEmpty { try c.encode(params, forKey: "params") }
    }
}

public struct FeedItem: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var kind: String // model | tool | preset | studio | character | media | feature | film
    public var title: String
    public var subtitle: String
    public var badge: String?
    public var preview: MediaPreview?
    /// Width / height of the preview ("16:9", "9:16" or a number); nil = the section's default.
    public var aspect: Double?
    public var action: FeedAction
    public var sfSymbol: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") ?? c.string("title") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "feed item without id"))
        }
        self.id = id
        kind = c.string("kind", default: "feature")
        title = c.string("title") ?? c.string("label") ?? id
        subtitle = c.string("subtitle") ?? c.string("blurb") ?? c.string("description") ?? ""
        badge = c.string("badge")
        preview = MediaPreview(c, fallbackStill: c.string("thumbnail") ?? c.string("image"))
        aspect = FeedItem.parseAspect(c.json("aspect"))
        action = FeedAction(c.json("action"))
        sfSymbol = c.string("sfSymbol")
    }

    public init(id: String, kind: String, title: String, subtitle: String = "", badge: String? = nil, preview: MediaPreview? = nil, aspect: Double? = nil, action: FeedAction, sfSymbol: String? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.subtitle = subtitle; self.badge = badge
        self.preview = preview; self.aspect = aspect; self.action = action; self.sfSymbol = sfSymbol
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(id, forKey: "id")
        try c.encode(kind, forKey: "kind")
        try c.encode(title, forKey: "title")
        try c.encode(subtitle, forKey: "subtitle")
        try c.encodeIfPresent(badge, forKey: "badge")
        try c.encodeIfPresent(preview?.url, forKey: "previewUrl")
        try c.encodeIfPresent(preview?.poster, forKey: "previewPoster")
        try c.encodeIfPresent(preview?.kind, forKey: "previewKind")
        try c.encodeIfPresent(aspect, forKey: "aspect")
        try c.encode(action, forKey: "action")
        try c.encodeIfPresent(sfSymbol, forKey: "sfSymbol")
    }

    /// "16:9" → 1.777…, "9:16" → 0.5625, 1.5 → 1.5.
    public static func parseAspect(_ v: JSONValue?) -> Double? {
        guard let v else { return nil }
        if case .number(let n) = v { return n > 0 ? n : nil }
        guard let s = v.string else { return nil }
        let parts = s.split(whereSeparator: { $0 == ":" || $0 == "x" || $0 == "×" || $0 == "/" }).compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if parts.count == 2, parts[1] > 0 { return parts[0] / parts[1] }
        return Double(s).flatMap { $0 > 0 ? $0 : nil }
    }
}

public struct FeedSection: Codable, Sendable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var subtitle: String
    public var style: FeedStyle
    public var items: [FeedItem]
    /// Optional "See all" target.
    public var more: FeedAction?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") ?? c.string("title") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "section without id"))
        }
        self.id = id
        title = c.string("title", default: "")
        subtitle = c.string("subtitle", default: "")
        style = FeedStyle(rawValue: c.string("style", default: "shelf"))
        items = c.list("items")
        more = c.json("more").map { FeedAction($0) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(id, forKey: "id")
        try c.encode(title, forKey: "title")
        if !subtitle.isEmpty { try c.encode(subtitle, forKey: "subtitle") }
        try c.encode(style, forKey: "style")
        try c.encode(items, forKey: "items")
        try c.encodeIfPresent(more, forKey: "more")
    }

    public init(id: String, title: String, subtitle: String = "", style: FeedStyle, items: [FeedItem], more: FeedAction? = nil) {
        self.id = id; self.title = title; self.subtitle = subtitle; self.style = style; self.items = items; self.more = more
    }
}

public struct Feed: Codable, Sendable, Hashable {
    public var sections: [FeedSection]
    public init(from decoder: Decoder) throws {
        // Accept { sections: [...] } or a bare array of sections.
        if let c = try? decoder.container(keyedBy: AnyKey.self) {
            sections = c.list("sections")
        } else {
            sections = ((try? [Lossy<FeedSection>](from: decoder)) ?? []).compactMap(\.value)
        }
        sections.removeAll { $0.items.isEmpty }
    }
    public init(sections: [FeedSection]) { self.sections = sections.filter { !$0.items.isEmpty } }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(sections, forKey: "sections")
    }
    public var isEmpty: Bool { sections.isEmpty }
}

// MARK: - Client-side fallback

/// Builds a Home feed from the catalog, tools, characters and library, for engines without GET /feed.
/// Nothing here names a model or a file: everything comes from what the engine returned.
public enum FeedBuilder {
    public struct Input: Sendable {
        public var catalog: Catalog?
        public var tools: [Tool]
        public var characters: [StudioCharacter]
        public var media: [MediaItem]
        public var preferredVideo: [String]
        public var preferredImage: [String]
        public var hiddenProviders: Set<String>
        public var features: @Sendable (String) -> Bool

        public init(catalog: Catalog?, tools: [Tool] = [], characters: [StudioCharacter] = [], media: [MediaItem] = [],
                    preferredVideo: [String] = [], preferredImage: [String] = [], hiddenProviders: Set<String> = [],
                    features: @escaping @Sendable (String) -> Bool = { _ in true }) {
            self.catalog = catalog; self.tools = tools; self.characters = characters; self.media = media
            self.preferredVideo = preferredVideo; self.preferredImage = preferredImage; self.hiddenProviders = hiddenProviders; self.features = features
        }
    }

    public static func build(_ input: Input) -> Feed {
        var sections: [FeedSection] = []
        let on = input.features
        let video = models(input, kind: "video", preferred: input.preferredVideo)
        let image = models(input, kind: "image", preferred: input.preferredImage)
        let recentVideo = input.media.filter(\.isVideo)

        if on("create") {
            // Hero: the preferred models first; borrow a library clip when a model has no example of its own.
            var hero: [FeedItem] = []
            var borrow = recentVideo.makeIterator()
            for m in (Array(video.prefix(3)) + Array(image.prefix(2))) {
                var item = modelItem(m, input)
                if item.preview == nil, let clip = (m.isVideo ? borrow.next() : nil) {
                    item.preview = MediaPreview(url: clip.url, poster: clip.thumb, kind: "video")
                }
                item.aspect = 16 / 10
                hero.append(item)
            }
            sections.append(FeedSection(id: "featured", title: "Featured", style: .hero, items: hero))
            sections.append(FeedSection(id: "video-models", title: "Video Models", style: .shelf, items: video.map { modelItem($0, input) }))
            sections.append(FeedSection(id: "image-models", title: "Image Models", style: .shelf, items: image.map { modelItem($0, input) }))
        }

        var studios: [FeedItem] = []
        let cinema = input.tools.first { $0.category.localizedCaseInsensitiveContains("cinema") }
        if let cinema, on("tools") { studios.append(toolItem(cinema, kind: "studio")) }
        if on("films") {
            studios.append(FeedItem(id: "studio-films", kind: "studio", title: "Films", subtitle: "Script to finished film, every shot planned and cut on the server",
                                    preview: input.media.first { $0.isVideo && $0.model.localizedCaseInsensitiveContains("master") }.map(still) ?? recentVideo.first.map(still),
                                    action: FeedAction(type: "films"), sfSymbol: "film.stack"))
        }
        if on("tools"), let lip = input.tools.first(where: { $0.id.localizedCaseInsensitiveContains("lipsync") || $0.title.localizedCaseInsensitiveContains("lipsync") }) {
            studios.append(toolItem(lip, kind: "studio"))
        }
        if on("characters") {
            studios.append(FeedItem(id: "studio-characters", kind: "studio", title: "Characters", subtitle: "Same face in every shot",
                                    preview: input.characters.first?.coverImageURL.map { MediaPreview(url: $0, kind: "image") },
                                    action: FeedAction(type: "characters"), sfSymbol: "person.crop.rectangle.stack"))
        }
        sections.append(FeedSection(id: "studios", title: "Studios", style: .shelf, items: studios))

        if on("tools") {
            let effects = input.tools.filter { $0.category.localizedCaseInsensitiveContains("effect") }
            sections.append(FeedSection(id: "effects", title: "Viral Effects", style: .grid, items: effects.map { var i = toolItem($0, kind: "preset"); i.aspect = 9 / 16; return i }))
            let rest = input.tools.filter { t in !effects.contains(t) && t.id != cinema?.id }
            sections.append(FeedSection(id: "tools", title: "Tools", style: .shelf, items: rest.map { toolItem($0, kind: "tool") }, more: FeedAction(type: "tools")))
        }
        if on("characters") {
            sections.append(FeedSection(id: "characters", title: "Your Characters", style: .shelf, items: input.characters.map { c in
                FeedItem(id: "character-\(c.id)", kind: "character", title: c.name, subtitle: "\(c.refs.count) reference\(c.refs.count == 1 ? "" : "s")",
                         preview: c.coverImageURL.map { MediaPreview(url: $0, kind: "image") }, aspect: 3 / 4,
                         action: FeedAction(type: "character", params: ["id": .string(c.id)]))
            }, more: FeedAction(type: "characters")))
        }
        sections.append(FeedSection(id: "recent", title: "Recent", style: .shelf, items: input.media.prefix(12).map { m in
            FeedItem(id: "media-\(m.id)", kind: "media", title: m.prompt.nonEmpty.map { String($0.prefix(60)) } ?? m.model, subtitle: m.model,
                     preview: m.isVideo ? MediaPreview(url: m.url, poster: m.thumb, kind: "video") : MediaPreview(url: m.url, kind: "image"), aspect: 1,
                     action: FeedAction(type: "media", params: ["id": .string(m.id)]))
        }, more: FeedAction(type: "library")))

        if on("tools") {
            let chips = input.tools.map { t in FeedItem(id: "chip-\(t.id)", kind: "tool", title: t.title, action: FeedAction(type: "tool", toolId: t.id), sfSymbol: t.sfSymbol) }
            sections.append(FeedSection(id: "explore-more", title: "Explore more AI features", style: .chips, items: chips))
        }
        return Feed(sections: sections)
    }

    private static func models(_ input: Input, kind: String, preferred: [String]) -> [ModelInfo] {
        let all = input.catalog?.groups(kind: kind, hiddenProviders: input.hiddenProviders).flatMap(\.models) ?? []
        let first = preferred.compactMap { id in all.first { $0.id == id } }
        return first + all.filter { m in !first.contains(m) }
    }

    private static func modelItem(_ m: ModelInfo, _ input: Input) -> FeedItem {
        FeedItem(id: "model-\(m.id)", kind: "model", title: m.label, subtitle: m.blurb, badge: input.catalog?.providerLabel(m.provider),
                 preview: m.preview, aspect: m.isVideo ? 16 / 10 : 4 / 5,
                 action: FeedAction(type: "create", model: m.id, params: ["mode": .string(m.isVideo ? "video" : "image")]), sfSymbol: m.isVideo ? "film" : "photo")
    }

    private static func toolItem(_ t: Tool, kind: String) -> FeedItem {
        FeedItem(id: "\(kind)-\(t.id)", kind: kind, title: t.title, subtitle: t.description, preview: t.preview, aspect: 4 / 5,
                 action: FeedAction(type: "tool", toolId: t.id), sfSymbol: t.sfSymbol)
    }

    private static func still(_ m: MediaItem) -> MediaPreview { MediaPreview(url: m.url, poster: m.thumb, kind: m.isVideo ? "video" : "image") }
}

// MARK: - Disk cache

/// Last good response per server and name (feed, catalog, tools…), so Home renders instantly and offline.
public struct ResponseCache: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public static var standard: ResponseCache {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ResponseCache(directory: base.appendingPathComponent("FilmStudio/responses", isDirectory: true))
    }
    private func file(_ name: String, _ server: URL) -> URL { directory.appendingPathComponent("\(name)-\(server.absoluteString.stableHash).json") }
    public func load(_ name: String, server: URL) -> Data? { try? Data(contentsOf: file(name, server)) }
    public func load<T: Decodable>(_ name: String, server: URL, as _: T.Type = T.self) -> T? {
        load(name, server: server).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
    public func save(_ data: Data, _ name: String, server: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file(name, server), options: .atomic)
    }
    public func clear() { try? FileManager.default.removeItem(at: directory) }
}
