import SwiftUI
import AVFoundation
import FilmStudioKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// Media-first tiles: poster first, then a muted looping clip that only plays while the tile is on screen.

/// Downloads short preview clips with the session token and keeps them on disk (Caches/PreviewVideos),
/// so the feed loops from local files, survives relaunch and works offline.
@MainActor
final class PreviewVideoCache {
    static let shared = PreviewVideoCache()
    private var inflight: [URL: Task<URL, Error>] = [:]
    private let directory: URL = {
        let d = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("PreviewVideos", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()
    private let budget: Int64 = 400 << 20

    func file(for url: URL, client: APIClient) async throws -> URL {
        if url.isFileURL { return url }
        let dest = directory.appendingPathComponent(Self.key(url)).appendingPathExtension(url.pathExtension.isEmpty ? "mp4" : url.pathExtension)
        if FileManager.default.fileExists(atPath: dest.path) {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.path)
            return dest
        }
        if let running = inflight[url] { return try await running.value }
        let request = client.authorized(url), session = client.session
        let task = Task<URL, Error> {
            let (tmp, response) = try await session.download(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw APIError.server(status: http.statusCode, message: "preview unavailable")
            }
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
            return dest
        }
        inflight[url] = task
        defer { inflight[url] = nil }
        let file = try await task.value
        trim()
        return file
    }

    func clear() { try? FileManager.default.removeItem(at: directory); try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }

    /// Least recently used files go first once the folder passes the budget.
    private func trim() {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        guard let files = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys) else { return }
        var entries = files.compactMap { f -> (URL, Int64, Date)? in
            guard let v = try? f.resourceValues(forKeys: Set(keys)) else { return nil }
            return (f, Int64(v.fileSize ?? 0), v.contentModificationDate ?? .distantPast)
        }
        var total = entries.reduce(Int64(0)) { $0 + $1.1 }
        guard total > budget else { return }
        entries.sort { $0.2 < $1.2 }
        for (f, size, _) in entries where total > budget * 3 / 4 {
            try? FileManager.default.removeItem(at: f)
            total -= size
        }
    }

    private static func key(_ url: URL) -> String {
        var h: UInt64 = 0xcbf29ce484222325
        for b in url.absoluteString.utf8 { h = (h ^ UInt64(b)) &* 0x100000001b3 }
        return String(h, radix: 36)
    }
}

/// How a tile decides to play.
enum Autoplay {
    /// Plays while at least half of it is visible inside a scroll view.
    case whenVisible
    /// Plays whenever it is on screen (outside scroll views, e.g. the composer stage).
    case always
    case never
}

/// Poster first, then a muted looping clip; a seeded gradient with a glyph when there is no media.
struct PreviewMediaView: View {
    let preview: MediaPreview?
    var seed: String = ""
    var symbol: String?
    var autoplay: Autoplay = .whenVisible
    /// Download clips to disk (feed previews). Library media streams instead (they can be long).
    var cacheVideo = true
    var maxPixelSize: Int = 900
    @State private var visible = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var shouldPlay: Bool {
        guard preview?.video != nil, !reduceMotion, scenePhase == .active, !ProcessInfo.processInfo.isLowPowerModeEnabled else { return false }
        switch autoplay {
        case .whenVisible: return visible
        case .always: return true
        case .never: return false
        }
    }

    var body: some View {
        ZStack {
            if let still = preview?.still {
                AuthedImage(url: still, maxPixelSize: maxPixelSize, quiet: true)
            } else if preview?.video == nil {
                placeholder
            } else {
                Color.surface
            }
            if let video = preview?.video, shouldPlay {
                LoopingVideo(url: video, cache: cacheVideo)
                    .transition(.opacity)
            }
        }
        .clipped()
        .onScrollVisibilityChange(threshold: 0.5) { visible = $0 }
        .animation(.easeOut(duration: 0.25), value: shouldPlay)
    }

    private var placeholder: some View {
        SeededGradient(seed: seed)
            .overlay {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 30, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.85))
                }
            }
    }
}

/// A muted, looping clip in an AVPlayerLayer (aspect fill). Fades in once the first frame is ready.
struct LoopingVideo: View {
    let url: String
    var cache = true
    var gravity: AVLayerVideoGravity = .resizeAspectFill
    @Environment(AppModel.self) private var app
    @State private var player: AVQueuePlayer?
    @State private var looper: AVPlayerLooper?
    @State private var ready = false

    var body: some View {
        PlayerLayerView(player: player, gravity: gravity) { ready = $0 }
            .opacity(ready ? 1 : 0)
            .animation(.easeOut(duration: 0.3), value: ready)
            .task(id: url) { await start() }
            .onDisappear { stop() }
            .accessibilityHidden(true)
    }

    private func start() async {
        guard let remote = app.client.resolve(url) else { return }
        let asset: AVURLAsset
        if cache, let file = try? await PreviewVideoCache.shared.file(for: remote, client: app.client) {
            asset = AVURLAsset(url: file)
        } else {
            asset = AVURLAsset(url: remote, options: EngineAsset.options(for: remote, app: app))
        }
        guard !Task.isCancelled else { return }
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 2
        let p = AVQueuePlayer()
        p.isMuted = true
        p.preventsDisplaySleepDuringVideoPlayback = false
        #if os(iOS)
        p.audiovisualBackgroundPlaybackPolicy = .pauses
        #endif
        looper = AVPlayerLooper(player: p, templateItem: item)
        player = p
        p.play()
    }

    private func stop() {
        player?.pause()
        looper?.disableLooping()
        looper = nil
        player = nil
        ready = false
    }
}

enum EngineAsset {
    /// Bearer header (and the web session cookie) for engine URLs only.
    static func options(for url: URL, app: AppModel) -> [String: Any] {
        var options: [String: Any] = [:]
        if app.client.isEngineURL(url), let token = app.token {
            options["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(token)"]
            if let c = WebSession.cookie(token: token, for: url) { options[AVURLAssetHTTPCookiesKey] = [c] }
        }
        return options
    }
}

#if os(iOS)
private final class PlayerUIView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    var observation: NSKeyValueObservation?
}

private struct PlayerLayerView: UIViewRepresentable {
    let player: AVPlayer?
    let gravity: AVLayerVideoGravity
    let onReady: @MainActor @Sendable (Bool) -> Void

    func makeUIView(context: Context) -> PlayerUIView {
        let v = PlayerUIView()
        v.backgroundColor = .clear
        v.isUserInteractionEnabled = false
        v.playerLayer.videoGravity = gravity
        let onReady = onReady
        v.observation = v.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { layer, _ in
            let r = layer.isReadyForDisplay
            Task { @MainActor in onReady(r) }
        }
        return v
    }

    func updateUIView(_ v: PlayerUIView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
        v.playerLayer.videoGravity = gravity
    }

    static func dismantleUIView(_ v: PlayerUIView, coordinator: ()) {
        v.observation = nil
        v.playerLayer.player = nil
    }
}
#else
private final class PlayerNSView: NSView {
    let playerLayer = AVPlayerLayer()
    var observation: NSKeyValueObservation?
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer = CALayer()
        layer?.addSublayer(playerLayer)
    }
    required init?(coder: NSCoder) { fatalError() }
    override func layout() {
        super.layout()
        CATransaction.begin(); CATransaction.setDisableActions(true)
        playerLayer.frame = bounds
        CATransaction.commit()
    }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

private struct PlayerLayerView: NSViewRepresentable {
    let player: AVPlayer?
    let gravity: AVLayerVideoGravity
    let onReady: @MainActor @Sendable (Bool) -> Void

    func makeNSView(context: Context) -> PlayerNSView {
        let v = PlayerNSView()
        v.playerLayer.videoGravity = gravity
        let onReady = onReady
        v.observation = v.playerLayer.observe(\.isReadyForDisplay, options: [.new]) { layer, _ in
            let r = layer.isReadyForDisplay
            Task { @MainActor in onReady(r) }
        }
        return v
    }

    func updateNSView(_ v: PlayerNSView, context: Context) {
        if v.playerLayer.player !== player { v.playerLayer.player = player }
        v.playerLayer.videoGravity = gravity
    }

    static func dismantleNSView(_ v: PlayerNSView, coordinator: ()) {
        v.observation = nil
        v.playerLayer.player = nil
    }
}
#endif

extension MediaItem {
    /// Preview for tiles: the clip (streamed) over its poster, or the image.
    var tilePreview: MediaPreview {
        isVideo ? MediaPreview(url: url, poster: thumb, kind: "video") : MediaPreview(url: url, kind: "image")
    }
    /// Width / height from "1280×720" when the engine knows it.
    var aspectRatio: Double? { FeedItem.parseAspect(.string(resolution)) }
}
