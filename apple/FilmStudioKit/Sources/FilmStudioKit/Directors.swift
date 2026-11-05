import Foundation

/// A film director the user can pick (an LLM that plans shots, or "No AI" which splits the script).
/// There is no default director: planning needs an explicit choice, persisted on the server.
public struct DirectorOption: Sendable, Hashable, Identifiable {
    public struct Model: Sendable, Hashable, Identifiable { public var id: String; public var label: String }
    public var id: String
    public var label: String
    public var available: Bool
    public var note: String
    public var models: [Model]
    public var defaultModel: String?

    public init(id: String, label: String, available: Bool, note: String = "", models: [Model] = [], defaultModel: String? = nil) {
        self.id = id; self.label = label; self.available = available; self.note = note; self.models = models; self.defaultModel = defaultModel
    }

    init?(json v: JSONValue, key: String? = nil) {
        if let s = v.string, key == nil { self.init(id: s, label: s, available: true); return }
        guard let o = v.object, let id = o["id"]?.string ?? o["provider"]?.string ?? o["key"]?.string ?? o["value"]?.string ?? key else { return nil }
        let models: [Model] = (o["models"]?.array ?? []).compactMap { m in
            if let s = m.string { return Model(id: s, label: s) }
            guard let mid = m["id"]?.string ?? m["value"]?.string else { return nil }
            return Model(id: mid, label: m["label"]?.string ?? m["name"]?.string ?? mid)
        }
        self.init(id: id, label: o["label"]?.string ?? o["name"]?.string ?? o["title"]?.string ?? id,
                  available: (o["available"] ?? o["online"] ?? o["ready"])?.isTruthy ?? true,
                  note: o["note"]?.string ?? o["description"]?.string ?? o["reason"]?.string ?? "",
                  models: models, defaultModel: o["defaultModel"]?.string ?? o["model"]?.string)
    }
}

public struct DirectorChoice: Sendable, Hashable {
    public var provider: String
    public var model: String
    public init(provider: String, model: String = "") { self.provider = provider; self.model = model }
    /// "auto" is no longer a choice; empty means "not chosen yet".
    public var isChosen: Bool { !provider.isEmpty && provider != "auto" }
}

public struct DirectorCatalog: Sendable, Hashable {
    public var options: [DirectorOption]
    public var current: DirectorChoice?

    public init(options: [DirectorOption], current: DirectorChoice?) { self.options = options; self.current = current }

    /// Accepts `[...]`, `{ directors: [...] }`, `{ options: [...] }`, or an object keyed by provider, plus
    /// an optional current choice under `current` / `selected` / `directorProvider`+`directorModel`.
    public static func parse(_ v: JSONValue) -> DirectorCatalog {
        var list: [DirectorOption] = []
        if let a = v.array {
            list = a.compactMap { DirectorOption(json: $0) }
        } else if let o = v.object {
            if let a = (o["directors"] ?? o["options"] ?? o["available"])?.array {
                list = a.compactMap { DirectorOption(json: $0) }
            } else if let keyed = (o["directors"] ?? o["options"])?.object {
                list = keyed.compactMap { DirectorOption(json: $0.value, key: $0.key) }.sorted { $0.label < $1.label }
            }
        }
        return DirectorCatalog(options: list, current: choice(in: v))
    }

    static func choice(in v: JSONValue) -> DirectorChoice? {
        guard let o = v.object else { return nil }
        if let c = (o["current"] ?? o["selected"] ?? o["chosen"])?.object {
            return DirectorChoice(provider: c["provider"]?.string ?? c["id"]?.string ?? "", model: c["model"]?.string ?? "")
        }
        if let s = (o["current"] ?? o["selected"])?.string { return DirectorChoice(provider: s) }
        if let p = o["directorProvider"]?.string { return DirectorChoice(provider: p, model: o["directorModel"]?.string ?? "") }
        return nil
    }

    public func option(_ id: String?) -> DirectorOption? { id.flatMap { id in options.first { $0.id == id } } }

    /// "Grok · grok-4" style summary of the current choice.
    public func describe(_ c: DirectorChoice?) -> String {
        guard let c, c.isChosen else { return "Not chosen" }
        let o = option(c.provider)
        let model = o?.models.first { $0.id == c.model }?.label ?? c.model
        return [o?.label ?? c.provider, model.nonEmpty].compactMap { $0 }.joined(separator: " · ")
    }

    /// For engines without a directors list: what the old /status exposes.
    static func synthesized(from status: JSONValue?) -> DirectorCatalog {
        let providers = status?["providers"]?.object ?? [:]
        let has = { (k: String) in providers[k]?["available"]?.isTruthy ?? false }
        let apimartModels = (status?["directorModels"]?["apimart"]?.array ?? []).compactMap { m -> DirectorOption.Model? in
            if let s = m.string { return .init(id: s, label: s) }
            guard let id = m["id"]?.string else { return nil }
            return .init(id: id, label: m["label"]?.string ?? id)
        }
        let llm = status?["llm"]
        let llmModels = (llm?["models"]?.array ?? []).compactMap(\.string).map { DirectorOption.Model(id: $0, label: $0) }
        let options = [
            DirectorOption(id: "xai", label: "Grok", available: has("xai"), note: "SuperGrok sign-in or xAI key"),
            DirectorOption(id: "google", label: "Gemini", available: has("google"), note: "Gemini API key"),
            DirectorOption(id: "apimart", label: "ApiMart", available: has("apimart"), models: apimartModels),
            DirectorOption(id: "openai", label: "Local LLM", available: llm?["online"]?.isTruthy ?? false, models: llmModels),
            DirectorOption(id: "local", label: "No AI (split my script)", available: true, note: "Splits the script into shots without an LLM"),
        ]
        return DirectorCatalog(options: options, current: nil)
    }
}

public extension APIClient {
    /// Directors with availability: GET /directors, else the `directors` field of /status, else derived from /status.
    func directors() async throws -> DirectorCatalog {
        var catalog: DirectorCatalog?
        do {
            let v: JSONValue = try await get("/directors")
            let c = DirectorCatalog.parse(v)
            if !c.options.isEmpty { catalog = c }
        } catch let e as APIError where e.isMissingRoute {}
        var status: JSONValue?
        if catalog == nil {
            status = try await get("/status", as: JSONValue.self)
            if let d = status?["directors"] {
                let c = DirectorCatalog.parse(d.array != nil ? .object(["directors": d]) : d)
                if !c.options.isEmpty { catalog = c }
            }
        }
        var result = catalog ?? DirectorCatalog.synthesized(from: status)
        if result.current == nil {
            let s: JSONValue? = try? await get("/settings")
            result.current = s.flatMap(DirectorCatalog.choice(in:))
        }
        return result
    }

    /// Persists the director choice on the server (POST /settings).
    func setDirector(_ choice: DirectorChoice) async throws {
        try await call("POST", "/settings", json: ["directorProvider": .string(choice.provider), "directorModel": .string(choice.model)])
    }
}

public extension APIError {
    /// The engine refuses to plan until a director is chosen.
    var needsDirector: Bool {
        guard let m = errorDescription?.lowercased() else { return false }
        return m.contains("director") && (m.contains("choose") || m.contains("no director") || m.contains("pick"))
    }
}
