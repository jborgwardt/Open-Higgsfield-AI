import SwiftUI
import FilmStudioKit

/// Generations and tool runs in flight. Lives in the AppModel, so polling continues while you switch screens.
@Observable
final class GenerationStore {
    struct Run: Identifiable, Equatable {
        let id = UUID()
        var title: String
        var subtitle: String
        var kind: String // image | video | audio
        var source: String // "create" | "tool:<id>"
        var job: Job?
        var error: String?
        var startedAt = Date()
        var isFinished: Bool { error != nil || job?.status.isFinished == true }
        var succeeded: Bool { job?.status == .done && job?.url != nil }
        var statusText: String {
            if let error { return error }
            guard let job else { return "Starting…" }
            if job.status == .done { return "Done" }
            if job.status == .cancelled { return "Cancelled" }
            if job.status == .error { return job.error ?? job.message }
            return job.message.isEmpty ? "Working…" : job.message
        }
        /// The finished result as a library item (for the viewer).
        var resultItem: MediaItem? {
            guard let job, job.status == .done, let url = job.url else { return nil }
            let isVideo = kind == "video" || job.kind == "video" || url.lowercased().hasSuffix(".mp4") || url.lowercased().hasSuffix(".mov")
            let isAudio = kind == "audio" || job.kind == "audio"
            return MediaItem(id: job.assetId ?? job.id, url: url, thumb: job.posterUrl ?? (isVideo ? "" : url), kind: isAudio ? "audio" : (isVideo ? "videos" : "images"), model: title, prompt: subtitle, createdAt: ISODate.string(startedAt))
        }
    }

    var runs: [Run] = []
    /// Set when a run finishes, so the screen that started it can open the result.
    var lastFinished: Run?
    @ObservationIgnored private var tasks: [UUID: Task<Void, Never>] = [:]

    func runs(from source: String) -> [Run] { runs.filter { $0.source == source } }

    @discardableResult
    func start(title: String, subtitle: String, kind: String, source: String, app: AppModel, begin: @escaping () async throws -> Job) -> UUID {
        let run = Run(title: title, subtitle: subtitle, kind: kind, source: source)
        runs.insert(run, at: 0)
        let id = run.id
        tasks[id] = Task { [weak self] in
            do {
                var job = try await begin()
                self?.update(id) { $0.job = job }
                if !job.status.isFinished {
                    job = try await app.client.waitForJob(job.id, every: app.config.interval("jobMs", default: 1500)) { j in
                        await MainActor.run { self?.update(id) { $0.job = j } }
                    }
                }
                self?.update(id) { $0.job = job }
                if job.status == .error { app.record(DiagnosticEntry(level: "warn", kind: "job", message: "\(title) failed: \(job.error ?? job.message)", screen: source)) }
                if job.status == .done { Platform.haptic() }
            } catch is CancellationError {
            } catch {
                self?.update(id) { $0.error = error.localizedDescription }
                app.report(error, screen: source, action: "Start \(title)")
                Platform.haptic(false)
            }
            if let finished = self?.runs.first(where: { $0.id == id }) { self?.lastFinished = finished }
            self?.tasks[id] = nil
        }
        return id
    }

    func cancel(_ id: UUID, app: AppModel) {
        if let jobId = runs.first(where: { $0.id == id })?.job?.id {
            Task { try? await app.client.cancelJob(jobId) }
        } else {
            tasks[id]?.cancel()
            update(id) { $0.error = "Cancelled" }
        }
    }

    func remove(_ id: UUID) {
        tasks[id]?.cancel()
        tasks[id] = nil
        runs.removeAll { $0.id == id }
    }

    func clearFinished(source: String) { runs.removeAll { $0.source == source && $0.isFinished } }

    private func update(_ id: UUID, _ change: (inout Run) -> Void) {
        guard let i = runs.firstIndex(where: { $0.id == id }) else { return }
        change(&runs[i])
    }
}
