import Foundation

/// Server-driven app configuration (GET /engine/api/app/config). The app obeys it for tab order and
/// visibility, native-vs-web screens, feature flags, defaults, copy, polling and update prompts.
/// Missing keys fall back to the bundled defaults (the same defaults the engine ships), never crash.
public struct AppConfig: Decodable, Sendable, Equatable {
    public struct Notice: Sendable, Equatable, Hashable {
        public var id: String
        public var title: String
        public var body: String
        public var level: String // info | warning | critical
        public var isCritical: Bool { level == "critical" }
    }
    public struct Tab: Sendable, Equatable, Hashable, Identifiable {
        public var id: String
        public var title: String
        public var sfSymbol: String
        public var kind: String // native | web
        public var path: String
        public var hidden: Bool
        public var isWeb: Bool { kind == "web" }
    }
    public struct ScreenOverride: Sendable, Equatable, Hashable { public var kind: String; public var path: String? }
    public struct CaptureStep: Sendable, Equatable, Hashable, Identifiable { public var id: String; public var title: String; public var instruction: String; public var sfSymbol: String }
    public struct Capture: Sendable, Equatable {
        public var title: String
        public var intro: String
        public var checklist: [CaptureStep]
        public var tips: [String]
        public var videoInstruction: String
        public var videoMinSeconds: Double
        public var videoMaxSeconds: Double
        public var cameraZoom: Double
        public var cameraPosition: String
    }

    public var minVersion: String
    public var latestVersion: String
    public var updateUrl: String?
    public var notice: Notice?
    public var tabs: [Tab]
    public var screens: [String: ScreenOverride]
    public var features: [String: Bool]
    public var defaults: [String: JSONValue]
    public var polling: [String: Double]
    public var limits: [String: Double]
    public var webBaseUrl: String?
    public var capture: Capture
    public var updatedAt: String?

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        // The bundled fallback is itself decoded with `bareDecoder` (no fallback), avoiding recursion.
        let fb = decoder.userInfo[AppConfig.bareKey] != nil ? nil : AppConfig.fallbackOrNil
        minVersion = c.string("minVersion") ?? fb?.minVersion ?? "0"
        latestVersion = c.string("latestVersion") ?? fb?.latestVersion ?? "0"
        updateUrl = c.string("updateUrl") ?? fb?.updateUrl
        if let n = c.json("notice")?.object, let body = n["body"]?.string ?? n["title"]?.string {
            let title = n["title"]?.string ?? ""
            notice = Notice(id: n["id"]?.string ?? "\(title)|\(body)".stableHash, title: title, body: n["body"] == nil ? "" : body, level: n["level"]?.string ?? "info")
        }
        let parsedTabs: [Tab] = (c.json("tabs")?.array ?? []).compactMap { t in
            guard let id = t["id"]?.string else { return nil }
            return Tab(id: id, title: t["title"]?.string ?? id.capitalized, sfSymbol: t["sfSymbol"]?.string ?? "square.dashed", kind: t["kind"]?.string ?? "native", path: t["path"]?.string ?? "/", hidden: t["hidden"]?.isTruthy ?? false)
        }
        tabs = parsedTabs.isEmpty ? (fb?.tabs ?? []) : parsedTabs
        screens = (c.json("screens")?.object ?? [:]).compactMapValues { v in
            guard let kind = v["kind"]?.string else { return nil }
            return ScreenOverride(kind: kind, path: v["path"]?.string)
        }
        var f = fb?.features ?? [:]
        for (k, v) in c.json("features")?.object ?? [:] { if let b = v.bool { f[k] = b } }
        features = f
        var d = fb?.defaults ?? [:]
        for (k, v) in c.json("defaults")?.object ?? [:] { d[k] = v }
        defaults = d
        var p = fb?.polling ?? [:]
        for (k, v) in c.json("polling")?.object ?? [:] { if let n = v.double { p[k] = n } }
        polling = p
        var l = fb?.limits ?? [:]
        for (k, v) in c.json("limits")?.object ?? [:] { if let n = v.double { l[k] = n } }
        limits = l
        webBaseUrl = c.json("web")?["baseUrl"]?.string?.nonEmpty ?? fb?.webBaseUrl
        capture = AppConfig.parseCapture(c.json("capture"), fallback: fb?.capture)
        updatedAt = c.string("updatedAt")
    }

    private static func parseCapture(_ v: JSONValue?, fallback: Capture?) -> Capture {
        let steps: [CaptureStep] = (v?["checklist"]?.array ?? []).compactMap { s in
            guard let id = s["id"]?.string else { return nil }
            return CaptureStep(id: id, title: s["title"]?.string ?? id, instruction: s["instruction"]?.string ?? "", sfSymbol: s["sfSymbol"]?.string ?? "camera")
        }
        let tips = (v?["tips"]?.array ?? []).compactMap(\.string)
        return Capture(
            title: v?["title"]?.string ?? fallback?.title ?? "Reference capture",
            intro: v?["intro"]?.string ?? fallback?.intro ?? "",
            checklist: steps.isEmpty ? (fallback?.checklist ?? []) : steps,
            tips: tips.isEmpty ? (fallback?.tips ?? []) : tips,
            videoInstruction: v?["video"]?["instruction"]?.string ?? fallback?.videoInstruction ?? "",
            videoMinSeconds: v?["video"]?["minSeconds"]?.double ?? fallback?.videoMinSeconds ?? 10,
            videoMaxSeconds: v?["video"]?["maxSeconds"]?.double ?? fallback?.videoMaxSeconds ?? 15,
            cameraZoom: v?["camera"]?["zoom"]?.double ?? fallback?.cameraZoom ?? 2,
            cameraPosition: v?["camera"]?["position"]?.string ?? fallback?.cameraPosition ?? "back"
        )
    }

    // MARK: Accessors

    /// Feature flags default to ON when the server does not mention them (a missing key never hides a feature).
    public func isOn(_ flag: String) -> Bool { features[flag] ?? true }

    /// Visible tabs in server order. Settings is always reachable so a bad config can be undone from the app.
    public var visibleTabs: [Tab] {
        var t = tabs.filter { !$0.hidden }
        var seen = Set<String>()
        t = t.filter { seen.insert($0.id).inserted }
        if !t.contains(where: { $0.id == "settings" }) {
            t.append(Tab(id: "settings", title: "Settings", sfSymbol: "gearshape", kind: "native", path: "/", hidden: false))
        }
        return t
    }

    /// The effective presentation of a screen: a `screens` override wins over the tab's own kind.
    public func presentation(for screen: String) -> (web: Bool, path: String?) {
        if let o = screens[screen] { return (o.kind == "web", o.path ?? tabs.first { $0.id == screen }?.path) }
        if let t = tabs.first(where: { $0.id == screen }) { return (t.isWeb, t.path) }
        return (false, nil)
    }

    public func interval(_ key: String, default d: Double) -> Duration {
        let ms = polling[key] ?? d
        return .milliseconds(Int(max(250, ms)))
    }
    public func limit(_ key: String, default d: Double) -> Double { limits[key] ?? d }

    public func defaultString(_ key: String) -> String? { defaults[key]?.string }
    public func defaultDouble(_ key: String) -> Double? { defaults[key]?.double }
    public func defaultList(_ key: String) -> [String] { (defaults[key]?.array ?? []).compactMap(\.string) }
    public var filmDefaults: [String: JSONValue] { defaults["film"]?.object ?? [:] }
    public var hiddenProviders: Set<String> { Set(defaultList("hiddenProviders")) }

    public enum UpdateState: Equatable { case current, available(String), required(String) }
    public func updateState(appVersion: String) -> UpdateState {
        AppConfig.updateState(appVersion: appVersion, min: minVersion, latest: latestVersion)
    }
    public static func updateState(appVersion: String, min: String, latest: String) -> UpdateState {
        if VersionNumber(appVersion) < VersionNumber(min) { return .required(min) }
        if VersionNumber(appVersion) < VersionNumber(latest) { return .available(latest) }
        return .current
    }

    // MARK: Fallback

    /// The defaults bundled with the app (identical to engine/lib/appconfig.js), used before the first fetch.
    public static let fallback: AppConfig = fallbackOrNil ?? AppConfig.empty
    static let bareKey = CodingUserInfoKey(rawValue: "filmstudio.bareConfig")!
    private static var bareDecoder: JSONDecoder { let d = JSONDecoder(); d.userInfo[bareKey] = true; return d }
    private static let fallbackOrNil: AppConfig? = {
        guard let url = Bundle.module.url(forResource: "default-app-config", withExtension: "json"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? bareDecoder.decode(AppConfig.self, from: data)
    }()
    private static let empty: AppConfig = {
        // Only reachable if the bundled resource is missing; keeps the app usable.
        try! bareDecoder.decode(AppConfig.self, from: Data(#"{"tabs":[{"id":"library","title":"Library","sfSymbol":"photo.on.rectangle.angled"},{"id":"create","title":"Create","sfSymbol":"wand.and.stars"},{"id":"films","title":"Films","sfSymbol":"film.stack"},{"id":"settings","title":"Settings","sfSymbol":"gearshape"}]}"#.utf8))
    }()
}

/// Dotted version numbers ("1.2.10" > "1.2.9"); missing components count as zero.
public struct VersionNumber: Comparable, Sendable {
    public let parts: [Int]
    public init(_ s: String) { parts = s.split(whereSeparator: { !$0.isNumber }).map { Int($0) ?? 0 } }
    public static func < (a: VersionNumber, b: VersionNumber) -> Bool {
        for i in 0..<max(a.parts.count, b.parts.count) {
            let x = i < a.parts.count ? a.parts[i] : 0, y = i < b.parts.count ? b.parts[i] : 0
            if x != y { return x < y }
        }
        return false
    }
    public static func == (a: VersionNumber, b: VersionNumber) -> Bool { !(a < b) && !(b < a) }
}

extension String {
    /// Deterministic short hash (FNV-1a) for ids derived from content, stable across launches.
    var stableHash: String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(h, radix: 36)
    }
}

/// Last good config per server, so the app starts with the server's choices even when offline.
public struct ConfigCache: Sendable {
    public let directory: URL
    public init(directory: URL) { self.directory = directory }
    public static var standard: ConfigCache {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return ConfigCache(directory: base.appendingPathComponent("FilmStudio/config", isDirectory: true))
    }
    private func file(_ server: URL) -> URL { directory.appendingPathComponent("app-config-\(server.absoluteString.stableHash).json") }
    public func load(server: URL) -> AppConfig? {
        guard let data = try? Data(contentsOf: file(server)) else { return nil }
        return try? JSONDecoder().decode(AppConfig.self, from: data)
    }
    public func save(_ data: Data, server: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file(server), options: .atomic)
    }
}
