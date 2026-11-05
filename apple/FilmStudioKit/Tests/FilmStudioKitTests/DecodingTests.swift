import Foundation
import Testing
@testable import FilmStudioKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct DecodingTests {
    @Test func healthLocalAndPocketID() throws {
        let local = try decode(Health.self, #"{"ok":true,"name":"open-higgsfield-engine","version":1,"auth":false,"mode":"code","provider":null,"authed":true,"user":null}"#)
        #expect(local.ok && local.authed && !local.auth && !local.usesPocketID && local.user == nil)
        let oidc = try decode(Health.self, #"{"ok":true,"auth":true,"mode":"oidc","provider":"Pocket ID","authed":true,"user":{"name":"Justin","email":"j@x.de"},"future":42}"#)
        #expect(oidc.usesPocketID && oidc.user?.email == "j@x.de" && oidc.provider == "Pocket ID")
    }

    @Test func mediaSkipsBrokenItems() throws {
        let list = try decode(LossyList<MediaItem>.self, #"""
        [{"id":"a_1","engine":true,"url":"/engine/media/a_1.mp4","thumb":"/engine/media/a_2.jpg","kind":"videos","model":"local/animatic","prompt":"a fox","createdAt":"2026-11-05T10:00:00.123Z","resolution":"1280×720"},
         {"id":"broken"},
         {"id":"a_3","url":"/engine/media/a_3.jpg","kind":"images"},
         "garbage"]
        """#).items
        #expect(list.map(\.id) == ["a_1", "a_3"])
        #expect(list[0].isVideo && list[0].previewURL == "/engine/media/a_2.jpg" && list[0].date != nil)
        #expect(!list[1].isVideo && list[1].previewURL == "/engine/media/a_3.jpg")
    }

    @Test func catalogGroupsAndPicks() throws {
        let cat = try decode(Catalog.self, #"""
        {"models":[
          {"id":"xai/grok-imagine-video-1.5","provider":"xai","label":"Grok Video","kind":"video","available":false,"caps":{"t2v":true,"i2v":true,"end":true},"durations":[6,8,10,15],"aspects":["16:9","9:16"],"resolutions":["480p","720p"],"resolutionDefault":"720p","maxClip":15},
          {"id":"local/animatic","provider":"local","label":"Animatic","blurb":"Free","kind":"video","available":true,"caps":{"t2v":true,"i2v":true},"durations":[4,6,8,10],"aspects":["16:9","9:16","1:1"],"maxClip":15,"newField":{"x":1}},
          {"id":"local/plate","provider":"local","label":"Plate","kind":"image","available":true,"refs":0,"aspects":["16:9"]},
          {"id":"handoff/flow","provider":"handoff","label":"Flow","kind":"video","available":true,"caps":{"t2v":true}},
          {"id":"weird","durations":"not-a-list","available":"yes"},
          {"label":"no id"}
        ],"providers":{"local":{"label":"Offline (ffmpeg)","note":"free"},"xai":{"label":"xAI · Grok","note":""},"bad":7}}
        """#)
        #expect(cat.models.count == 5)
        #expect(cat.model("weird")?.durations == [] && cat.model("weird")?.available == true)
        let groups = cat.groups(kind: "video", hiddenProviders: ["handoff"])
        #expect(groups.map(\.provider) == ["local"])
        #expect(groups.first?.label == "Offline (ffmpeg)")
        #expect(cat.pick(kind: "video", preferred: ["xai/grok-imagine-video-1.5", "local/animatic"])?.id == "local/animatic")
        #expect(cat.pick(kind: "image", preferred: [])?.id == "local/plate")
        let animatic = try #require(cat.model("local/animatic"))
        #expect(animatic.caps.t2v && animatic.caps.i2v && !animatic.caps.end && !animatic.requiresStartImage)
    }

    @Test func jobProgressAndUnknownStatus() throws {
        let j = try decode(Job.self, #"{"id":"j_1","status":"running","message":"Rendering","progress":45,"model":"local/animatic"}"#)
        #expect(j.fraction == 0.45 && !j.status.isFinished)
        let k = try decode(Job.self, #"{"jobId":"j_2","status":"queued-on-gpu","progress":0.5}"#)
        #expect(k.id == "j_2" && k.status.rawValue == "queued-on-gpu" && k.fraction == 0.5)
        let done = try decode(Job.self, #"{"id":"j_3","status":"done","url":"/engine/media/a.mp4","posterUrl":"/engine/media/p.jpg","duration":6.04}"#)
        #expect(done.status == .done && done.status.isFinished && done.duration == 6.04)
    }

    @Test func productionDecodesLeniently() throws {
        let p = try decode(Production.self, #"""
        {"id":"prod_1","title":"The Lake","status":"rendering-v2","message":"Shot 2","brief":{"title":"The Lake","targetMinutes":"2","clipSeconds":6,"videoModel":"local/animatic","narration":true,"characters":[{"name":"Bub"}],"unknown":[1,2]},
         "plan":{"title":"The Lake","logline":"A fox at dawn","style":"film","director":"local"},
         "scenes":[{"id":"sc_1","title":"Dawn","summary":"…"},{"id":"sc_2","title":"Noon"}],
         "shots":[{"id":"sh_b","index":1,"sceneId":"sc_2","prompt":"b","status":"running"},{"id":"sh_a","index":0,"sceneId":"sc_1","prompt":"a","status":"done","posterUrl":"/engine/media/p.jpg","videoUrl":"/engine/media/v.mp4"},{"id":"sh_c","index":2,"sceneId":"sc_2","status":"exploded"}],
         "master":{"assetId":"a_9","url":"/engine/media/m.mp4","duration":18.2,"shots":3},
         "log":[{"at":"2026-11-05T10:00:00Z","msg":"Planned"}],"running":true,"shotCount":20}
        """#)
        #expect(p.status.rawValue == "rendering-v2" && p.status.label == "Rendering-V2")
        #expect(p.brief.targetMinutes == 2 && p.brief.clipSeconds == 6 && p.brief.narration && p.brief.characterNames == ["Bub"])
        #expect(p.shots.map(\.id) == ["sh_a", "sh_b", "sh_c"])
        #expect(p.shots[2].status.rawValue == "exploded")
        #expect(p.sceneGroups.map { $0.scene?.id } == ["sc_1", "sc_2"])
        #expect(p.sceneGroups[1].shots.count == 2)
        #expect(p.isLive && p.doneCount == 1 && p.master?.duration == 18.2)
        #expect(p.shots[0].stillURL == "/engine/media/p.jpg")
    }

    @Test func briefSendsOnlyChanges() {
        var a = Brief()
        a.videoModel = "local/animatic"
        var b = a
        b.title = "New"
        b.targetMinutes = 3
        let diff = b.changes(from: a)
        #expect(Set(diff.keys) == ["title", "targetMinutes"])
        #expect(diff["targetMinutes"] == .number(3))
        #expect(b.shotCount == 23) // 180 s / 8 s
    }

    @Test func characterContract() throws {
        let list = try decode(LossyList<Character>.self, #"""
        [{"id":"ch_1","name":"Bub","description":"Tall, beard","lookNotes":"green coat","voice":{"provider":"eleven","voiceId":"v123"},
          "refs":[{"assetId":"a_1","url":"/engine/media/a_1.jpg","kind":"photo","angle":"front","quality":{"score":0.82,"sharp":true,"issues":[]}},
                  {"assetId":"a_2","url":"/engine/media/a_2.jpg","kind":"video-frame","angle":"threeQuarterLeft","quality":{"score":41,"sharp":0.3,"issues":["blurry","backlit"]}}],
          "sheet":{"assetId":"a_9","url":"/engine/media/a_9.jpg","approved":false},"coverUrl":null,"createdAt":"2026-11-05T10:00:00Z","updatedAt":"2026-11-05T10:00:00Z"},
         {"id":"ch_2","name":"Bubbie","voice":null,"refs":[],"sheet":null}]
        """#).items
        #expect(list.count == 2)
        let bub = list[0]
        #expect(bub.voice == .init(provider: "eleven", voiceId: "v123"))
        #expect(bub.refs[0].quality?.normalizedScore == 0.82)
        #expect(bub.refs[1].quality?.normalizedScore == 0.41 && bub.refs[1].quality?.issues == ["blurry", "backlit"])
        #expect(bub.coverImageURL == "/engine/media/a_9.jpg")
        #expect(list[1].voice == nil && list[1].sheet == nil && list[1].coverImageURL == nil)
        let cov = try decode(Coverage.self, #"{"have":{"front":true,"threeQuarterLeft":2,"profileLeft":0,"smile":false},"missing":["profileLeft","smile"],"tips":["Add a smile"]}"#)
        #expect(cov.has("front") && cov.has("threeQuarterLeft") && !cov.has("profileLeft") && !cov.has("fullBody"))
    }

    @Test func toolSchema() throws {
        let tools = try decode(LossyList<Tool>.self, #"""
        [{"id":"upscale","title":"Upscale","sfSymbol":"arrow.up.left.and.arrow.down.right","category":"Enhance","description":"4× upscale",
          "inputs":[{"key":"image","type":"image","label":"Image","required":true},
                    {"key":"factor","type":"select","label":"Factor","options":[{"value":"2","label":"2×"},"4"],"default":"2"},
                    {"key":"strength","type":"number","min":0,"max":1,"default":0.5},
                    {"key":"faces","type":"toggle","label":"Fix faces"},
                    {"key":"hologram","type":"hologram","label":"Future input"}],
          "run":{"method":"post","path":"/tools/upscale/run"},"output":"image"},
         {"id":"avatar","category":"Characters","inputs":[{"key":"character","type":"character","required":true},{"key":"voice","type":"voice"},{"key":"model","type":"model","modelKind":"video"}]},
         {"title":"no id"}]
        """#).items
        #expect(tools.map(\.id) == ["upscale", "avatar"])
        let up = tools[0]
        #expect(up.run == .init(method: "POST", path: "/tools/upscale/run"))
        #expect(up.inputs[1].options.map(\.label) == ["2×", "4"])
        #expect(up.inputs[2].min == 0 && up.inputs[2].max == 1)
        #expect(!up.inputs[4].kind.isKnown)
        #expect(up.initialValues["factor"] == .string("2") && up.initialValues["faces"] == .bool(false))
        #expect(up.missingInputs(in: up.initialValues) == ["Image"])
        #expect(up.missingInputs(in: ["image": "a_1"]).isEmpty)
        #expect(tools[1].title == "avatar" && tools[1].run.path == "/tools/avatar/run" && tools[1].output == "image")
        #expect(tools[1].inputs[2].modelKind == "video")
        #expect(Tool.grouped(tools).map(\.category) == ["Enhance", "Characters"])
    }

    @Test func soundAndStatus() throws {
        let s = try decode(SoundCatalog.self, #"{"music":[{"id":"google/lyria-3.5","label":"Lyria","available":false}],"voice":[{"id":"eleven","label":"ElevenLabs","available":true,"voices":[{"id":"v1","name":"Justin — clone"}],"defaultVoice":"v1"},{"id":"local","label":"Mac voice","available":true,"voices":["Samantha","Daniel"]}]}"#)
        #expect(s.voice[1].voices.map(\.id) == ["Samantha", "Daniel"])
        #expect(s.allVoices.count == 3)
        let st = try decode(StatusReport.self, #"{"providers":{"local":{"label":"Offline","note":"free","available":true},"xai":{"label":"xAI","available":false}},"xai":{"connected":true},"comfy":false,"llm":{"online":false,"models":[]},"director":null,"eleven":{"available":false},"ffmpeg":true}"#)
        #expect(st.providers.first?.id == "local" && st.ffmpeg && st.xaiSignedIn && st.director == nil)
    }

    @Test func jsonValueRoundTrip() throws {
        let v: JSONValue = ["a": 1, "b": [true, "x", 2.5], "c": nil]
        let back = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(v))
        #expect(back == v)
        #expect(String(decoding: try JSONEncoder().encode(JSONValue.number(8)), as: UTF8.self) == "8")
        #expect(JSONValue.string("12").double == 12 && JSONValue.string("on").bool == true && JSONValue.number(0).isTruthy == false)
    }
}

@Suite struct AppConfigTests {
    @Test func bundledFallbackMatchesEngineShape() {
        let c = AppConfig.fallback
        #expect(c.tabs.map(\.id) == ["library", "create", "films", "characters", "tools", "settings"])
        #expect(c.capture.checklist.count == 9)
        #expect(c.capture.tips.count >= 3)
        #expect(c.isOn("saveToPhotos"))
        #expect(c.interval("jobMs", default: 9999) == .milliseconds(1500))
        #expect(c.defaultList("videoModels").last == "local/animatic")
        #expect(c.hiddenProviders == ["handoff"])
    }

    @Test func partialServerConfigMergesWithDefaults() throws {
        let c = try decode(AppConfig.self, #"""
        {"minVersion":"1.2","notice":{"title":"Heads up","body":"Maintenance at 22:00","level":"warning"},
         "tabs":[{"id":"films","title":"Films","sfSymbol":"film","kind":"web","path":"/#longform"},{"id":"library","title":"Library","sfSymbol":"photo","hidden":false},{"id":"tools","hidden":true},{"id":"films"}],
         "screens":{"filmDetail":{"kind":"web","path":"/#longform?id={id}"},"bad":{"x":1}},
         "features":{"saveToPhotos":false,"newThing":"yes"},"defaults":{"aspect":"9:16"},"polling":{"jobMs":"3000"},"futureKey":{"a":1}}
        """#)
        #expect(c.minVersion == "1.2" && c.latestVersion == "1.0.0")
        #expect(c.visibleTabs.map(\.id) == ["films", "library", "settings"], "hidden removed, dupes dropped, settings always present")
        #expect(c.presentation(for: "films") == (true, "/#longform"))
        #expect(c.presentation(for: "filmDetail") == (true, "/#longform?id={id}"))
        #expect(c.presentation(for: "library").web == false)
        #expect(c.screens["bad"] == nil)
        #expect(!c.isOn("saveToPhotos") && c.isOn("newThing") && c.isOn("deleteMedia") && c.isOn("neverHeardOf"))
        #expect(c.defaultString("aspect") == "9:16" && !c.defaultList("imageModels").isEmpty)
        #expect(c.interval("jobMs", default: 1) == .milliseconds(3000))
        #expect(c.notice?.level == "warning" && c.notice?.id.isEmpty == false)
        #expect(c.capture.checklist.count == 9, "copy falls back to bundled defaults")
    }

    @Test func emptyOrGarbageConfigStillUsable() throws {
        let c = try decode(AppConfig.self, "{}")
        #expect(c.visibleTabs.count == 6)
        let g = try decode(AppConfig.self, #"{"tabs":"nope","features":[1,2],"polling":null,"capture":{"checklist":[{"title":"no id"}]}}"#)
        #expect(g.visibleTabs.count == 6 && g.capture.checklist.count == 9)
    }

    @Test func updates() {
        #expect(AppConfig.updateState(appVersion: "1.0.0", min: "1.0", latest: "1.0.0") == .current)
        #expect(AppConfig.updateState(appVersion: "1.0.0", min: "1.0.0", latest: "1.1") == .available("1.1"))
        #expect(AppConfig.updateState(appVersion: "1.0.9", min: "1.0.10", latest: "1.2") == .required("1.0.10"))
        #expect(VersionNumber("2") > VersionNumber("1.9.9") && VersionNumber("1.0") == VersionNumber("1.0.0"))
    }

    @Test func cacheRoundTrip() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = ConfigCache(directory: dir)
        let server = URL(string: "https://films.heil.haus")!
        #expect(cache.load(server: server) == nil)
        cache.save(Data(#"{"features":{"tools":false}}"#.utf8), server: server)
        #expect(cache.load(server: server)?.isOn("tools") == false)
        #expect(cache.load(server: URL(string: "http://localhost:4848")!) == nil)
    }
}
