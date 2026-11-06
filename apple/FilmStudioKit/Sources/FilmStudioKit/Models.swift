import Foundation

// Every model decodes leniently: unknown fields are ignored, missing or mistyped fields fall back to
// defaults, unknown enum values are kept as strings, and bad array elements are skipped.

// MARK: - Health / version

public struct Health: Decodable, Sendable, Equatable {
    public struct User: Decodable, Sendable, Equatable { public var name: String; public var email: String }
    public var ok: Bool
    public var name: String
    public var auth: Bool
    public var mode: String // "oidc" | "code"
    public var provider: String?
    public var authed: Bool
    public var user: User?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        ok = c.bool("ok", default: false)
        name = c.string("name", default: "")
        auth = c.bool("auth", default: false)
        mode = c.string("mode", default: "code")
        provider = c.string("provider")
        authed = c.bool("authed", default: false)
        if let u = c.json("user")?.object { user = User(name: u["name"]?.string ?? "", email: u["email"]?.string ?? "") }
    }
    public var usesPocketID: Bool { mode == "oidc" }
}

public struct AppVersionInfo: Decodable, Sendable, Equatable {
    public var minVersion: String
    public var latestVersion: String
    public var updateUrl: String?
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        minVersion = c.string("minVersion", default: "0")
        latestVersion = c.string("latestVersion", default: "0")
        updateUrl = c.string("updateUrl")
    }
    public init(minVersion: String, latestVersion: String, updateUrl: String?) {
        self.minVersion = minVersion; self.latestVersion = latestVersion; self.updateUrl = updateUrl
    }
}

// MARK: - Media

public struct MediaItem: Decodable, Sendable, Identifiable, Hashable {
    public var id: String
    public var url: String
    public var thumb: String
    public var kind: String // "images" | "videos"
    public var model: String
    public var prompt: String
    public var createdAt: String
    public var resolution: String
    /// upload | film (a shot clip / keyframe of a production) | master | generated ("" on older engines).
    public var origin: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id"), let url = c.string("url") else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "media item without id/url"))
        }
        self.id = id
        self.url = url
        thumb = c.string("thumb", default: "")
        kind = c.string("kind", default: "images")
        model = c.string("model", default: "")
        prompt = c.string("prompt", default: "")
        createdAt = c.string("createdAt", default: "")
        resolution = c.string("resolution", default: "")
        origin = c.string("origin", default: model == "upload" ? "upload" : "")
    }
    public init(id: String, url: String, thumb: String = "", kind: String = "images", model: String = "", prompt: String = "", createdAt: String = "", resolution: String = "", origin: String = "") {
        self.id = id; self.url = url; self.thumb = thumb; self.kind = kind; self.model = model; self.prompt = prompt; self.createdAt = createdAt; self.resolution = resolution; self.origin = origin
    }
    /// Uploads and film parts stay out of the main Library grid and Home (QA-09).
    public var isCreation: Bool { origin != "upload" && origin != "film" }
    public var isVideo: Bool { kind.hasPrefix("video") }
    /// The still to show in a grid: the poster for videos, the image itself otherwise.
    public var previewURL: String { thumb.isEmpty ? (isVideo ? "" : url) : thumb }
    public var date: Date? { ISODate.parse(createdAt) }
}

/// Result of POST /upload (an engine asset).
public struct UploadedAsset: Decodable, Sendable, Hashable, Identifiable {
    public var id: String
    public var url: String
    public var kind: String
    public var mime: String
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "asset without id")) }
        self.id = id
        url = c.string("url", default: "")
        kind = c.string("kind", default: "image")
        mime = c.string("mime", default: "")
    }
    public init(id: String, url: String, kind: String, mime: String = "") { self.id = id; self.url = url; self.kind = kind; self.mime = mime }
}

// MARK: - Catalog

public struct ModelCaps: Sendable, Hashable {
    public var t2v = false, i2v = false, end = false, extend = false
    /// Video: how many reference photos the model takes in reference mode, and whether a start frame can go with them.
    public var refs = 0, refsWithImage = false
}

public struct ModelInfo: Decodable, Sendable, Identifiable, Hashable {
    public var id: String
    public var provider: String
    public var label: String
    public var blurb: String
    public var kind: String // "image" | "video"
    public var available: Bool
    public var caps: ModelCaps
    public var durations: [Double]
    public var aspects: [String]
    public var resolutions: [String]
    public var resolutionDefault: String?
    public var maxClip: Double?
    public var refs: Int
    /// Optional example still (thumbnail / thumb / example) for the Explore feed.
    public var thumbnail: String?
    /// Example media (previewUrl / previewPoster / previewKind) for Home and the model picker.
    public var preview: MediaPreview?
    /// Free-form price hint from the engine ("$0.05 / s"), when it knows one.
    public var price: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "model without id")) }
        price = c.string("price") ?? c.string("cost") ?? c.string("credits").map { "\($0) credits" }
        thumbnail = c.string("thumbnail") ?? c.string("thumb") ?? c.string("example")
        preview = MediaPreview(c, fallbackStill: thumbnail)
        self.id = id
        provider = c.string("provider") ?? String(id.split(separator: "/").first ?? "")
        label = c.string("label", default: id)
        blurb = c.string("blurb", default: "")
        kind = c.string("kind", default: "image")
        available = c.bool("available", default: false)
        let caps = c.json("caps")
        self.caps = ModelCaps(t2v: caps?["t2v"]?.isTruthy ?? false, i2v: caps?["i2v"]?.isTruthy ?? false, end: caps?["end"]?.isTruthy ?? false, extend: caps?["extend"]?.isTruthy ?? false,
                              refs: Int(caps?["refs"]?.double ?? 0), refsWithImage: caps?["refsWithImage"]?.isTruthy ?? false)
        durations = c.doubles("durations")
        aspects = c.strings("aspects")
        resolutions = c.strings("resolutions")
        resolutionDefault = c.string("resolutionDefault")
        maxClip = c.double("maxClip")
        refs = c.int("refs") ?? 0
    }
    public var isVideo: Bool { kind == "video" }
    /// The product name without the provider plumbing: "Veo 3.1 Quality (ApiMart)" → "Veo 3.1 Quality" (QA-23).
    /// Only provider names are dropped; descriptive suffixes like "(offline previs)" stay.
    public var displayName: String { ModelInfo.productName(label, provider: provider) }
    static let providerSuffixes: Set<String> = ["apimart", "gemini", "google", "qwen", "qwen plan", "fal", "kie.ai", "kie", "replicate", "muapi", "xai", "grok", "venice", "comfy", "comfyui"]
    public static func productName(_ label: String, provider: String = "") -> String {
        guard label.hasSuffix(")"), let open = label.lastIndex(of: "(") else { return label }
        let inner = label[label.index(after: open)..<label.index(before: label.endIndex)].trimmingCharacters(in: .whitespaces).lowercased()
        guard providerSuffixes.contains(inner) || (!provider.isEmpty && inner == provider.lowercased()) else { return label }
        let name = label[..<open].trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? label : name
    }
    /// How many input images the model takes (start frame for video, references for images).
    public var acceptsStartImage: Bool { isVideo ? caps.i2v : refs > 0 }
    public var requiresStartImage: Bool { isVideo && caps.i2v && !caps.t2v }
}

public struct ProviderInfo: Decodable, Sendable, Hashable {
    public var label: String
    public var note: String
    public var available: Bool?
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        label = c.string("label", default: "")
        note = c.string("note", default: "")
        available = c.bool("available")
    }
}

public struct Catalog: Decodable, Sendable {
    public var models: [ModelInfo]
    public var providers: [String: ProviderInfo]
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        models = c.list("models")
        providers = c.value("providers", as: [String: Lossy<ProviderInfo>].self)?.compactMapValues(\.value) ?? [:]
    }
    public init(models: [ModelInfo], providers: [String: ProviderInfo] = [:]) { self.models = models; self.providers = providers }

    public func model(_ id: String?) -> ModelInfo? { id.flatMap { id in models.first { $0.id == id } } }
    public func providerLabel(_ key: String) -> String { providers[key]?.label.nonEmpty ?? key }

    /// Available models of a kind, grouped by provider in catalog order.
    public func groups(kind: String, hiddenProviders: Set<String> = []) -> [(provider: String, label: String, models: [ModelInfo])] {
        var order: [String] = []
        var byProvider: [String: [ModelInfo]] = [:]
        for m in models where m.kind == kind && m.available && !hiddenProviders.contains(m.provider) {
            if byProvider[m.provider] == nil { order.append(m.provider) }
            byProvider[m.provider, default: []].append(m)
        }
        return order.map { ($0, providerLabel($0), byProvider[$0] ?? []) }
    }

    /// First preferred model that is available, else the first available model of that kind.
    public func pick(kind: String, preferred: [String], hiddenProviders: Set<String> = []) -> ModelInfo? {
        let usable = models.filter { $0.kind == kind && $0.available && !hiddenProviders.contains($0.provider) }
        for id in preferred { if let m = usable.first(where: { $0.id == id }) { return m } }
        return usable.first
    }
}

// MARK: - Jobs

public struct JobStatus: OpenEnum {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let running = JobStatus(rawValue: "running")
    public static let done = JobStatus(rawValue: "done")
    public static let error = JobStatus(rawValue: "error")
    public static let cancelled = JobStatus(rawValue: "cancelled")
    public var isFinished: Bool { self == .done || self == .error || self == .cancelled }
}

public struct Job: Decodable, Sendable, Identifiable, Hashable {
    public var id: String
    public var status: JobStatus
    public var message: String
    public var progress: Double?
    public var model: String
    public var url: String?
    public var assetId: String?
    public var posterUrl: String?
    public var duration: Double?
    public var error: String?
    public var kind: String? // "image" | "video" | "audio" when the server says so

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") ?? c.string("jobId") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "job without id")) }
        self.id = id
        status = JobStatus(rawValue: c.string("status", default: "running"))
        message = c.string("message", default: "")
        progress = c.double("progress")
        model = c.string("model", default: "")
        url = c.string("url")
        assetId = c.string("assetId")
        posterUrl = c.string("posterUrl")
        duration = c.double("duration")
        error = c.string("error")
        kind = c.string("kind")
    }
    public init(id: String, status: JobStatus, message: String = "", url: String? = nil, posterUrl: String? = nil, kind: String? = nil) {
        self.id = id; self.status = status; self.message = message; self.model = ""; self.url = url; self.posterUrl = posterUrl; self.kind = kind
    }
    /// Progress 0…1 (the engine reports either 0–1 or 0–100).
    public var fraction: Double? { progress.map { $0 > 1 ? min($0 / 100, 1) : max($0, 0) } }
}

// MARK: - Provider status

public struct StatusReport: Decodable, Sendable {
    public struct Provider: Sendable, Identifiable, Hashable { public var id: String; public var label: String; public var note: String; public var available: Bool }
    public var providers: [Provider]
    public var comfy: Bool
    public var llmOnline: Bool
    public var director: String?
    public var elevenAvailable: Bool
    public var ffmpeg: Bool
    public var xaiSignedIn: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        let p = c.json("providers")?.object ?? [:]
        providers = p.map { Provider(id: $0.key, label: $0.value["label"]?.string ?? $0.key, note: $0.value["note"]?.string ?? "", available: $0.value["available"]?.isTruthy ?? false) }
            .sorted { ($0.available ? 0 : 1, $0.label) < ($1.available ? 0 : 1, $1.label) }
        comfy = c.bool("comfy", default: false)
        llmOnline = c.json("llm")?["online"]?.isTruthy ?? false
        director = c.string("director")
        elevenAvailable = c.json("eleven")?["available"]?.isTruthy ?? false
        ffmpeg = c.bool("ffmpeg", default: false)
        let x = c.json("xai")
        xaiSignedIn = x?["loggedIn"]?.isTruthy ?? x?["connected"]?.isTruthy ?? false
    }
}

// MARK: - Sound

public struct SoundCatalog: Decodable, Sendable {
    public struct Music: Sendable, Hashable, Identifiable { public var id: String; public var label: String; public var available: Bool }
    public struct Voice: Sendable, Hashable, Identifiable { public var id: String; public var name: String }
    public struct VoiceProvider: Sendable, Hashable, Identifiable {
        public var id: String; public var label: String; public var available: Bool; public var voices: [Voice]; public var defaultVoice: String?
    }
    public var music: [Music]
    public var voice: [VoiceProvider]

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        music = (c.json("music")?.array ?? []).compactMap { m in
            guard let id = m["id"]?.string else { return nil }
            return Music(id: id, label: m["label"]?.string ?? id, available: m["available"]?.isTruthy ?? false)
        }
        voice = (c.json("voice")?.array ?? []).compactMap { v in
            guard let id = v["id"]?.string else { return nil }
            let voices: [Voice] = (v["voices"]?.array ?? []).compactMap { x in
                if let s = x.string { return Voice(id: s, name: s) }
                guard let vid = x["id"]?.string else { return nil }
                return Voice(id: vid, name: x["name"]?.string ?? vid)
            }
            return VoiceProvider(id: id, label: v["label"]?.string ?? id, available: v["available"]?.isTruthy ?? false, voices: voices, defaultVoice: v["defaultVoice"]?.string)
        }
    }
    public init(music: [Music] = [], voice: [VoiceProvider] = []) { self.music = music; self.voice = voice }
    public static let empty = SoundCatalog()
    public var allVoices: [(provider: VoiceProvider, voice: Voice)] { voice.filter(\.available).flatMap { p in p.voices.map { (p, $0) } } }
}

// MARK: - Helpers

public enum ISODate {
    nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f }()
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()
    private static let lock = NSLock()
    public static func parse(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        lock.lock(); defer { lock.unlock() }
        return withFraction.date(from: s) ?? plain.date(from: s)
    }
    public static func string(_ d: Date = Date()) -> String {
        lock.lock(); defer { lock.unlock() }
        return withFraction.string(from: d)
    }
}

public extension String {
    var nonEmpty: String? { let t = trimmingCharacters(in: .whitespacesAndNewlines); return t.isEmpty ? nil : self }
}
