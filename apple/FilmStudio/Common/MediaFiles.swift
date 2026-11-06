import SwiftUI
import AVKit
import Combine
import ImageIO
import PhotosUI
import UniformTypeIdentifiers
import FilmStudioKit
#if os(iOS)
import Photos
import UIKit
#else
import AppKit
#endif

/// Exporting engine media: download (authed), share, save to Photos / disk.
enum MediaFiles {
    /// Give an export a short chance to finish if the phone locks or the user switches apps.
    /// This is best-effort grace time, not a persistent background download.
    static func withExportTime<T>(_ operation: () async throws -> T) async rethrows -> T {
        #if os(iOS)
        let backgroundTime = ExportBackgroundTime()
        defer { backgroundTime.end() }
        #endif
        return try await operation()
    }

    static func download(_ urlString: String, app: AppModel,
                         progress: @escaping @MainActor @Sendable (String) -> Void = { _ in }) async throws -> URL {
        guard let url = app.client.resolve(urlString) else { throw APIError.invalidResponse }
        // Already downloaded (a previous Save/Share, or a transfer that finished while the app was in the background).
        let cached = ExportDownloader.cachedFile(for: url)
        if let size = (try? FileManager.default.attributesOfItem(atPath: cached.path)[.size] as? Int64) ?? nil, size > 0 {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: cached.path)
            return cached
        }
        var request = app.client.authorized(url)
        request.timeoutInterval = 120 // inactivity; the whole transfer may take many minutes on a phone
        let report: @Sendable (Int64, Int64) -> Void = { received, expected in
            Task { @MainActor in
                let got = ByteCountFormatter.string(fromByteCount: received, countStyle: .file)
                guard expected > 0 else { progress("Downloading \(got)"); return }
                let percent = Int((Double(received) / Double(expected) * 100).rounded(.down))
                progress("Downloading \(percent)% · \(got) of \(ByteCountFormatter.string(fromByteCount: expected, countStyle: .file))")
            }
        }
        var resumeData: Data?
        let attempts = 6
        for attempt in 0..<attempts {
            try Task.checkCancellation()
            do {
                return try await ExportDownloader.shared.download(request, resumeData: resumeData, progress: report)
            } catch is CancellationError {
                throw CancellationError()
            } catch {
                if Task.isCancelled { throw CancellationError() }
                let ns = error as NSError
                guard attempt < attempts - 1, ns.domain == NSURLErrorDomain, Self.retryable.contains(ns.code) else { throw error }
                resumeData = ns.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
                progress(resumeData == nil ? "Connection interrupted. Retrying (\(attempt + 1) of \(attempts - 1))…"
                                           : "Connection interrupted. Resuming (\(attempt + 1) of \(attempts - 1))…")
                try await Task.sleep(for: .seconds(min(Double(1 << attempt), 15)))
            }
        }
        throw APIError.invalidResponse
    }

    /// A copy of a finished download named for people ("The Road on Side B.mp4", not "FilmStudio-a_960be31d6a0a.mp4"),
    /// for Files / Share. A hard link where possible, so a 150 MB film isn't duplicated on the phone.
    static func named(_ file: URL, for item: MediaItem) -> URL {
        let base: String = {
            let words = item.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            if item.model == "Long-form master", !words.isEmpty { return words }
            if words.isEmpty { return "Film Studio \(item.isVideo ? "video" : "image")" }
            let short = words.split(separator: " ").prefix(8).joined(separator: " ")
            return "Film Studio – \(short)"
        }()
        let unsafe = CharacterSet(charactersIn: "/\\:?*\"<>|\n\r\t")
        var name = base.components(separatedBy: unsafe).joined(separator: " ").trimmingCharacters(in: .whitespaces)
        if name.count > 80 { name = String(name.prefix(80)).trimmingCharacters(in: .whitespaces) }
        if name.isEmpty { name = "Film Studio" }
        let ext = file.pathExtension.isEmpty ? (item.isVideo ? "mp4" : "jpg") : file.pathExtension
        let dir = ExportDownloader.exportsDirectory.appendingPathComponent("Named", isDirectory: true)
            .appendingPathComponent(String(file.deletingPathExtension().lastPathComponent.suffix(24)), isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(name).appendingPathExtension(ext)
        if !FileManager.default.fileExists(atPath: dest.path) {
            do { try FileManager.default.linkItem(at: file, to: dest) }
            catch { do { try FileManager.default.copyItem(at: file, to: dest) } catch { return file } }
        }
        return dest
    }

    /// Connection problems worth another try (resuming where the transfer stopped when possible).
    private static let retryable: Set<Int> = [
        NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet, NSURLErrorCannotConnectToHost,
        NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed, NSURLErrorSecureConnectionFailed, NSURLErrorCannotLoadFromNetwork,
        NSURLErrorBackgroundSessionWasDisconnected, NSURLErrorDataNotAllowed, NSURLErrorCallIsActive, NSURLErrorInternationalRoamingOff,
    ]

    #if os(iOS)
    static func saveToPhotos(_ file: URL, isVideo: Bool) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw NSError(domain: "FilmStudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow Film Studio to add to Photos in Settings → Privacy → Photos."])
        }
        try await PHPhotoLibrary.shared().performChanges(photoChange(file, isVideo: isVideo))
    }

    /// Photos runs the change block on its own background queue. Built outside the main actor so the
    /// closure isn't main-isolated (that isolation check trapped: EXC_BREAKPOINT in dispatch_assert_queue).
    nonisolated private static func photoChange(_ file: URL, isVideo: Bool) -> @Sendable () -> Void {
        { PHAssetCreationRequest.forAsset().addResource(with: isVideo ? .video : .photo, fileURL: file, options: nil) }
    }

    /// A direct Files destination works even when Photos access is denied or the format isn't supported there.
    static func saveToFiles(_ file: URL) async throws -> Bool {
        guard let top = presenter else { throw APIError.transport("Open Film Studio and try saving again.") }
        return await withCheckedContinuation { continuation in
            FilesExportCoordinator.present(file: file, from: top) { continuation.resume(returning: $0) }
        }
    }

    private static var presenter: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let root = scenes.first(where: { $0.activationState == .foregroundActive })?.windows.first(where: \.isKeyWindow)?.rootViewController
                ?? scenes.flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return nil }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    static func share(_ file: URL) {
        guard let top = presenter else { return }
        let vc = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            // iPad: point at the action bar at the bottom, where Share was tapped.
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 110, width: 1, height: 1)
            pop.permittedArrowDirections = [.down]
        }
        top.present(vc, animated: true)
    }
    #else
    static func share(_ file: URL) {
        guard let view = NSApp.keyWindow?.contentView else { return }
        NSSharingServicePicker(items: [file]).show(relativeTo: CGRect(x: view.bounds.maxX - 60, y: view.bounds.maxY - 10, width: 1, height: 1), of: view, preferredEdge: .minY)
    }

    @discardableResult static func saveAs(_ file: URL) throws -> Bool {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.lastPathComponent
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let dest = panel.url else { return false }
        guard file.standardizedFileURL != dest.standardizedFileURL else { return true }
        let manager = FileManager.default
        if manager.fileExists(atPath: dest.path) {
            // Keep an existing export intact if copying the new file fails (for example, a full disk).
            let staging = try manager.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: dest, create: true)
            defer { try? manager.removeItem(at: staging) }
            let replacement = staging.appendingPathComponent(dest.lastPathComponent)
            try manager.copyItem(at: file, to: replacement)
            _ = try manager.replaceItemAt(dest, withItemAt: replacement)
        } else {
            try manager.copyItem(at: file, to: dest)
        }
        return true
    }
    #endif
}

#if os(iOS)
private final class FilesExportCoordinator: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private static var active: [UUID: FilesExportCoordinator] = [:]
    private let id = UUID()
    private let picker: UIDocumentPickerViewController
    private var finished: ((Bool) -> Void)?

    private init(file: URL, finished: @escaping (Bool) -> Void) {
        picker = UIDocumentPickerViewController(forExporting: [file], asCopy: true)
        self.finished = finished
        super.init()
        picker.delegate = self
    }

    static func present(file: URL, from presenter: UIViewController, finished: @escaping (Bool) -> Void) {
        let coordinator = FilesExportCoordinator(file: file, finished: finished)
        active[coordinator.id] = coordinator // UIKit's delegate is weak; retain it through Save or Cancel.
        let picker = coordinator.picker
        picker.modalPresentationStyle = .formSheet
        if let popover = picker.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
        }
        presenter.present(picker, animated: true)
        picker.presentationController?.delegate = coordinator
    }

    private func complete(_ saved: Bool) {
        let callback = finished
        finished = nil
        Self.active[id] = nil
        callback?(saved)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { complete(!urls.isEmpty) }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { complete(false) }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { complete(false) }
}

private final class ExportBackgroundTime {
    private var identifier: UIBackgroundTaskIdentifier = .invalid

    init() {
        identifier = UIApplication.shared.beginBackgroundTask(withName: "Save finished media") { [weak self] in
            Task { @MainActor in self?.end() }
        }
    }

    func end() {
        guard identifier != .invalid else { return }
        UIApplication.shared.endBackgroundTask(identifier)
        identifier = .invalid
    }
}
#endif

#if os(macOS)
/// Use AppKit directly: the SwiftUI VideoPlayer bridge can fail while resolving AVPlayerView on macOS 27.
private struct NativeMoviePlayer: NSViewRepresentable {
    let player: AVPlayer?

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .floating
        view.showsFullScreenToggleButton = true
        view.videoGravity = .resizeAspect
        view.player = player
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {
        if view.player !== player { view.player = player }
    }

    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
        view.player = nil
    }
}
#endif

/// AVPlayer for engine media; sends the session token to the engine only.
struct EngineVideoPlayer: View {
    let url: String
    var autoplay = true
    @Environment(AppModel.self) private var app
    @State private var player: AVPlayer?
    @State private var loadState: LoadState = .loading
    private enum LoadState { case loading, ready, failed }

    var body: some View {
        Group {
            #if os(macOS)
            NativeMoviePlayer(player: player)
            #else
            VideoPlayer(player: player)
            #endif
        }
            // Never a silent black box: a spinner while the film loads, a plain message if it can't.
            .overlay {
                switch loadState {
                case .loading: ProgressView().controlSize(.large).tint(.white).allowsHitTesting(false)
                case .failed:
                    Label("Couldn't load this video. Check the connection and open it again.", systemImage: "exclamationmark.triangle")
                        .font(.callout).foregroundStyle(.white).padding(12).background(.black.opacity(0.6), in: Capsule())
                case .ready: EmptyView()
                }
            }
            .task(id: url) {
                guard let u = app.client.resolve(url) else { return }
                var options: [String: Any] = [:]
                if app.client.isEngineURL(u), let token = app.token {
                    options["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(token)"]
                    if let c = WebSession.cookie(token: token, for: u) { options[AVURLAssetHTTPCookiesKey] = [c] }
                }
                #if os(iOS)
                // Full players are deliberate viewing: play sound even with the silent switch on
                // (the default ambient session silences it). Muted feed tiles never touch the session.
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
                try? AVAudioSession.sharedInstance().setActive(true)
                #endif
                let item = AVPlayerItem(asset: AVURLAsset(url: u, options: options))
                let p = AVPlayer(playerItem: item)
                loadState = .loading
                player = p
                if autoplay { p.play() }
                for await status in item.publisher(for: \.status).values {
                    if status == .readyToPlay { loadState = .ready; break }
                    if status == .failed { loadState = .failed; break }
                }
            }
            .onDisappear {
                player?.pause()
                #if os(iOS)
                // Hand audio back so other apps' music resumes.
                try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                try? AVAudioSession.sharedInstance().setCategory(.ambient)
                #endif
            }
    }
}

// MARK: - Import

nonisolated struct ImportedImage: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(importedContentType: .image) { ImportedImage(data: $0) }
    }
}

nonisolated struct ImportedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            let dest = FileManager.default.temporaryDirectory.appendingPathComponent("import-\(UUID().uuidString).\(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)")
            try FileManager.default.copyItem(at: received.file, to: dest)
            return ImportedMovie(url: dest)
        }
    }
}

enum MediaUpload {
    /// Re-encodes any image (HEIC, PNG, huge JPEG) as a JPEG the engine and every provider understand.
    nonisolated static func jpeg(_ data: Data, maxPixel: Int = 4096, quality: Double = 0.92) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel]
        guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, img, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    /// `maxPixel` 2560: plenty for start frames and references, and a fraction of the bytes of a 4K JPEG over a
    /// slow link (QA-19). `local` gets a small thumbnail right away, before the upload finishes.
    static func image(_ data: Data, name: String = "photo.jpg", app: AppModel, maxPixel: Int = 2560, local: ((CGImage) -> Void)? = nil) async throws -> UploadedAsset {
        if let local, let thumb = await Task.detached(operation: { MediaUpload.thumbnail(data) }).value { local(thumb) }
        let jpeg = await Task.detached { MediaUpload.jpeg(data, maxPixel: maxPixel, quality: 0.88) }.value
        guard let jpeg else { throw APIError.decoding("that file is not an image") }
        let base = (name as NSString).deletingPathExtension
        return try await app.client.upload(data: jpeg, name: "\(base.isEmpty ? "photo" : base).jpg", mimeType: "image/jpeg")
    }

    static func file(_ url: URL, app: AppModel) async throws -> UploadedAsset {
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = type?.preferredMIMEType ?? (type?.conforms(to: .movie) == true ? "video/quicktime" : "application/octet-stream")
        return try await app.client.upload(file: url, name: url.lastPathComponent, mimeType: mime)
    }

    nonisolated static func thumbnail(_ data: Data, maxPixel: Int = 300) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }

    /// Loads a Photos picker selection and uploads it.
    static func upload(_ item: PhotosPickerItem, app: AppModel, local: ((CGImage) -> Void)? = nil) async throws -> UploadedAsset {
        if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
            guard let movie = try await item.loadTransferable(type: ImportedMovie.self) else { throw APIError.decoding("couldn't read that video") }
            defer { try? FileManager.default.removeItem(at: movie.url) }
            return try await file(movie.url, app: app)
        }
        guard let data = try await item.loadTransferable(type: Data.self) else { throw APIError.decoding("couldn't read that photo") }
        return try await image(data, app: app, local: local)
    }

    /// A file picked with the Files importer (security-scoped).
    static func imported(_ url: URL, app: AppModel) async throws -> UploadedAsset {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString)-\(url.lastPathComponent)")
        try FileManager.default.copyItem(at: url, to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        if UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true {
            return try await image(Data(contentsOf: tmp), name: url.lastPathComponent, app: app)
        }
        return try await file(tmp, app: app)
    }
}

enum SlotKind {
    case image, video, audio
    var filter: PHPickerFilter? {
        switch self { case .image: .images; case .video: .videos; case .audio: nil }
    }
    var contentTypes: [UTType] {
        switch self { case .image: [.image]; case .video: [.movie]; case .audio: [.audio] }
    }
    var icon: String {
        switch self { case .image: "photo"; case .video: "video"; case .audio: "waveform" }
    }
}

/// A drop-and-pick slot that uploads to the engine and holds the resulting asset.
struct MediaSlot: View {
    let title: String
    var subtitle: String = ""
    var kind: SlotKind = .image
    @Binding var asset: UploadedAsset?
    @Environment(AppModel.self) private var app
    @State private var pick: PhotosPickerItem?
    @State private var uploading = false
    @State private var error: String?
    @State private var importing = false
    @State private var targeted = false

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.tileBackground)
                if let asset, kind == .image || asset.kind == "image" {
                    AuthedImage(url: asset.url, maxPixelSize: 240).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                } else if asset != nil {
                    Image(systemName: kind == .audio ? "waveform" : "film").font(.title2).foregroundStyle(Color.accentColor)
                } else if uploading {
                    ProgressView()
                } else {
                    Image(systemName: kind.icon).font(.title3).foregroundStyle(.secondary)
                }
            }
            .frame(width: 64, height: 64)
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(targeted ? Color.accentColor : .clear, lineWidth: 2))

            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.weight(.medium))
                if let error { Text(error).font(.caption).foregroundStyle(.red).lineLimit(2) }
                else if uploading { Text("Uploading…").font(.caption).foregroundStyle(.secondary) }
                else if !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                HStack(spacing: 12) {
                    if let filter = kind.filter {
                        PhotosPicker(selection: $pick, matching: filter, photoLibrary: .shared()) {
                            Text(asset == nil ? "Choose…" : "Replace…")
                        }
                    }
                    Button(kind == .audio ? "Choose File…" : "Files…") { importing = true }
                    if asset != nil { Button("Remove", role: .destructive) { asset = nil } }
                }
                .buttonStyle(.borderless)
                .font(.caption.weight(.semibold))
                .disabled(uploading)
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onChange(of: pick) { _, item in
            guard let item else { return }
            run { try await MediaUpload.upload(item, app: app) }
            pick = nil
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: kind.contentTypes) { result in
            if case .success(let url) = result { run { try await MediaUpload.imported(url, app: app) } }
        }
        .modifier(SlotDrop(kind: kind, targeted: $targeted) { drop in run(drop) })
    }

    private func run(_ work: @escaping () async throws -> UploadedAsset) {
        uploading = true
        error = nil
        Task {
            do { asset = try await work() } catch {
                self.error = error.localizedDescription
                app.report(error, screen: "upload", action: "Upload \(title)")
            }
            uploading = false
        }
    }
}

/// Drag & drop of images (or videos) onto a slot — from Finder, Photos, Safari or another app.
private struct SlotDrop: ViewModifier {
    let kind: SlotKind
    @Binding var targeted: Bool
    let upload: (@escaping () async throws -> UploadedAsset) -> Void
    @Environment(AppModel.self) private var app

    func body(content: Content) -> some View {
        switch kind {
        case .image:
            content.dropDestination(for: ImportedImage.self) { items, _ in
                guard let first = items.first, app.config.isOn("dragAndDrop") else { return false }
                upload { try await MediaUpload.image(first.data, app: app) }
                return true
            } isTargeted: { targeted = $0 }
        case .video:
            content.dropDestination(for: ImportedMovie.self) { items, _ in
                guard let first = items.first, app.config.isOn("dragAndDrop") else { return false }
                upload { try await MediaUpload.file(first.url, app: app) }
                return true
            } isTargeted: { targeted = $0 }
        case .audio:
            content
        }
    }
}
