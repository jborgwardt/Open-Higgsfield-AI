import Foundation
import Testing
@testable import FilmStudioKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct FeedTests {
    @Test func decodesFeedLeniently() throws {
        let feed = try decode(Feed.self, #"""
        {"sections":[
          {"id":"hero","title":"Featured","style":"hero","items":[
            {"id":"m1","kind":"model","title":"Seedance 2.5","subtitle":"The most advanced video model","previewUrl":"/engine/media/a_1.mp4","previewPoster":"/engine/media/a_1.jpg","previewKind":"video","aspect":"16:10","action":{"type":"create","model":"x/seedance","params":{"mode":"video","aspect":"16:9"}}},
            {"id":"t1","title":"Effects","action":{"toolId":"effects"},"preview":{"url":"/engine/media/b.jpg"}},
            {"kind":"broken-no-id"},
            "garbage"
          ]},
          {"id":"future","style":"carousel3d","items":[{"id":"z","title":"Z","action":{"type":"web","params":{"path":"/#z"}}}]},
          {"id":"empty","style":"shelf","items":[]},
          {"title":"no id but title","items":[{"id":"q","title":"Q"}]}
        ],"generatedAt":"2026-11-05"}
        """#)
        #expect(feed.sections.map(\.id) == ["hero", "future", "no id but title"])
        let hero = feed.sections[0]
        #expect(hero.style == .hero && hero.items.count == 2)
        let m = hero.items[0]
        #expect(m.preview?.isVideo == true && m.preview?.still == "/engine/media/a_1.jpg" && m.preview?.video == "/engine/media/a_1.mp4")
        #expect(abs((m.aspect ?? 0) - 1.6) < 0.001)
        #expect(m.action.type == "create" && m.action.model == "x/seedance" && m.action.param("aspect") == "16:9")
        let t = hero.items[1]
        #expect(t.action.type == "tool" && t.action.toolId == "effects")
        #expect(t.preview?.isVideo == false && t.preview?.still == "/engine/media/b.jpg")
        #expect(feed.sections[1].style.rawValue == "carousel3d")
        #expect(feed.sections[2].items[0].action.type == "none")
        // Round trip (the app caches the feed it shows).
        let again = try JSONDecoder().decode(Feed.self, from: JSONEncoder().encode(feed))
        #expect(again == feed)
    }

    @Test func aspectParsing() {
        #expect(FeedItem.parseAspect("9:16") == 9.0 / 16.0)
        #expect(FeedItem.parseAspect(.number(1.5)) == 1.5)
        #expect(FeedItem.parseAspect("1280×720") == 1280.0 / 720.0)
        #expect(FeedItem.parseAspect("wide") == nil)
        #expect(FeedItem.parseAspect(nil) == nil)
    }

    @Test func previewInference() {
        #expect(MediaPreview(url: "/engine/media/a.mp4").isVideo)
        #expect(MediaPreview(url: "/engine/media/a.mp4?t=1").isVideo)
        #expect(!MediaPreview(url: "/engine/media/a.jpg").isVideo)
        #expect(MediaPreview(url: "/engine/media/a", kind: "video").video == "/engine/media/a")
        #expect(MediaPreview(url: "", poster: " ").isEmpty)
    }

    @Test func modelsAndToolsCarryPreviews() throws {
        let cat = try decode(Catalog.self, #"{"models":[{"id":"a/v","kind":"video","available":true,"previewUrl":"/engine/media/v.mp4","previewPoster":"/engine/media/v.jpg"},{"id":"a/i","kind":"image","available":true,"thumbnail":"/engine/media/i.jpg"}]}"#)
        #expect(cat.models[0].preview?.isVideo == true)
        #expect(cat.models[1].preview?.still == "/engine/media/i.jpg")
        let tool = try decode(Tool.self, #"{"id":"fx","title":"FX","previewUrl":"/engine/media/fx.mp4","previewKind":"video"}"#)
        #expect(tool.preview?.video == "/engine/media/fx.mp4")
    }

    @Test func fallbackBuildsSectionsFromEngineData() throws {
        let cat = try decode(Catalog.self, #"""
        {"models":[
          {"id":"p/v1","provider":"p","label":"V1","kind":"video","available":true},
          {"id":"p/v2","provider":"p","label":"V2","kind":"video","available":true,"previewUrl":"/engine/media/v2.mp4"},
          {"id":"h/off","provider":"handoff","label":"Hand-off","kind":"video","available":true},
          {"id":"p/i1","provider":"p","label":"I1","kind":"image","available":true},
          {"id":"p/gone","provider":"p","label":"Gone","kind":"image","available":false}
        ],"providers":{"p":{"label":"Provider P"}}}
        """#)
        let tools = try decode(LossyList<Tool>.self, #"[{"id":"cinema-shot","title":"Cinema Studio","category":"Cinema"},{"id":"effects","title":"Effects","category":"Effects"},{"id":"lipsync","title":"Lipsync Studio","category":"Speak"},{"id":"relight","title":"Relight","category":"Image"}]"#).items
        let media = try decode(LossyList<MediaItem>.self, #"[{"id":"a_1","url":"/engine/media/a_1.mp4","thumb":"/engine/media/a_1.jpg","kind":"videos","model":"p/v1"}]"#).items
        let feed = FeedBuilder.build(.init(catalog: cat, tools: tools, media: media, preferredVideo: ["p/v2"], hiddenProviders: ["handoff"]))
        let ids = feed.sections.map(\.id)
        #expect(ids == ["featured", "video-models", "image-models", "studios", "effects", "tools", "recent", "explore-more"])
        let videos = feed.sections[1].items
        #expect(videos.map(\.title) == ["V2", "V1"]) // preferred first, hidden provider gone
        #expect(videos[0].badge == "Provider P" && videos[0].action.model == "p/v2")
        // A model without its own example borrows a library clip in the hero.
        let hero = feed.sections[0].items
        #expect(hero.first { $0.title == "V1" }?.preview?.video == "/engine/media/a_1.mp4")
        let studios = feed.sections[3].items.map(\.title)
        #expect(studios == ["Cinema Studio", "Films", "Lipsync Studio", "Characters"])
        #expect(feed.sections[4].items.map(\.title) == ["Effects"])
        #expect(!feed.sections[5].items.contains { $0.title == "Cinema Studio" })
        // Feature flags hide sections.
        let noTools = FeedBuilder.build(.init(catalog: cat, tools: tools, features: { $0 != "tools" }))
        #expect(!noTools.sections.map(\.id).contains("tools") && !noTools.sections.map(\.id).contains("effects"))
    }

    @Test func responseCacheRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fs-cache-\(UUID().uuidString)")
        let cache = ResponseCache(directory: dir)
        let server = URL(string: "https://films.example")!
        cache.save(Data(#"{"sections":[{"id":"s","items":[{"id":"i","title":"I"}]}]}"#.utf8), "feed", server: server)
        let feed = cache.load("feed", server: server, as: Feed.self)
        #expect(feed?.sections.first?.items.first?.title == "I")
        #expect(cache.load("feed", server: URL(string: "https://other.example")!) == nil)
        cache.clear()
    }
}
