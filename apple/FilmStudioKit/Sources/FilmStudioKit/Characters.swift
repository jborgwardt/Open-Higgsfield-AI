import Foundation

/// A recurring character with reference photos (GET /characters). Built against the agreed contract;
/// the app degrades gracefully while the route is not deployed (404).
public struct StudioCharacter: Decodable, Sendable, Identifiable, Hashable {
    public struct Voice: Sendable, Hashable { public var provider: String; public var voiceId: String }
    public struct Quality: Sendable, Hashable {
        public var score: Double?
        public var sharp: JSONValue?
        public var issues: [String]
        /// 0…1 when the server reports 0–1 or 0–100.
        public var normalizedScore: Double? { score.map { $0 > 1 ? min($0 / 100, 1) : max($0, 0) } }
    }
    public struct Ref: Sendable, Hashable, Identifiable {
        public var id: String { assetId }
        public var assetId: String
        public var url: String
        public var kind: String // photo | video-frame | sheet
        public var angle: String?
        public var quality: Quality?
        /// "analyzing" while the engine grades the photo in the background; "ready" after.
        public var status: String = "ready"
        public var error: String?
        public var isAnalyzing: Bool { status == "analyzing" || status == "processing" }
    }
    public struct Sheet: Sendable, Hashable { public var assetId: String; public var url: String; public var approved: Bool }

    public var id: String
    public var name: String
    public var description: String
    public var lookNotes: String
    public var voice: Voice?
    public var refs: [Ref]
    public var sheet: Sheet?
    public var coverUrl: String?
    public var createdAt: String
    public var updatedAt: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "character without id")) }
        self.id = id
        name = c.string("name", default: "Unnamed")
        description = c.string("description", default: "")
        lookNotes = c.string("lookNotes", default: "")
        if let v = c.json("voice")?.object, let vid = v["voiceId"]?.string { voice = Voice(provider: v["provider"]?.string ?? "eleven", voiceId: vid) }
        refs = (c.json("refs")?.array ?? []).compactMap { r in
            guard let aid = r["assetId"]?.string else { return nil }
            var q: Quality?
            if let qo = r["quality"]?.object {
                q = Quality(score: qo["score"]?.double, sharp: qo["sharp"], issues: (qo["issues"]?.array ?? []).compactMap(\.string))
            }
            return Ref(assetId: aid, url: r["url"]?.string ?? "", kind: r["kind"]?.string ?? "photo", angle: r["angle"]?.string, quality: q,
                       status: r["status"]?.string ?? "ready", error: r["error"]?.string)
        }
        if let s = c.json("sheet")?.object, let url = s["url"]?.string {
            sheet = Sheet(assetId: s["assetId"]?.string ?? "", url: url, approved: s["approved"]?.isTruthy ?? false)
        }
        coverUrl = c.string("coverUrl")
        processing = !(c.json("processing")?.array?.isEmpty ?? true)
        createdAt = c.string("createdAt", default: "")
        updatedAt = c.string("updatedAt", default: "")
    }

    public var coverImageURL: String? { coverUrl ?? sheet?.url ?? refs.first?.url }
    /// Work still running on the server (grading photos, cutting a video, drawing a sheet).
    public var isProcessing: Bool { refs.contains(where: \.isAnalyzing) || processing }
    public var processing = false
}

/// GET /characters/:id/coverage — which reference angles exist, what is missing, and tips.
public struct Coverage: Decodable, Sendable, Hashable {
    public var have: [String: JSONValue]
    public var missing: [String]
    public var tips: [String]
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        have = c.json("have")?.object ?? [:]
        missing = c.strings("missing")
        tips = c.strings("tips")
    }
    public init(have: [String: JSONValue] = [:], missing: [String] = [], tips: [String] = []) { self.have = have; self.missing = missing; self.tips = tips }
    public func has(_ angle: String) -> Bool { have[angle]?.isTruthy ?? false }
}
