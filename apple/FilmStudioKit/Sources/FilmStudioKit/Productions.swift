import Foundation

public struct ProductionStatus: OpenEnum {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let draft = Self(rawValue: "draft")
    public static let planning = Self(rawValue: "planning")
    public static let planned = Self(rawValue: "planned")
    public static let running = Self(rawValue: "running")
    public static let paused = Self(rawValue: "paused")
    public static let review = Self(rawValue: "review")
    public static let done = Self(rawValue: "done")
    public static let error = Self(rawValue: "error")

    public var label: String {
        switch self {
        case .draft: "Draft"
        case .planning: "Planning"
        case .planned: "Planned"
        case .running: "Rendering"
        case .paused: "Paused"
        case .review: "Ready to assemble"
        case .done: "Done"
        case .error: "Error"
        default: rawValue.capitalized
        }
    }
    public var isLive: Bool { self == .planning || self == .running }
}

public struct ShotStatus: OpenEnum {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let pending = Self(rawValue: "pending")
    public static let running = Self(rawValue: "running")
    public static let done = Self(rawValue: "done")
    public static let error = Self(rawValue: "error")
    public static let skipped = Self(rawValue: "skipped")
    public static let handoff = Self(rawValue: "handoff")
    public var label: String {
        switch self {
        case .pending: "Queued"
        case .running: "Rendering"
        case .done: "Done"
        case .error: "Failed"
        case .skipped: "Skipped"
        case .handoff: "Waiting for clip"
        default: rawValue.capitalized
        }
    }
}

public struct ProductionSummary: Decodable, Sendable, Identifiable, Hashable {
    public var id: String
    public var title: String
    public var status: ProductionStatus
    public var shots: Int
    public var done: Int
    public var updatedAt: String
    public var cover: String?
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "production without id")) }
        self.id = id
        title = c.string("title", default: "Untitled film")
        status = ProductionStatus(rawValue: c.string("status", default: "draft"))
        shots = c.int("shots") ?? 0
        done = c.int("done") ?? 0
        updatedAt = c.string("updatedAt", default: "")
        cover = c.string("cover")
    }
}

/// The long-form brief. Only fields the app edits are typed; everything is sent back as a PATCH of changed keys.
public struct Brief: Sendable, Hashable {
    public var title = "Untitled film"
    public var script = ""
    public var style = ""
    public var targetMinutes: Double = 5
    public var clipSeconds: Double = 8
    public var aspect = "16:9"
    public var resolution = "720p"
    public var videoModel = ""
    public var imageModel = ""
    public var continuity = "extend"
    public var keyframes = true
    public var sceneFades = true
    public var autoAssemble = true
    /// Gemini watches each new master and writes notes (a paid call).
    public var autoScreen = true
    /// Score character shots against the references (a paid vision call per shot).
    public var likenessQA = true
    public var music = "off"
    public var musicModel = ""
    public var musicPrompt = ""
    public var musicVolume: Double = 0.35
    public var narration = false
    public var narratorStyle = ""
    public var voiceProvider = "auto"
    public var voice = ""
    public var characterNames: [String] = []

    public init() {}

    public init(json: JSONValue?) {
        let o = json?.object ?? [:]
        func s(_ k: String, _ d: String) -> String { o[k]?.string ?? d }
        func n(_ k: String, _ d: Double) -> Double { o[k]?.double ?? d }
        func b(_ k: String, _ d: Bool) -> Bool { o[k]?.bool ?? d }
        title = s("title", title); script = s("script", script); style = s("style", style)
        targetMinutes = n("targetMinutes", targetMinutes); clipSeconds = n("clipSeconds", clipSeconds)
        aspect = s("aspect", aspect); resolution = s("resolution", resolution)
        videoModel = s("videoModel", videoModel); imageModel = s("imageModel", imageModel)
        continuity = s("continuity", continuity); keyframes = b("keyframes", keyframes)
        sceneFades = b("sceneFades", sceneFades); autoAssemble = b("autoAssemble", autoAssemble)
        autoScreen = b("autoScreen", autoScreen); likenessQA = b("likenessQA", likenessQA)
        music = s("music", music); musicModel = s("musicModel", musicModel); musicPrompt = s("musicPrompt", musicPrompt)
        musicVolume = n("musicVolume", musicVolume); narration = b("narration", narration)
        narratorStyle = s("narratorStyle", narratorStyle); voiceProvider = s("voiceProvider", voiceProvider); voice = s("voice", voice)
        characterNames = (o["characters"]?.array ?? []).compactMap { $0["name"]?.string }
    }

    /// Body for POST /productions or PATCH /productions/:id.
    public var json: [String: JSONValue] {
        [
            "title": .string(title), "script": .string(script), "style": .string(style),
            "targetMinutes": .number(targetMinutes), "clipSeconds": .number(clipSeconds),
            "aspect": .string(aspect), "resolution": .string(resolution),
            "videoModel": .string(videoModel), "imageModel": .string(imageModel),
            "continuity": .string(continuity), "keyframes": .bool(keyframes), "sceneFades": .bool(sceneFades), "autoAssemble": .bool(autoAssemble),
            "autoScreen": .bool(autoScreen), "likenessQA": .bool(likenessQA),
            "music": .string(music), "musicModel": .string(musicModel), "musicPrompt": .string(musicPrompt), "musicVolume": .number(musicVolume),
            "narration": .bool(narration), "narratorStyle": .string(narratorStyle), "voiceProvider": .string(voiceProvider), "voice": .string(voice),
        ]
    }

    /// Only the keys that differ from `old` (so concurrent server-side changes are not overwritten).
    public func changes(from old: Brief) -> [String: JSONValue] {
        let a = json, b = old.json
        return a.filter { b[$0.key] != $0.value }
    }

    /// Shots the director will plan for this length (same formula as the engine).
    public var shotCount: Int { max(1, Int((max(10, targetMinutes * 60) / max(clipSeconds, 1)).rounded())) }
}

public struct FilmScene: Sendable, Hashable, Identifiable {
    public var id: String
    public var title: String
    public var summary: String
    public var music: String
}

public struct Shot: Sendable, Hashable, Identifiable {
    public var id: String
    public var index: Int
    public var sceneId: String?
    public var title: String
    public var action: String
    public var camera: String
    public var prompt: String
    public var narration: String
    public var continuity: String
    public var duration: Double?
    public var model: String?
    public var status: ShotStatus
    public var attempts: Int
    public var error: String?
    public var message: String
    public var videoUrl: String?
    public var posterUrl: String?
    public var keyframeUrl: String?
    public var startFrameUrl: String?
    public var clipDuration: Double?

    init(json o: [String: JSONValue]) {
        id = o["id"]?.string ?? UUID().uuidString
        index = Int(o["index"]?.double ?? 0)
        sceneId = o["sceneId"]?.string
        title = o["title"]?.string ?? ""
        action = o["action"]?.string ?? ""
        camera = o["camera"]?.string ?? ""
        prompt = o["prompt"]?.string ?? ""
        narration = o["narration"]?.string ?? ""
        continuity = o["continuity"]?.string ?? "cut"
        duration = o["duration"]?.double
        model = o["model"]?.string
        status = ShotStatus(rawValue: o["status"]?.string ?? "pending")
        attempts = Int(o["attempts"]?.double ?? 0)
        error = o["error"]?.string
        message = o["message"]?.string ?? ""
        videoUrl = o["videoUrl"]?.string
        posterUrl = o["posterUrl"]?.string
        keyframeUrl = o["keyframeUrl"]?.string
        startFrameUrl = o["startFrameUrl"]?.string
        clipDuration = o["clipDuration"]?.double
    }
    /// Best still for a thumbnail.
    public var stillURL: String? { posterUrl ?? keyframeUrl ?? startFrameUrl }
}

public struct Production: Decodable, Sendable, Identifiable {
    public struct Plan: Sendable, Hashable { public var title: String; public var logline: String; public var style: String; public var director: String }
    public struct Master: Sendable, Hashable { public var url: String; public var duration: Double?; public var shots: Int; public var createdAt: String }
    public struct LogLine: Sendable, Hashable, Identifiable { public var id: String { at + msg }; public var at: String; public var msg: String }

    public var id: String
    public var title: String
    public var status: ProductionStatus
    public var message: String
    public var brief: Brief
    public var plan: Plan?
    public var scenes: [FilmScene]
    public var shots: [Shot]
    public var master: Master?
    public var log: [LogLine]
    public var running: Bool
    public var assembling: Bool
    public var shotCount: Int
    public var updatedAt: String

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "production without id")) }
        self.id = id
        title = c.string("title", default: "Untitled film")
        status = ProductionStatus(rawValue: c.string("status", default: "draft"))
        message = c.string("message", default: "")
        brief = Brief(json: c.json("brief"))
        if let p = c.json("plan")?.object {
            plan = Plan(title: p["title"]?.string ?? "", logline: p["logline"]?.string ?? "", style: p["style"]?.string ?? "", director: p["director"]?.string ?? "")
        }
        scenes = (c.json("scenes")?.array ?? []).compactMap { s in
            guard let id = s["id"]?.string else { return nil }
            return FilmScene(id: id, title: s["title"]?.string ?? "", summary: s["summary"]?.string ?? "", music: s["music"]?.string ?? "")
        }
        shots = (c.json("shots")?.array ?? []).compactMap { $0.object.map(Shot.init(json:)) }.sorted { $0.index < $1.index }
        if let m = c.json("master")?.object, let url = m["url"]?.string {
            master = Master(url: url, duration: m["duration"]?.double, shots: Int(m["shots"]?.double ?? 0), createdAt: m["createdAt"]?.string ?? "")
        }
        log = (c.json("log")?.array ?? []).compactMap { l in l["msg"]?.string.map { LogLine(at: l["at"]?.string ?? "", msg: $0) } }
        running = c.bool("running", default: false)
        assembling = c.bool("assembling", default: false)
        shotCount = c.int("shotCount") ?? brief.shotCount
        updatedAt = c.string("updatedAt", default: "")
    }

    /// Whether the app should poll quickly.
    public var isLive: Bool { status.isLive || assembling || running || shots.contains { $0.status == .running } }
    public var doneCount: Int { shots.filter { $0.status == .done }.count }
    public var canAssemble: Bool { doneCount > 0 && !assembling && status != .running }

    /// Shots grouped under their scene, in order (shots without a known scene go last).
    public var sceneGroups: [(scene: FilmScene?, shots: [Shot])] {
        var groups: [(FilmScene?, [Shot])] = []
        for shot in shots {
            let scene = scenes.first { $0.id == shot.sceneId }
            if let last = groups.last, last.0?.id == scene?.id { groups[groups.count - 1].1.append(shot) } else { groups.append((scene, [shot])) }
        }
        return groups
    }
}
