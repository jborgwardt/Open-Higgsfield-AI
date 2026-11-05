#if DEBUG
import Foundation
import FilmStudioKit

/// DEBUG builds only: `-sampleDir <folder>` starts the app signed-in with engine responses read from that
/// folder (catalog.json, tools.json, characters.json, media.json, productions.json and optional feed.json —
/// the same JSON the engine serves). `/engine/media/…` URLs are rewritten to `<folder>/media/…`, so design
/// screenshots show real media without a running engine. Nothing here is compiled into release builds.
enum SampleData {
    @MainActor
    static func applyIfRequested(to app: AppModel) -> Bool {
        guard let dir = UserDefaults.standard.string(forKey: "sampleDir"), !dir.isEmpty else { return false }
        let base = URL(fileURLWithPath: dir, isDirectory: true)
        let mediaPrefix = base.appendingPathComponent("media", isDirectory: true).absoluteString
        func data(_ name: String) -> Data? {
            guard let raw = try? String(contentsOf: base.appendingPathComponent(name), encoding: .utf8) else { return nil }
            return Data(raw.replacingOccurrences(of: "/engine/media/", with: mediaPrefix).utf8)
        }
        func decode<T: Decodable>(_ name: String, as _: T.Type) -> T? { data(name).flatMap { try? JSONDecoder().decode(T.self, from: $0) } }

        app.isSample = true
        app.health = decode("health.json", as: Health.self)
            ?? (try? JSONDecoder().decode(Health.self, from: Data(#"{"ok":true,"auth":true,"mode":"oidc","provider":"Pocket ID","authed":true,"user":{"name":"Sample User","email":"sample@example.com"}}"#.utf8)))
        app.catalog = decode("catalog.json", as: Catalog.self)
        if let d = data("tools.json"), let t = try? app.client.parseTools(d) { app.tools = t; app.toolsAvailable = true }
        app.characters = decode("characters.json", as: LossyList<StudioCharacter>.self)?.items ?? []
        app.charactersAvailable = true
        app.recentMedia = decode("media.json", as: LossyList<MediaItem>.self)?.items ?? []
        app.sampleProductions = decode("productions.json", as: LossyList<ProductionSummary>.self)?.items ?? []
        if let f = decode("feed.json", as: Feed.self), !f.isEmpty {
            app.feed = f
        } else {
            app.feed = app.buildFeed()
            app.feedIsFallback = true
        }
        app.phase = .ready
        return true
    }
}
#endif
