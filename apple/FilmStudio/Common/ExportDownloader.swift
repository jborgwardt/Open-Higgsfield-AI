import Foundation
#if os(iOS)
import UIKit
#endif

/// Downloads finished media for Save / Share.
///
/// A finished film is ~150 MB; over a phone connection that is minutes, and people switch apps meanwhile.
/// On iOS this uses a *background* URLSession, so the transfer keeps going while Film Studio is in the
/// background or the phone is locked, and resumes after a dropped connection (the engine sends ETag /
/// Last-Modified and honours If-Range). Finished files are kept in Caches/Exports under the asset's own
/// (immutable) file name, so Save to Photos, Save to Files and Share reuse one download instead of fetching
/// the film again each time — and a transfer that finished while the app was suspended is picked up later.
nonisolated final class ExportDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = ExportDownloader()

    static var sessionIdentifier: String { "\(Bundle.main.bundleIdentifier ?? "FilmStudio").exports" }

    /// Where a finished download of `url` lives. Engine media names are content IDs (a_xxxx.mp4): immutable.
    static func cachedFile(for url: URL) -> URL {
        let name = url.lastPathComponent.isEmpty ? "media" : url.lastPathComponent
        return exportsDirectory.appendingPathComponent("FilmStudio-\(name)")
    }

    static var exportsDirectory: URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Exports", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// Completion handler iOS hands over when it relaunches the app for background transfer events.
    var backgroundEventsCompletion: (() -> Void)?

    private struct Waiter {
        let progress: @Sendable (Int64, Int64) -> Void
        let continuation: CheckedContinuation<URL, Error>
    }

    private let lock = NSLock()
    private var waiters: [Int: Waiter] = [:]
    private var lastReport: [Int: TimeInterval] = [:]
    /// A file finished (and moved into the cache) before didCompleteWithError delivered the outcome.
    private var finished: [Int: Result<URL, Error>] = [:]
    private var session: URLSession!

    override init() {
        super.init()
        session = makeSession()
    }

    private func makeSession() -> URLSession {
        #if os(iOS)
        let c = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
        c.sessionSendsLaunchEvents = true
        c.isDiscretionary = false
        #else
        let c = URLSessionConfiguration.default
        #endif
        c.timeoutIntervalForRequest = 120   // inactivity
        c.timeoutIntervalForResource = 60 * 60 * 2
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.allowsCellularAccess = true
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }

    /// Recreate the background session early (at launch) so transfers that finished while the app was not
    /// running are delivered and moved into the cache.
    func activate() {
        _ = session
        pruneOldExports()
    }

    /// Finished exports are only a hand-off to Photos / Files / Share: drop ones older than two days.
    private func pruneOldExports() {
        let fm = FileManager.default
        let cutoff = Date().addingTimeInterval(-48 * 3600)
        let files = (try? fm.contentsOfDirectory(at: Self.exportsDirectory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        // Friendly-named hand-off copies (hard links) are recreated on demand.
        try? fm.removeItem(at: Self.exportsDirectory.appendingPathComponent("Named", isDirectory: true))
        for f in files where f.lastPathComponent != "Named" && ((try? f.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantFuture) < cutoff {
            try? fm.removeItem(at: f)
        }
    }

    /// One attempt: download `request` (or continue from `resumeData`) into the cache.
    /// Throws URLError — with resume data in `userInfo` when the transfer can continue — or CancellationError.
    func download(_ request: URLRequest, resumeData: Data?, progress: @escaping @Sendable (Int64, Int64) -> Void) async throws -> URL {
        let task = resumeData.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: request)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<URL, Error>) in
                lock.lock()
                waiters[task.taskIdentifier] = Waiter(progress: progress, continuation: continuation)
                lock.unlock()
                task.resume()
            }
        } onCancel: {
            task.cancel()
        }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        let now = Date.timeIntervalSinceReferenceDate
        lock.lock()
        let id = downloadTask.taskIdentifier
        let due = now - (lastReport[id] ?? 0) > 0.25 || totalBytesWritten == totalBytesExpectedToWrite
        if due { lastReport[id] = now }
        let waiter = waiters[id]
        lock.unlock()
        if due { waiter?.progress(totalBytesWritten, totalBytesExpectedToWrite) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        // The temporary file disappears when this returns: move it now, then report in didCompleteWithError.
        let result: Result<URL, Error>
        if let http = downloadTask.response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            result = .failure(http.statusCode == 401 ? APIErrorBridge.unauthorized : APIErrorBridge.server(http.statusCode))
        } else if let url = downloadTask.originalRequest?.url ?? downloadTask.currentRequest?.url {
            // URLSession only calls this once every byte arrived (a dropped connection ends in an error instead).
            let dest = Self.cachedFile(for: url)
            do {
                if FileManager.default.fileExists(atPath: dest.path) { try FileManager.default.removeItem(at: dest) }
                try FileManager.default.moveItem(at: location, to: dest)
                result = .success(dest)
            } catch { result = .failure(error) }
        } else {
            result = .failure(URLError(.badURL))
        }
        lock.lock(); finished[downloadTask.taskIdentifier] = result; lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let id = task.taskIdentifier
        let waiter = waiters.removeValue(forKey: id)
        let done = finished.removeValue(forKey: id)
        lastReport[id] = nil
        lock.unlock()
        guard let waiter else { return } // finished while the app was not waiting: the file is already cached
        if let error {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled,
               nsError.userInfo[NSURLSessionDownloadTaskResumeData] == nil {
                waiter.continuation.resume(throwing: CancellationError())
            } else {
                waiter.continuation.resume(throwing: error)
            }
        } else if let done {
            waiter.continuation.resume(with: done)
        } else {
            waiter.continuation.resume(throwing: URLError(.cannotCreateFile))
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        DispatchQueue.main.async { [weak self] in
            self?.backgroundEventsCompletion?()
            self?.backgroundEventsCompletion = nil
        }
    }
}

/// FilmStudioKit's APIError, without making this file depend on its initialisers' exact shape.
nonisolated enum APIErrorBridge {
    static var unauthorized: Error { NSError(domain: "FilmStudio", code: 401, userInfo: [NSLocalizedDescriptionKey: "Your session expired. Sign in again, then retry."]) }
    static func server(_ status: Int) -> Error { NSError(domain: "FilmStudio", code: status, userInfo: [NSLocalizedDescriptionKey: "The studio couldn't send this file (HTTP \(status))."]) }
}

#if os(iOS)
/// Hands iOS's background-transfer completion to the downloader (needed for a background URLSession).
final class FilmStudioAppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        ExportDownloader.shared.activate()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == ExportDownloader.sessionIdentifier else { completionHandler(); return }
        ExportDownloader.shared.backgroundEventsCompletion = completionHandler
        ExportDownloader.shared.activate()
    }
}
#endif
