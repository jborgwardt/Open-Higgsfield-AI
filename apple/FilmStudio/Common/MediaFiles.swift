import SwiftUI
import AVKit
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
    static func download(_ urlString: String, app: AppModel) async throws -> URL {
        guard let url = app.client.resolve(urlString) else { throw APIError.invalidResponse }
        let (tmp, response) = try await app.client.session.download(for: app.client.authorized(url))
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw http.statusCode == 401 ? APIError.unauthorized("") : APIError.server(status: http.statusCode, message: "Download failed")
        }
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Exports", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = url.lastPathComponent.isEmpty ? "media" : url.lastPathComponent
        let dest = dir.appendingPathComponent("FilmStudio-\(name)")
        try? FileManager.default.removeItem(at: dest)
        try FileManager.default.moveItem(at: tmp, to: dest)
        return dest
    }

    #if os(iOS)
    static func saveToPhotos(_ file: URL, isVideo: Bool) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw NSError(domain: "FilmStudio", code: 1, userInfo: [NSLocalizedDescriptionKey: "Allow Film Studio to add to Photos in Settings → Privacy → Photos."])
        }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetCreationRequest.forAsset().addResource(with: isVideo ? .video : .photo, fileURL: file, options: nil)
        }
    }

    static func share(_ file: URL) {
        guard let root = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).flatMap(\.windows).first(where: \.isKeyWindow)?.rootViewController else { return }
        var top = root
        while let p = top.presentedViewController { top = p }
        let vc = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        if let pop = vc.popoverPresentationController {
            pop.sourceView = top.view
            pop.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.minY + 60, width: 1, height: 1)
        }
        top.present(vc, animated: true)
    }
    #else
    static func share(_ file: URL) {
        guard let view = NSApp.keyWindow?.contentView else { return }
        NSSharingServicePicker(items: [file]).show(relativeTo: CGRect(x: view.bounds.maxX - 60, y: view.bounds.maxY - 10, width: 1, height: 1), of: view, preferredEdge: .minY)
    }

    static func saveAs(_ file: URL) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = file.lastPathComponent
        panel.canCreateDirectories = true
        if panel.runModal() == .OK, let dest = panel.url {
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: file, to: dest)
        }
    }
    #endif
}

/// AVPlayer for engine media; sends the session token to the engine only.
struct EngineVideoPlayer: View {
    let url: String
    var autoplay = true
    @Environment(AppModel.self) private var app
    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .task(id: url) {
                guard let u = app.client.resolve(url) else { return }
                var options: [String: Any] = [:]
                if app.client.isEngineURL(u), let token = app.token {
                    options["AVURLAssetHTTPHeaderFieldsKey"] = ["Authorization": "Bearer \(token)"]
                    if let c = WebSession.cookie(token: token, for: u) { options[AVURLAssetHTTPCookiesKey] = [c] }
                }
                let p = AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: u, options: options)))
                player = p
                if autoplay { p.play() }
            }
            .onDisappear { player?.pause() }
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

    static func image(_ data: Data, name: String = "photo.jpg", app: AppModel) async throws -> UploadedAsset {
        let jpeg = await Task.detached { MediaUpload.jpeg(data) }.value
        guard let jpeg else { throw APIError.decoding("that file is not an image") }
        let base = (name as NSString).deletingPathExtension
        return try await app.client.upload(data: jpeg, name: "\(base.isEmpty ? "photo" : base).jpg", mimeType: "image/jpeg")
    }

    static func file(_ url: URL, app: AppModel) async throws -> UploadedAsset {
        let type = UTType(filenameExtension: url.pathExtension)
        let mime = type?.preferredMIMEType ?? (type?.conforms(to: .movie) == true ? "video/quicktime" : "application/octet-stream")
        return try await app.client.upload(file: url, name: url.lastPathComponent, mimeType: mime)
    }

    /// Loads a Photos picker selection and uploads it.
    static func upload(_ item: PhotosPickerItem, app: AppModel) async throws -> UploadedAsset {
        if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
            guard let movie = try await item.loadTransferable(type: ImportedMovie.self) else { throw APIError.decoding("couldn't read that video") }
            defer { try? FileManager.default.removeItem(at: movie.url) }
            return try await file(movie.url, app: app)
        }
        guard let data = try await item.loadTransferable(type: Data.self) else { throw APIError.decoding("couldn't read that photo") }
        return try await image(data, app: app)
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
