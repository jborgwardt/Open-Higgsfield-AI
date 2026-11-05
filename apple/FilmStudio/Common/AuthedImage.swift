import SwiftUI
import FilmStudioKit

/// Loads an engine image with the session token, downsampled for display.
struct AuthedImage: View {
    let url: String?
    var maxPixelSize: Int = 600
    var contentMode: ContentMode = .fill
    @Environment(AppModel.self) private var app
    @State private var image: DecodedImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(decorative: image.cgImage, scale: 1)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
                    .transition(.opacity)
            } else {
                Rectangle().fill(Color.tileBackground)
                    .overlay {
                        if failed { Image(systemName: "photo").font(.title2).foregroundStyle(.tertiary) }
                        else if url?.nonEmpty != nil { ProgressView().controlSize(.small) }
                        else { Image(systemName: "film").font(.title2).foregroundStyle(.tertiary) }
                    }
            }
        }
        .task(id: "\(url ?? "")#\(maxPixelSize)") { await load() }
    }

    private func load() async {
        guard let u = app.client.resolve(url) else { image = nil; return }
        failed = false
        do {
            let img = try await app.images.image(u, maxPixelSize: maxPixelSize, client: app.client)
            withAnimation(.easeOut(duration: 0.15)) { image = img }
        } catch is CancellationError {
        } catch {
            failed = true
        }
    }
}
