import Foundation
import ImageIO
import CoreGraphics

/// A decoded image that can cross actor boundaries (CGImage is immutable).
public struct DecodedImage: @unchecked Sendable {
    public let cgImage: CGImage
    public var aspectRatio: Double { Double(cgImage.width) / Double(max(cgImage.height, 1)) }
}

/// Loads engine media with the session token, downsamples with ImageIO (small memory in grids),
/// and caches decoded images in memory and bytes on disk (via the client's URLCache).
public actor ImagePipeline {
    private let cache = NSCache<NSString, CacheBox>()
    private var inflight: [String: Task<DecodedImage, Error>] = [:]

    final class CacheBox { let image: DecodedImage; init(_ i: DecodedImage) { image = i } }

    public init() { cache.totalCostLimit = 160 << 20 }

    public func image(_ url: URL, maxPixelSize: Int, client: APIClient) async throws -> DecodedImage {
        let key = "\(url.absoluteString)#\(maxPixelSize)"
        if let hit = cache.object(forKey: key as NSString) { return hit.image }
        if let running = inflight[key] { return try await running.value }
        let request = client.authorized(url)
        let session = client.session
        let task = Task.detached(priority: .userInitiated) { () throws -> DecodedImage in
            let (data, response) = try await session.data(for: request)
            if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                throw http.statusCode == 401 ? APIError.unauthorized("") : APIError.server(status: http.statusCode, message: "image unavailable")
            }
            guard let img = ImagePipeline.decode(data, maxPixelSize: maxPixelSize) else { throw APIError.decoding("not an image") }
            return img
        }
        inflight[key] = task
        defer { inflight[key] = nil }
        let img = try await task.value
        cache.setObject(CacheBox(img), forKey: key as NSString, cost: img.cgImage.bytesPerRow * img.cgImage.height)
        return img
    }

    public func clear() { cache.removeAllObjects() }

    public static func decode(_ data: Data, maxPixelSize: Int) -> DecodedImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(64, maxPixelSize),
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        return DecodedImage(cgImage: cg)
    }
}
