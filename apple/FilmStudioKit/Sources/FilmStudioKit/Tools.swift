import Foundation

/// A server-defined one-click tool (GET /tools). The app renders its form from `inputs` and runs it —
/// no per-tool native code, so new tools ship from the engine.
public struct Tool: Decodable, Sendable, Identifiable, Hashable {
    public struct Run: Sendable, Hashable { public var method: String; public var path: String }

    public var id: String
    public var title: String
    public var sfSymbol: String
    public var category: String
    public var description: String
    public var inputs: [ToolInput]
    public var run: Run
    public var output: String // image | video | audio (anything else is shown generically)
    /// Example still for the Explore feed (any of thumbnail / thumb / image / coverUrl / preview).
    public var thumbnail: String?
    /// Example media (previewUrl / previewPoster / previewKind).
    public var preview: MediaPreview?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let id = c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "tool without id")) }
        self.id = id
        title = c.string("title") ?? c.string("label") ?? id
        sfSymbol = c.string("sfSymbol", default: "sparkles")
        category = c.string("category", default: "Tools")
        description = c.string("description", default: "")
        inputs = c.list("inputs")
        let r = c.json("run")
        run = Run(method: (r?["method"]?.string ?? "POST").uppercased(), path: r?["path"]?.string ?? "/tools/\(id.pathSegment)/run")
        output = c.string("output", default: "image")
        thumbnail = c.string("thumbnail") ?? c.string("thumb") ?? c.string("image") ?? c.string("coverUrl") ?? c.string("preview") ?? c.json("example")?["image"]?.string
        preview = MediaPreview(c, fallbackStill: thumbnail)
    }

    /// Group by category, keeping the server's order.
    public static func grouped(_ tools: [Tool]) -> [(category: String, tools: [Tool])] {
        var order: [String] = []
        var by: [String: [Tool]] = [:]
        for t in tools { if by[t.category] == nil { order.append(t.category) }; by[t.category, default: []].append(t) }
        return order.map { ($0, by[$0] ?? []) }
    }

    /// Validates required inputs; returns the labels that are missing.
    public func missingInputs(in values: [String: JSONValue]) -> [String] {
        inputs.filter { $0.required && !$0.kind.isPassive && !(values[$0.key]?.isFilled ?? false) }.map(\.label)
    }

    /// Initial values from each input's default.
    public var initialValues: [String: JSONValue] {
        var v: [String: JSONValue] = [:]
        for i in inputs { if let d = i.defaultValue, !d.isNull { v[i.key] = d } else if i.kind == .toggle { v[i.key] = .bool(false) } }
        return v
    }
}

public struct ToolInputKind: OpenEnum {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let text = Self(rawValue: "text")
    public static let longtext = Self(rawValue: "longtext")
    public static let image = Self(rawValue: "image")
    public static let video = Self(rawValue: "video")
    public static let audio = Self(rawValue: "audio")
    public static let select = Self(rawValue: "select")
    public static let number = Self(rawValue: "number")
    public static let toggle = Self(rawValue: "toggle")
    public static let character = Self(rawValue: "character")
    public static let voice = Self(rawValue: "voice")
    public static let model = Self(rawValue: "model")
    public static let known: [Self] = [.text, .longtext, .image, .video, .audio, .select, .number, .toggle, .character, .voice, .model]
    public var isMedia: Bool { self == .image || self == .video || self == .audio }
    /// Unknown input types render as a text field (forward compatible), never crash.
    public var isKnown: Bool { Self.known.contains(self) }
    var isPassive: Bool { false }
}

public struct ToolInput: Decodable, Sendable, Hashable, Identifiable {
    public struct Option: Sendable, Hashable, Identifiable { public var id: String { value }; public var value: String; public var label: String }
    public var id: String { key }
    public var key: String
    public var kind: ToolInputKind
    public var label: String
    public var help: String
    public var options: [Option]
    public var defaultValue: JSONValue?
    public var required: Bool
    public var min: Double?
    public var max: Double?
    public var step: Double?
    public var modelKind: String?
    public var multiple: Bool

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        guard let key = c.string("key") ?? c.string("id") else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "input without key")) }
        self.key = key
        kind = ToolInputKind(rawValue: c.string("type", default: "text"))
        label = c.string("label") ?? key.capitalized
        help = c.string("help", default: "")
        options = (c.json("options")?.array ?? []).compactMap { o in
            if let s = o.string { return Option(value: s, label: s) }
            guard let v = o["value"]?.string else { return nil }
            return Option(value: v, label: o["label"]?.string ?? v)
        }
        defaultValue = c.json("default")
        required = c.bool("required", default: false)
        min = c.double("min")
        max = c.double("max")
        step = c.double("step")
        modelKind = c.string("modelKind")
        multiple = c.bool("multiple", default: false)
    }
}

public extension JSONValue {
    /// Whether a form value counts as provided.
    var isFilled: Bool {
        switch self {
        case .null: return false
        case .string(let s): return !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .array(let a): return !a.isEmpty
        default: return true
        }
    }
}
