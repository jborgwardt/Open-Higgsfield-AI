import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// One diagnostics record sent to POST /engine/api/app/log.
public struct DiagnosticEntry: Codable, Sendable, Equatable {
    public var at: String
    public var level: String // debug | info | warn | error | crash
    public var kind: String // request | decode | crash | error | event
    public var message: String
    public var route: String?
    public var method: String?
    public var status: Int?
    public var screen: String?
    public var detail: String?

    public init(level: String = "error", kind: String, message: String, route: String? = nil, method: String? = nil, status: Int? = nil, screen: String? = nil, detail: String? = nil, at: Date = Date()) {
        self.at = ISODate.string(at); self.level = level; self.kind = kind; self.message = message
        self.route = route; self.method = method; self.status = status; self.screen = screen; self.detail = detail
    }
}

public struct DeviceInfo: Codable, Sendable, Equatable {
    public var app: String
    public var build: String
    public var device: String
    public var os: String
    public var platform: String
    public var install: String
    public init(app: String, build: String, device: String, os: String, platform: String, install: String) {
        self.app = app; self.build = build; self.device = device; self.os = os; self.platform = platform; self.install = install
    }
}

struct DiagnosticBatch: Encodable { var device: DeviceInfo; var entries: [DiagnosticEntry] }

/// Queues diagnostics on disk (so they survive crashes and offline periods) and ships them in batches.
public actor DiagnosticsReporter {
    public typealias Sender = @Sendable ([DiagnosticEntry], DeviceInfo) async throws -> Void

    private let file: URL
    private let device: DeviceInfo
    private var queue: [DiagnosticEntry]
    private var sender: Sender?
    private var enabled = true
    private var flushing = false
    private var scheduled: Task<Void, Never>?
    private var recent: [String: Date] = [:]
    public let maxQueued = 500

    public init(file: URL, device: DeviceInfo) {
        self.file = file
        self.device = device
        queue = (try? JSONDecoder().decode([DiagnosticEntry].self, from: Data(contentsOf: file))) ?? []
    }

    public func configure(enabled: Bool, sender: Sender?) {
        self.enabled = enabled
        self.sender = sender
        if enabled, sender != nil, !queue.isEmpty { scheduleFlush(after: .seconds(2)) }
    }

    public var pending: [DiagnosticEntry] { queue }

    public func record(_ entry: DiagnosticEntry) {
        // De-duplicate bursts (e.g. a failing poll every 2 s) to one entry per minute per message.
        let key = "\(entry.kind)|\(entry.route ?? "")|\(entry.status ?? 0)|\(entry.message.prefix(120))"
        if let last = recent[key], Date().timeIntervalSince(last) < 60, entry.level != "crash" { return }
        recent[key] = Date()
        if recent.count > 200 { recent = recent.filter { Date().timeIntervalSince($0.value) < 60 } }
        queue.append(entry)
        if queue.count > maxQueued { queue.removeFirst(queue.count - maxQueued) }
        persist()
        scheduleFlush(after: entry.level == "crash" ? .zero : .seconds(5))
    }

    private func scheduleFlush(after delay: Duration) {
        guard scheduled == nil else { return }
        scheduled = Task { [weak self] in
            try? await Task.sleep(for: delay)
            await self?.flush()
        }
    }

    /// Sends queued entries; keeps them if the server can't be reached.
    @discardableResult
    public func flush() async -> Bool {
        scheduled = nil
        guard enabled, let sender, !flushing, !queue.isEmpty else { return queue.isEmpty }
        flushing = true
        defer { flushing = false }
        while !queue.isEmpty {
            let batch = Array(queue.prefix(100))
            do { try await sender(batch, device) } catch { return false }
            queue.removeFirst(min(batch.count, queue.count))
            persist()
        }
        return true
    }

    private func persist() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? JSONEncoder().encode(queue).write(to: file, options: .atomic)
    }
}

/// Records fatal signals and uncaught exceptions to a file, reported on the next launch.
/// The signal handler only uses async-signal-safe calls (write/signal/raise) on a pre-opened descriptor.
public enum CrashSentinel {
    nonisolated(unsafe) private static var fd: Int32 = -1
    nonisolated(unsafe) private static var path: String = ""

    public static func install(file: URL) {
        path = file.path
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        fd = open(file.path + ".live", O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        for sig in [SIGABRT, SIGSEGV, SIGBUS, SIGILL, SIGTRAP, SIGFPE] {
            signal(sig) { s in
                if CrashSentinel.fd >= 0 {
                    // "signal NN" in a stack buffer: no allocation inside a signal handler.
                    var buf: (UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8, UInt8) = (115, 105, 103, 110, 97, 108, 32, 48, 48)
                    withUnsafeMutableBytes(of: &buf) { b in
                        b[7] = UInt8(48 + (s / 10) % 10)
                        b[8] = UInt8(48 + s % 10)
                        _ = write(CrashSentinel.fd, b.baseAddress, b.count)
                    }
                }
                signal(s, SIG_DFL)
                raise(s)
            }
        }
        NSSetUncaughtExceptionHandler { e in
            let text = "exception \(e.name.rawValue): \(e.reason ?? "")\n" + e.callStackSymbols.prefix(40).joined(separator: "\n")
            if CrashSentinel.fd >= 0 { text.utf8CString.withUnsafeBufferPointer { _ = write(CrashSentinel.fd, $0.baseAddress, $0.count - 1) } }
        }
    }

    /// What the previous run recorded before dying (nil if it exited cleanly or never crashed).
    public static func previousCrash(file: URL) -> String? {
        let live = URL(fileURLWithPath: file.path + ".live")
        // install() truncates .live, so read the last run's record first: callers must call this before install().
        guard let data = try? Data(contentsOf: live), !data.isEmpty else { return nil }
        try? FileManager.default.removeItem(at: live)
        return String(decoding: data, as: UTF8.self)
    }

    public static func signalName(_ text: String) -> String {
        guard text.hasPrefix("signal "), let n = Int32(text.dropFirst(7).prefix(while: \.isNumber)) else { return text.components(separatedBy: "\n").first ?? text }
        let names: [Int32: String] = [SIGABRT: "SIGABRT", SIGSEGV: "SIGSEGV", SIGBUS: "SIGBUS", SIGILL: "SIGILL", SIGTRAP: "SIGTRAP (Swift runtime error)", SIGFPE: "SIGFPE"]
        return names[n] ?? "signal \(n)"
    }
}
