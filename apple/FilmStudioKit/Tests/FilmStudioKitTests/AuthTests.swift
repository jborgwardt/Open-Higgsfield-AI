import Foundation
import Testing
@testable import FilmStudioKit

@Suite struct NativeSignInTests {
    let server = URL(string: "https://films.heil.haus")!

    @Test func startURL() {
        let state = NativeSignIn.newState()
        #expect(state.count >= 30 && !state.contains("+") && !state.contains("/") && !state.contains("="))
        #expect(NativeSignIn.startURL(server: server, state: "abc").absoluteString == "https://films.heil.haus/engine/auth/native?state=abc")
        #expect(NativeSignIn.startURL(server: URL(string: "http://127.0.0.1:4951/")!, state: "x").absoluteString == "http://127.0.0.1:4951/engine/auth/native?state=x")
    }

    @Test func acceptsOnlyOurCallbackWithMatchingState() throws {
        #expect(try NativeSignIn.session(from: URL(string: "filmstudio://auth?session=SeSsIoN_1&state=abc")!, expectedState: "abc") == "SeSsIoN_1")
        #expect(throws: NativeSignIn.Failure.stateMismatch) { try NativeSignIn.session(from: URL(string: "filmstudio://auth?session=x&state=evil")!, expectedState: "abc") }
        #expect(throws: NativeSignIn.Failure.stateMismatch) { try NativeSignIn.session(from: URL(string: "filmstudio://auth?session=x")!, expectedState: "abc") }
        #expect(throws: NativeSignIn.Failure.notOurCallback) { try NativeSignIn.session(from: URL(string: "otherapp://auth?session=x&state=abc")!, expectedState: "abc") }
        #expect(throws: NativeSignIn.Failure.notOurCallback) { try NativeSignIn.session(from: URL(string: "filmstudio://evil?session=x&state=abc")!, expectedState: "abc") }
        #expect(throws: NativeSignIn.Failure.noSession) { try NativeSignIn.session(from: URL(string: "filmstudio://auth?state=abc")!, expectedState: "abc") }
        #expect(throws: NativeSignIn.Failure.server("mallory@example.com is not allowed to use this studio")) {
            try NativeSignIn.session(from: URL(string: "filmstudio://auth?error=mallory%40example.com%20is%20not%20allowed%20to%20use%20this%20studio&state=abc")!, expectedState: "abc")
        }
        // An error for someone else's attempt is not shown verbatim.
        #expect(throws: NativeSignIn.Failure.stateMismatch) { try NativeSignIn.session(from: URL(string: "filmstudio://auth?error=Pay%20here&state=zzz")!, expectedState: "abc") }
    }
}

@Suite struct ServerAddressTests {
    @Test(arguments: [
        ("films.heil.haus", "https://films.heil.haus"),
        ("https://films.heil.haus/", "https://films.heil.haus"),
        ("  HTTPS://Films.Heil.Haus/engine/api/health?x=1  ", "https://films.heil.haus"),
        ("localhost:4848", "http://localhost:4848"),
        ("127.0.0.1:4951", "http://127.0.0.1:4951"),
        ("http://127.0.0.1:4951/", "http://127.0.0.1:4951"),
        ("https://example.com/studio/", "https://example.com/studio"),
    ])
    func parses(input: String, expected: String) throws {
        #expect(try ServerAddress.parse(input).absoluteString == expected)
    }

    @Test func rejects() {
        #expect(throws: ServerAddress.Problem.empty) { try ServerAddress.parse("  ") }
        #expect(throws: ServerAddress.Problem.insecure) { try ServerAddress.parse("http://films.heil.haus") }
        #expect(throws: ServerAddress.Problem.invalid) { try ServerAddress.parse("ftp://x") }
        #expect(ServerAddress.isLocal(URL(string: "http://localhost:4848")!) && !ServerAddress.isLocal(ServerAddress.defaultURL))
    }

    @Test func memoryTokenStore() {
        let s = MemoryTokenStore()
        let a = URL(string: "https://a.example")!, b = URL(string: "http://localhost:1")!
        s.setToken("t1", for: a)
        #expect(s.token(for: a) == "t1" && s.token(for: b) == nil)
        s.setToken(nil, for: a)
        #expect(s.token(for: a) == nil)
    }
}

@Suite struct DiagnosticsTests {
    final class Box: @unchecked Sendable {
        private var _batches: [[DiagnosticEntry]] = []
        private var _fail = false
        private let lock = NSLock()
        var batches: [[DiagnosticEntry]] { lock.withLock { _batches } }
        var fail: Bool { get { lock.withLock { _fail } } set { lock.withLock { _fail = newValue } } }
        func send(_ e: [DiagnosticEntry]) throws { try lock.withLock { if _fail { throw APIError.transport("offline") }; _batches.append(e) } }
    }
    let device = DeviceInfo(app: "1.0.0", build: "1", device: "Mac", os: "macOS 27", platform: "macOS", install: "x")

    @Test func queuesPersistsAndFlushes() async {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let box = Box()
        box.fail = true
        let r = DiagnosticsReporter(file: file, device: device)
        await r.configure(enabled: true, sender: { entries, _ in try box.send(entries) })
        await r.record(DiagnosticEntry(kind: "request", message: "boom", route: "/media", status: 500))
        await r.record(DiagnosticEntry(kind: "request", message: "boom", route: "/media", status: 500)) // duplicate burst → dropped
        await r.record(DiagnosticEntry(kind: "decode", message: "bad", route: "/catalog"))
        #expect(await r.flush() == false)
        #expect(await r.pending.count == 2)

        // A new reporter (next launch) still has them on disk.
        let r2 = DiagnosticsReporter(file: file, device: device)
        #expect(await r2.pending.count == 2)
        box.fail = false
        await r2.configure(enabled: true, sender: { entries, _ in try box.send(entries) })
        #expect(await r2.flush() == true)
        #expect(await r2.pending.isEmpty)
        #expect(box.batches.flatMap { $0 }.map(\.route) == ["/media", "/catalog"])
    }

    @Test func disabledKeepsQueue() async {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("diag-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let r = DiagnosticsReporter(file: file, device: device)
        await r.configure(enabled: false, sender: { _, _ in Issue.record("must not send when disabled") })
        await r.record(DiagnosticEntry(kind: "event", message: "x"))
        await r.flush()
        #expect(await r.pending.count == 1)
    }

    @Test func crashSentinelNames() {
        #expect(CrashSentinel.signalName("signal 11") == "SIGSEGV")
        #expect(CrashSentinel.signalName("signal 05") == "SIGTRAP (Swift runtime error)")
        #expect(CrashSentinel.signalName("exception NSRangeException: x\nstack") == "exception NSRangeException: x")
    }
}
