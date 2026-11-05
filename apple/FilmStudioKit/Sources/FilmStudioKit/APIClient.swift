import Foundation

public enum APIError: Error, LocalizedError, Equatable, Sendable {
    case unauthorized(String)
    case notFound(String)
    case server(status: Int, message: String)
    case transport(String)
    case decoding(String)
    case invalidResponse

    public var errorDescription: String? {
        switch self {
        case .unauthorized: "Your session has expired. Sign in again."
        case .notFound(let m): m.isEmpty ? "Not found." : m.prefix(1).uppercased() + m.dropFirst()
        case .server(let status, let m): m.isEmpty ? "The studio answered \(status)." : m
        case .transport(let m): m
        case .decoding(let m): "The studio sent something this app version can't read (\(m))."
        case .invalidResponse: "The studio sent an invalid response."
        }
    }
    public var status: Int? {
        switch self {
        case .unauthorized: 401
        case .notFound: 404
        case .server(let s, _): s
        default: nil
        }
    }
    /// The engine answers unknown routes with 404 "no such route" — the feature is not deployed yet.
    public var isMissingRoute: Bool { if case .notFound(let m) = self { return m.isEmpty || m.localizedCaseInsensitiveContains("no such route") }; return false }
    public var isUnauthorized: Bool { if case .unauthorized = self { return true }; return false }
}

/// Things the client reports to the app: expired sessions and failures for remote diagnostics.
public enum APIEvent: Sendable {
    case unauthorized(route: String)
    case requestFailed(method: String, route: String, status: Int?, message: String)
    case decodeFailed(route: String, message: String)
}

/// Talks to the engine under `<server>/engine/api`. Sends the session as `Authorization: Bearer`.
public final class APIClient: Sendable {
    public let baseURL: URL
    public let session: URLSession
    private let tokenProvider: @Sendable () -> String?
    private let onEvent: @Sendable (APIEvent) -> Void

    public init(baseURL: URL, session: URLSession = APIClient.makeSession(), token: @escaping @Sendable () -> String?, onEvent: @escaping @Sendable (APIEvent) -> Void = { _ in }) {
        self.baseURL = baseURL
        self.session = session
        self.tokenProvider = token
        self.onEvent = onEvent
    }

    public static func makeSession() -> URLSession {
        let c = URLSessionConfiguration.default
        c.timeoutIntervalForRequest = 60
        c.timeoutIntervalForResource = 60 * 30
        c.waitsForConnectivity = false
        c.httpCookieStorage = nil // auth is the Bearer header only
        c.httpShouldSetCookies = false
        c.urlCache = URLCache(memoryCapacity: 48 << 20, diskCapacity: 768 << 20, directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("FilmStudioHTTP"))
        return URLSession(configuration: c)
    }

    public var token: String? { tokenProvider() }

    // MARK: URLs

    /// `<server>/engine/api<path>` (path starts with "/"); also accepts full "/engine/..." paths.
    public func apiURL(_ path: String, query: [URLQueryItem] = []) -> URL {
        let full = path.hasPrefix("/engine/") ? path : "/engine/api" + (path.hasPrefix("/") ? path : "/" + path)
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let (p, q) = Self.split(full)
        c.percentEncodedPath = c.percentEncodedPath.trimmingSuffix("/") + p
        var items = q
        items.append(contentsOf: query)
        c.queryItems = items.isEmpty ? nil : items
        return c.url!
    }

    private static func split(_ path: String) -> (String, [URLQueryItem]) {
        guard let i = path.firstIndex(of: "?") else { return (path, []) }
        let q = URLComponents(string: "x:/" + path[i...])?.queryItems ?? []
        return (String(path[..<i]), q)
    }

    /// Resolves a media URL from the engine ("/engine/media/a_1.jpg" or absolute).
    public func resolve(_ string: String?) -> URL? {
        guard let s = string?.nonEmpty else { return nil }
        if s.hasPrefix("http://") || s.hasPrefix("https://") { return URL(string: s) }
        return URL(string: s, relativeTo: baseURL)?.absoluteURL
    }

    /// Whether a URL points at this engine (so it gets the Bearer token, and nothing else does).
    public func isEngineURL(_ url: URL) -> Bool {
        url.host?.lowercased() == baseURL.host?.lowercased() && url.port == baseURL.port && url.scheme == baseURL.scheme
    }

    public func authorized(_ url: URL) -> URLRequest {
        var r = URLRequest(url: url)
        if isEngineURL(url), let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        return r
    }

    // MARK: Core

    public func makeRequest(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil, contentType: String? = "application/json") -> URLRequest {
        var r = URLRequest(url: apiURL(path, query: query))
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let t = token { r.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }
        if let body {
            r.httpBody = body
            if let contentType { r.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        }
        return r
    }

    /// Sends a request and returns the body of a 2xx response; maps everything else to `APIError`.
    public func perform(_ request: URLRequest, route: String, report: Bool = true, upload file: URL? = nil) async throws -> Data {
        let method = request.httpMethod ?? "GET"
        let data: Data, response: URLResponse
        do {
            if let file { (data, response) = try await session.upload(for: request, fromFile: file) }
            else { (data, response) = try await session.data(for: request) }
        } catch {
            if Task.isCancelled || (error as? URLError)?.code == .cancelled { throw CancellationError() }
            let msg = Self.describe(error)
            if report { onEvent(.requestFailed(method: method, route: route, status: nil, message: msg)) }
            throw APIError.transport(msg)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        if (200..<300).contains(http.statusCode) { return data }
        let message = Self.errorMessage(data) ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
        switch http.statusCode {
        case 401:
            onEvent(.unauthorized(route: route))
            throw APIError.unauthorized(message)
        case 404:
            throw APIError.notFound(message)
        default:
            if report { onEvent(.requestFailed(method: method, route: route, status: http.statusCode, message: message)) }
            throw APIError.server(status: http.statusCode, message: message)
        }
    }

    public func decode<T: Decodable>(_ type: T.Type, from data: Data, route: String) throws -> T {
        do { return try JSONDecoder().decode(T.self, from: data) } catch {
            let msg = Self.describe(decoding: error)
            onEvent(.decodeFailed(route: route, message: msg))
            throw APIError.decoding(msg)
        }
    }

    public func get<T: Decodable>(_ path: String, query: [URLQueryItem] = [], as type: T.Type = T.self) async throws -> T {
        let data = try await perform(makeRequest("GET", path, query: query), route: path)
        return try decode(T.self, from: data, route: path)
    }

    @discardableResult
    public func send<T: Decodable>(_ method: String, _ path: String, json: [String: JSONValue]? = [:], as type: T.Type = T.self) async throws -> T {
        let body = try json.map { try JSONEncoder().encode($0) }
        let data = try await perform(makeRequest(method, path, body: body), route: path)
        return try decode(T.self, from: data, route: path)
    }

    /// Sends a request whose response body the app does not need.
    public func call(_ method: String, _ path: String, json: [String: JSONValue]? = [:]) async throws {
        let body = try json.map { try JSONEncoder().encode($0) }
        _ = try await perform(makeRequest(method, path, body: body), route: path)
    }

    static func errorMessage(_ data: Data) -> String? {
        if let o = try? JSONDecoder().decode([String: JSONValue].self, from: data) {
            return o["error"]?.string ?? o["message"]?.string
        }
        let s = String(decoding: data.prefix(300), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty || s.hasPrefix("<") ? nil : s
    }

    static func describe(_ error: Error) -> String {
        guard let u = error as? URLError else { return error.localizedDescription }
        switch u.code {
        case .notConnectedToInternet, .networkConnectionLost: return "You're offline."
        case .timedOut: return "The studio took too long to answer."
        case .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed: return "Can't reach the studio server."
        case .secureConnectionFailed, .serverCertificateUntrusted, .serverCertificateHasBadDate: return "The studio's secure connection failed."
        case .appTransportSecurityRequiresSecureConnection: return "Only https servers (or localhost) are allowed."
        default: return u.localizedDescription
        }
    }

    static func describe(decoding error: Error) -> String {
        guard let e = error as? DecodingError else { return error.localizedDescription }
        func path(_ c: DecodingError.Context) -> String { c.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".") }
        switch e {
        case .keyNotFound(let k, let c): return "missing \(path(c)).\(k.stringValue)"
        case .typeMismatch(_, let c), .valueNotFound(_, let c): return "unexpected value at \(path(c)): \(c.debugDescription)"
        case .dataCorrupted(let c): return "invalid data at \(path(c)): \(c.debugDescription)"
        @unknown default: return e.localizedDescription
        }
    }
}

// MARK: - Endpoints

public extension APIClient {
    func health() async throws -> Health {
        let data = try await perform(makeRequest("GET", "/health"), route: "/health", report: false)
        return try decode(Health.self, from: data, route: "/health")
    }
    func appVersion() async throws -> AppVersionInfo {
        let data = try await perform(makeRequest("GET", "/app/version"), route: "/app/version", report: false)
        return try decode(AppVersionInfo.self, from: data, route: "/app/version")
    }
    /// The config plus its raw bytes (cached as-is for the next launch).
    func appConfig() async throws -> (AppConfig, Data) {
        let data = try await perform(makeRequest("GET", "/app/config"), route: "/app/config")
        return (try decode(AppConfig.self, from: data, route: "/app/config"), data)
    }
    func postLog(_ entries: [DiagnosticEntry], device: DeviceInfo) async throws {
        let body = try JSONEncoder().encode(DiagnosticBatch(device: device, entries: entries))
        _ = try await perform(makeRequest("POST", "/app/log", body: body), route: "/app/log", report: false)
    }
    func logout() async { _ = try? await perform(makeRequest("POST", "/logout", body: Data("{}".utf8)), route: "/logout", report: false) }

    func status() async throws -> StatusReport { try await get("/status") }
    func catalog() async throws -> Catalog { try await get("/catalog") }
    func sound() async throws -> SoundCatalog { try await get("/sound") }

    func media() async throws -> [MediaItem] { try await get("/media", as: LossyList<MediaItem>.self).items }
    func hideMedia(_ id: String) async throws { try await call("DELETE", "/media/\(id.pathSegment)", json: nil) }

    /// Raw upload (POST /upload?name=…); files are streamed from disk.
    func upload(file: URL, name: String? = nil, mimeType: String) async throws -> UploadedAsset {
        let filename = name ?? file.lastPathComponent
        var r = makeRequest("POST", "/upload", query: [URLQueryItem(name: "name", value: filename)], body: nil)
        r.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        r.timeoutInterval = 600
        let data = try await perform(r, route: "/upload", upload: file)
        return try decode(UploadedAsset.self, from: data, route: "/upload")
    }
    func upload(data body: Data, name: String, mimeType: String) async throws -> UploadedAsset {
        var r = makeRequest("POST", "/upload", query: [URLQueryItem(name: "name", value: name)], body: body, contentType: mimeType)
        r.timeoutInterval = 600
        let data = try await perform(r, route: "/upload")
        return try decode(UploadedAsset.self, from: data, route: "/upload")
    }

    func generate(_ request: GenerateRequest) async throws -> Job { try await send("POST", "/generate", json: request.json) }
    func job(_ id: String) async throws -> Job { try await get("/jobs/\(id.pathSegment)") }
    func cancelJob(_ id: String) async throws { try await call("POST", "/jobs/\(id.pathSegment)/cancel") }

    /// Polls a job until it finishes. Transient network errors are retried; returns the finished job.
    func waitForJob(_ id: String, every interval: Duration, onUpdate: @Sendable (Job) async -> Void = { _ in }) async throws -> Job {
        var failures = 0
        while true {
            try Task.checkCancellation()
            do {
                let j = try await job(id)
                failures = 0
                await onUpdate(j)
                if j.status.isFinished { return j }
            } catch let e as APIError {
                if case .transport = e, failures < 20 { failures += 1 } else { throw e }
            }
            try await Task.sleep(for: interval)
        }
    }

    // Long-form productions
    func productions() async throws -> [ProductionSummary] { try await get("/productions", as: LossyList<ProductionSummary>.self).items }
    func production(_ id: String) async throws -> Production { try await get("/productions/\(id.pathSegment)") }
    func createProduction(_ brief: [String: JSONValue]) async throws -> Production { try await send("POST", "/productions", json: brief) }
    func updateProduction(_ id: String, _ patch: [String: JSONValue]) async throws -> Production { try await send("PATCH", "/productions/\(id.pathSegment)", json: patch) }
    func deleteProduction(_ id: String) async throws { try await call("DELETE", "/productions/\(id.pathSegment)", json: nil) }
    func productionAction(_ id: String, _ action: String) async throws -> Production { try await send("POST", "/productions/\(id.pathSegment)/\(action)") }
    func updateShot(_ id: String, _ shot: String, _ patch: [String: JSONValue]) async throws -> Production {
        try await send("PATCH", "/productions/\(id.pathSegment)/shots/\(shot.pathSegment)", json: patch)
    }
    func deleteShot(_ id: String, _ shot: String) async throws -> Production { try await send("DELETE", "/productions/\(id.pathSegment)/shots/\(shot.pathSegment)", json: nil) }

    // Characters (contract; the route may not be deployed yet → APIError.notFound "no such route")
    func characters() async throws -> [StudioCharacter] { try await get("/characters", as: LossyList<StudioCharacter>.self).items }
    func character(_ id: String) async throws -> StudioCharacter? { try await characters().first { $0.id == id } }
    func createCharacter(name: String, description: String, lookNotes: String) async throws -> StudioCharacter? {
        let data = try await perform(makeRequest("POST", "/characters", body: try JSONEncoder().encode(["name": name, "description": description, "lookNotes": lookNotes])), route: "/characters")
        return try? JSONDecoder().decode(StudioCharacter.self, from: data)
    }
    func updateCharacter(_ id: String, _ patch: [String: JSONValue]) async throws { try await call("PATCH", "/characters/\(id.pathSegment)", json: patch) }
    func deleteCharacter(_ id: String) async throws { try await call("DELETE", "/characters/\(id.pathSegment)", json: nil) }
    func addCharacterRefs(_ id: String, assetIds: [String], angle: String? = nil) async throws {
        var body: [String: JSONValue] = ["assetIds": JSONValue(assetIds)]
        if let angle { body["angle"] = .string(angle) }
        try await call("POST", "/characters/\(id.pathSegment)/refs", json: body)
    }
    func deleteCharacterRef(_ id: String, assetId: String) async throws { try await call("DELETE", "/characters/\(id.pathSegment)/refs/\(assetId.pathSegment)", json: nil) }
    func coverage(_ id: String) async throws -> Coverage { try await get("/characters/\(id.pathSegment)/coverage") }
    /// Starts a character sheet; returns the job id to poll.
    func makeCharacterSheet(_ id: String) async throws -> String {
        let v: JSONValue = try await send("POST", "/characters/\(id.pathSegment)/sheet")
        guard let job = v["jobId"]?.string ?? v["id"]?.string else { throw APIError.invalidResponse }
        return job
    }
    func approveCharacterSheet(_ id: String) async throws { try await call("POST", "/characters/\(id.pathSegment)/sheet/approve") }

    // Server-defined tools
    func tools() async throws -> [Tool] {
        let v: JSONValue = try await get("/tools")
        // Accept a bare array or { tools: [...] }.
        let list = v.array ?? v["tools"]?.array ?? []
        let data = try JSONEncoder().encode(JSONValue.array(list))
        return try decode(LossyList<Tool>.self, from: data, route: "/tools").items
    }
    /// Runs a tool; resolves `{ jobId }`, a job object, or an immediate `{ url }` result into a `Job`.
    func runTool(_ tool: Tool, values: [String: JSONValue]) async throws -> Job {
        let method = tool.run.method
        let body = method == "GET" ? nil : try JSONEncoder().encode(values)
        let route = tool.run.path
        let data = try await perform(makeRequest(method, route, body: body), route: route)
        let v = try decode(JSONValue.self, from: data, route: route)
        if let jobId = v["jobId"]?.string, v["status"] == nil { return try await job(jobId) }
        if v["id"]?.string != nil || v["jobId"]?.string != nil, let j = try? JSONDecoder().decode(Job.self, from: data) { return j }
        if let url = v["url"]?.string { return Job(id: "inline-\(UUID().uuidString)", status: .done, url: url, posterUrl: v["posterUrl"]?.string, kind: v["kind"]?.string) }
        throw APIError.decoding("the tool returned neither a job nor a result")
    }
}

/// POST /generate body.
public struct GenerateRequest: Sendable, Equatable {
    public var model: String
    public var prompt: String
    public var aspect: String?
    public var duration: Double?
    public var resolution: String?
    public var startImage: String? // engine asset id or /engine/media URL
    public var endImage: String?
    public var references: [String] = []
    public var characters: [String] = []
    public var seed: Int?

    public init(model: String, prompt: String, aspect: String? = nil, duration: Double? = nil, resolution: String? = nil, startImage: String? = nil, endImage: String? = nil, references: [String] = [], characters: [String] = [], seed: Int? = nil) {
        self.model = model; self.prompt = prompt; self.aspect = aspect; self.duration = duration; self.resolution = resolution
        self.startImage = startImage; self.endImage = endImage; self.references = references; self.characters = characters; self.seed = seed
    }

    public var json: [String: JSONValue] {
        var o: [String: JSONValue] = ["model": .string(model), "prompt": .string(prompt)]
        if let aspect { o["aspect_ratio"] = .string(aspect) }
        if let duration { o["duration"] = .number(duration) }
        if let resolution { o["resolution"] = .string(resolution) }
        if let startImage { o["image_url"] = .string(startImage) }
        if let endImage { o["end_image_url"] = .string(endImage) }
        if !references.isEmpty { o["images_list"] = JSONValue(references) }
        if !characters.isEmpty { o["characters"] = JSONValue(characters) }
        if let seed { o["seed"] = .number(Double(seed)) }
        return o
    }
}

extension String {
    func trimmingSuffix(_ s: String) -> String { hasSuffix(s) ? String(dropLast(s.count)) : self }
}
