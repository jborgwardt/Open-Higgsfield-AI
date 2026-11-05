import Foundation
import MetricKit
import FilmStudioKit

/// Forwards crash and hang diagnostics that the OS delivers (usually on the next launch) to /app/log.
final class MetricsSubscriber: NSObject, MXMetricManagerSubscriber {
    nonisolated let reporter: DiagnosticsReporter

    init(reporter: DiagnosticsReporter) {
        self.reporter = reporter
        super.init()
        MXMetricManager.shared.add(self)
    }

    nonisolated func didReceive(_ payloads: [MXDiagnosticPayload]) {
        var entries: [DiagnosticEntry] = []
        for p in payloads {
            for c in p.crashDiagnostics ?? [] {
                let what = [c.exceptionType.map { "exception \($0)" }, c.signal.map { "signal \($0)" }, c.terminationReason].compactMap { $0 }.joined(separator: ", ")
                entries.append(DiagnosticEntry(level: "crash", kind: "crash", message: "Crash reported by the OS (\(c.metaData.applicationBuildVersion)): \(what)", detail: String(decoding: c.jsonRepresentation().prefix(15000), as: UTF8.self)))
            }
            for h in p.hangDiagnostics ?? [] {
                entries.append(DiagnosticEntry(level: "warn", kind: "hang", message: "Hang of \(h.hangDuration.formatted())", detail: String(decoding: h.jsonRepresentation().prefix(15000), as: UTF8.self)))
            }
        }
        let reporter = reporter
        Task { for e in entries { await reporter.record(e) } }
    }
}
