import Foundation
import Testing
@testable import FilmStudioKit

/// Intercepts every request of a stubbed URLSession.
final class StubProtocol: URLProtocol, @unchecked Sendable {
    struct Reply { var status = 200; var body = "{}"; var headers: [String: String] = ["Content-Type": "application/json"] }
    nonisolated(unsafe) static var handler: (URLRequest, Data) -> Reply = { _, _ in Reply() }
    nonisolated(unsafe) static var requests: [(URLRequest, Data)] = []
    static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        var body = request.httpBody ?? Data()
        if body.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buf = [UInt8](repeating: 0, count: 65536)
            while stream.hasBytesAvailable { let n = stream.read(&buf, maxLength: buf.count); if n <= 0 { break }; body.append(buf, count: n) }
            stream.close()
        }
        StubProtocol.lock.lock()
        StubProtocol.requests.append((request, body))
        let reply = StubProtocol.handler(request, body)
        StubProtocol.lock.unlock()
        let resp = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers)!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}

    static func reset(_ h: @escaping (URLRequest, Data) -> Reply) { lock.lock(); handler = h; requests = []; lock.unlock() }
    static var last: (URLRequest, Data)? { lock.lock(); defer { lock.unlock() }; return requests.last }
    static var all: [(URLRequest, Data)] { lock.lock(); defer { lock.unlock() }; return requests }
}

final class EventLog: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [APIEvent] = []
    func add(_ e: APIEvent) { lock.lock(); items.append(e); lock.unlock() }
    var events: [APIEvent] { lock.lock(); defer { lock.unlock() }; return items }
}

private func makeClient(base: String = "https://films.heil.haus", token: String? = "tok123", events: EventLog = EventLog()) -> APIClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    return APIClient(baseURL: URL(string: base)!, session: URLSession(configuration: config), token: { token }, onEvent: { events.add($0) })
}

private func json(_ data: Data) -> [String: JSONValue] { (try? JSONDecoder().decode([String: JSONValue].self, from: data)) ?? [:] }

@Suite(.serialized) struct APIClientTests {
    @Test func urlsAndBearer() async throws {
        StubProtocol.reset { _, _ in .init(body: "[]") }
        let c = makeClient(base: "https://example.com/studio")
        #expect(c.apiURL("/media").absoluteString == "https://example.com/studio/engine/api/media")
        #expect(c.apiURL("/upload", query: [.init(name: "name", value: "a b.jpg")]).absoluteString == "https://example.com/studio/engine/api/upload?name=a%20b.jpg")
        #expect(c.apiURL("/engine/api/tools/x/run?fast=1").absoluteString == "https://example.com/studio/engine/api/tools/x/run?fast=1")
        #expect(c.resolve("/engine/media/a.jpg")?.absoluteString == "https://example.com/engine/media/a.jpg")
        #expect(c.resolve("https://cdn.example/x.jpg")?.absoluteString == "https://cdn.example/x.jpg")
        _ = try await c.media()
        let req = try #require(StubProtocol.last?.0)
        #expect(req.value(forHTTPHeaderField: "Authorization") == "Bearer tok123")
        #expect(req.httpMethod == "GET")
        // The token is only sent to the engine's own host.
        #expect(c.authorized(URL(string: "https://example.com/engine/media/a.jpg")!).value(forHTTPHeaderField: "Authorization") == "Bearer tok123")
        #expect(c.authorized(URL(string: "https://evil.example/a.jpg")!).value(forHTTPHeaderField: "Authorization") == nil)
        #expect(c.authorized(URL(string: "http://example.com/a.jpg")!).value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func noTokenNoHeader() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"ok":true,"auth":false,"authed":true}"#) }
        let h = try await makeClient(base: "http://127.0.0.1:4951", token: nil).health()
        #expect(h.authed)
        #expect(StubProtocol.last?.0.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func unauthorizedIsReported() async {
        StubProtocol.reset { _, _ in .init(status: 401, body: #"{"error":"access code required","auth":true}"#) }
        let log = EventLog()
        await #expect(throws: APIError.unauthorized("access code required")) { try await makeClient(events: log).productions() }
        guard case .unauthorized(let route) = log.events.first else { Issue.record("no unauthorized event"); return }
        #expect(route == "/productions")
    }

    @Test func missingRouteMeansNotDeployed() async {
        StubProtocol.reset { _, _ in .init(status: 404, body: #"{"error":"no such route"}"#) }
        let log = EventLog()
        do { _ = try await makeClient(events: log).characters(); Issue.record("expected 404") } catch let e as APIError {
            #expect(e.isMissingRoute)
        } catch { Issue.record("unexpected \(error)") }
        #expect(log.events.isEmpty, "404s are expected while features roll out, not reported")
        #expect(!APIError.notFound("production not found").isMissingRoute)
    }

    @Test func serverErrorsAndDecodeFailuresAreReported() async {
        StubProtocol.reset { req, _ in req.url!.path.hasSuffix("/catalog") ? .init(body: "[1,2]") : .init(status: 500, body: #"{"error":"ffmpeg exploded"}"#) }
        let log = EventLog()
        let c = makeClient(events: log)
        await #expect(throws: APIError.server(status: 500, message: "ffmpeg exploded")) { _ = try await c.productionAction("prod_1", "assemble") }
        await #expect(throws: APIError.self) { _ = try await c.catalog() }
        let kinds = log.events.map { e -> String in
            switch e { case .requestFailed(let m, let r, let s, let msg): "\(m) \(r) \(s ?? 0) \(msg)"; case .decodeFailed(let r, _): "decode \(r)"; case .unauthorized: "401" }
        }
        #expect(kinds == ["POST /productions/prod_1/assemble 500 ffmpeg exploded", "decode /catalog"])
    }

    @Test func generateBody() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"id":"j_1","status":"running","message":"Starting","progress":null}"#) }
        let job = try await makeClient().generate(GenerateRequest(model: "local/animatic", prompt: "a fox", aspect: "9:16", duration: 6, startImage: "a_1", endImage: "a_2", references: ["a_3"], characters: ["ch_1"]))
        #expect(job.id == "j_1")
        let (req, body) = try #require(StubProtocol.last)
        #expect(req.httpMethod == "POST" && req.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let o = json(body)
        #expect(o["model"] == "local/animatic" && o["aspect_ratio"] == "9:16" && o["duration"] == 6 && o["image_url"] == "a_1" && o["end_image_url"] == "a_2")
        #expect(o["images_list"] == ["a_3"] && o["characters"] == ["ch_1"] && o["resolution"] == nil)
    }

    @Test func uploadSendsRawBytes() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"id":"a_5","url":"/engine/media/a_5.png","kind":"image","mime":"image/png"}"#) }
        let asset = try await makeClient().upload(data: Data([1, 2, 3]), name: "dot.png", mimeType: "image/png")
        #expect(asset.id == "a_5")
        let (req, body) = try #require(StubProtocol.last)
        #expect(req.url?.query == "name=dot.png" && req.value(forHTTPHeaderField: "Content-Type") == "image/png" && body == Data([1, 2, 3]))
    }

    @Test func waitForJobPolls() async throws {
        let calls = EventLog()
        StubProtocol.reset { _, _ in
            let n = StubProtocol.requests.count
            return .init(body: n < 3 ? #"{"id":"j_1","status":"running","progress":\#(n * 30)}"# : #"{"id":"j_1","status":"done","url":"/engine/media/out.mp4"}"#)
        }
        _ = calls
        let seen = EventLog()
        let done = try await makeClient().waitForJob("j_1", every: .milliseconds(10)) { j in seen.add(.decodeFailed(route: j.status.rawValue, message: "")) }
        #expect(done.status == .done && done.url == "/engine/media/out.mp4")
        #expect(StubProtocol.all.count == 3)
        #expect(seen.events.count == 3)
    }

    @Test func runToolVariants() async throws {
        let tool = try JSONDecoder().decode(Tool.self, from: Data(#"{"id":"upscale","run":{"method":"POST","path":"/tools/upscale/run"},"inputs":[]}"#.utf8))
        // { jobId } → fetches the job
        StubProtocol.reset { req, _ in req.url!.path.hasSuffix("/run") ? .init(body: #"{"jobId":"j_9"}"#) : .init(body: #"{"id":"j_9","status":"running"}"#) }
        var j = try await makeClient().runTool(tool, values: ["image": "a_1", "factor": "2"])
        #expect(j.id == "j_9")
        #expect(StubProtocol.all.map { $0.0.url!.path } == ["/engine/api/tools/upscale/run", "/engine/api/jobs/j_9"])
        #expect(json(StubProtocol.all[0].1) == ["image": "a_1", "factor": "2"])
        // a job object
        StubProtocol.reset { _, _ in .init(body: #"{"id":"j_10","status":"running","message":"Queued"}"#) }
        j = try await makeClient().runTool(tool, values: [:])
        #expect(j.id == "j_10" && StubProtocol.all.count == 1)
        // an immediate result
        StubProtocol.reset { _, _ in .init(body: #"{"url":"/engine/media/x.jpg"}"#) }
        j = try await makeClient().runTool(tool, values: [:])
        #expect(j.status == .done && j.url == "/engine/media/x.jpg")
    }

    @Test func toolsListShapes() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"tools":[{"id":"a"},{"bad":1},{"id":"b","inputs":[{"key":"x","type":"text"}]}]}"#) }
        #expect(try await makeClient().tools().map(\.id) == ["a", "b"])
        StubProtocol.reset { _, _ in .init(body: #"[{"id":"c"}]"#) }
        #expect(try await makeClient().tools().map(\.id) == ["c"])
    }

    @Test func characterEndpoints() async throws {
        StubProtocol.reset { req, _ in
            switch (req.httpMethod!, req.url!.path) {
            case ("POST", "/engine/api/characters/ch 1/sheet"): .init(body: #"{"jobId":"j_s"}"#)
            default: .init(body: #"{"ok":true}"#)
            }
        }
        let c = makeClient()
        try await c.addCharacterRefs("ch 1", assetIds: ["a_1", "a_2"], angle: "front")
        #expect(StubProtocol.last?.0.url?.absoluteString == "https://films.heil.haus/engine/api/characters/ch%201/refs")
        #expect(json(StubProtocol.last!.1) == ["assetIds": ["a_1", "a_2"], "angle": "front"])
        #expect(try await c.makeCharacterSheet("ch 1") == "j_s")
    }

    @Test func diagnosticsBatchFormat() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"ok":true,"stored":1}"#) }
        let device = DeviceInfo(app: "1.0.0", build: "3", device: "iPhone18,1", os: "iOS 27.0", platform: "iOS", install: "i1")
        try await makeClient().postLog([DiagnosticEntry(kind: "request", message: "boom", route: "/media", method: "GET", status: 500)], device: device)
        let o = json(StubProtocol.last!.1)
        #expect(o["device"]?["device"] == "iPhone18,1")
        #expect(o["entries"]?.array?.first?["route"] == "/media" && o["entries"]?.array?.first?["status"] == 500)
    }
}
