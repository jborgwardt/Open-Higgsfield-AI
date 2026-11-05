import Foundation
import Testing
@testable import FilmStudioKit

private func json(_ s: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(s.utf8)) }

@Suite struct MainCharactersShapeTests {
    /// The shape engine/lib/characters.js (merged on main) actually returns, extra fields included.
    @Test func decodesMainShape() throws {
        let c = try JSONDecoder().decode(StudioCharacter.self, from: Data(#"""
        {"id":"ch_x","name":"Bub","description":"","lookNotes":"","voice":null,"realPerson":true,
         "refs":[{"assetId":"a_1","url":"/engine/media/w_1.jpg","originalUrl":"/engine/media/a_1.jpg","kind":"photo","angle":"unknown","expression":null,"status":"analyzing","quality":{"score":null,"sharp":null,"issues":[],"flags":[]},"graded":false},
                 {"assetId":"a_2","url":"/engine/media/a_2.jpg","kind":"sheet","angle":"turnaround","status":"ready","quality":{"score":100,"sharp":0.93,"issues":[],"flags":[]}},
                 {"assetId":"a_3","url":"/engine/media/a_3.jpg","kind":"video-frame","angle":"profileLeft","status":"ready","quality":{"score":57,"sharp":0.41,"issues":["A little soft"],"flags":["soft"]},"error":null}],
         "sheet":null,"approvedSheet":null,"sheetJob":{"jobId":"j_1"},"coverUrl":"/engine/media/a_3.jpg","coverage":{"percent":22,"missing":["front"]},
         "processing":[{"assetId":"a_9","stage":"frames"}],"videos":[],"createdAt":"2026-11-05T10:00:00Z","updatedAt":"2026-11-05T10:00:00Z"}
        """#.utf8))
        #expect(c.refs.count == 3)
        #expect(c.refs[0].isAnalyzing && c.refs[0].quality?.normalizedScore == nil)
        #expect(c.refs[2].quality?.normalizedScore == 0.57 && c.refs[2].quality?.issues == ["A little soft"])
        #expect(c.isProcessing && c.coverImageURL == "/engine/media/a_3.jpg")
    }
}

@Suite struct DirectorParsingTests {
    @Test func shapes() throws {
        let a = DirectorCatalog.parse(try json(#"[{"id":"claude","label":"Claude (your subscription)","available":true,"models":["opus","sonnet"]},{"provider":"xai","name":"Grok","available":false,"reason":"sign in to SuperGrok"},"local"]"#))
        #expect(a.options.map(\.id) == ["claude", "xai", "local"])
        #expect(a.options[0].models.map(\.id) == ["opus", "sonnet"])
        #expect(!a.options[1].available && a.options[1].note == "sign in to SuperGrok")
        #expect(a.current == nil)

        let b = DirectorCatalog.parse(try json(#"{"directors":[{"id":"google","label":"Gemini","available":true,"models":[{"id":"gemini-3-pro","label":"Gemini 3 Pro"}]}],"current":{"provider":"google","model":"gemini-3-pro"}}"#))
        #expect(b.options.count == 1 && b.current == DirectorChoice(provider: "google", model: "gemini-3-pro"))
        #expect(b.describe(b.current) == "Gemini · Gemini 3 Pro")

        let c = DirectorCatalog.parse(try json(#"{"options":{"openai":{"label":"Local LLM","online":true},"local":{"label":"No AI"}},"directorProvider":"","directorModel":""}"#))
        #expect(Set(c.options.map(\.id)) == ["openai", "local"])
        #expect(c.current?.isChosen == false)
        #expect(c.describe(c.current) == "Not chosen")
        #expect(DirectorChoice(provider: "auto").isChosen == false)
    }

    @Test func needsDirectorError() {
        #expect(APIError.server(status: 400, message: "Choose a director first").needsDirector)
        #expect(APIError.server(status: 409, message: "No director chosen — pick one in Settings").needsDirector)
        #expect(!APIError.server(status: 409, message: "pause the production before re-planning").needsDirector)
    }

    @Test func synthesizedFromOldStatus() throws {
        let s = try json(#"{"providers":{"xai":{"available":true},"google":{"available":false}},"llm":{"online":false,"models":[]},"directorModels":{"apimart":["claude-opus-5","gpt-5.4"]}}"#)
        let c = DirectorCatalog.synthesized(from: s)
        #expect(c.option("xai")?.available == true && c.option("google")?.available == false)
        #expect(c.option("apimart")?.models.count == 2)
        #expect(c.option("split")?.available == true && c.option("local") == nil)
    }

    /// The engine's real GET /directors shape (QA-02).
    @Test func engineProvidersShape() throws {
        let v = try json(#"{"selected":"split","model":"","providers":[{"id":"claude","label":"Claude (your subscription)","note":"","defaultModel":"opus","available":true,"detail":"","models":[{"id":"opus","label":"opus"}]},{"id":"qwen","label":"Qwen Cloud Token Plan","available":false,"detail":"set QWEN_API_KEY","models":[]},{"id":"split","label":"No AI (split my script)","available":true,"models":[]}]}"#)
        let c = DirectorCatalog.parse(v)
        #expect(c.options.map(\.id) == ["claude", "qwen", "split"])
        #expect(c.option("claude")?.defaultModel == "opus" && c.option("qwen")?.available == false)
        #expect(c.current == DirectorChoice(provider: "split", model: ""))
        #expect(c.describe(c.current) == "No AI (split my script)")
        let none = DirectorCatalog.parse(try json(#"{"selected":null,"model":"","providers":[{"id":"split","label":"No AI"}]}"#))
        #expect(none.current == nil && none.options.count == 1)
    }
}

extension NetworkTests {
@Suite struct DirectorClientTests {
    private func client() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return APIClient(baseURL: URL(string: "https://films.heil.haus")!, session: URLSession(configuration: config), token: { "t" })
    }

    @Test func fallsBackToStatusThenSettings() async throws {
        StubProtocol.reset { req, _ in
            switch req.url!.path {
            case "/engine/api/directors": .init(status: 404, body: #"{"error":"no such route"}"#)
            case "/engine/api/status": .init(body: #"{"providers":{},"directors":[{"id":"claude","label":"Claude","available":true},{"id":"local","label":"No AI","available":true}]}"#)
            case "/engine/api/settings": .init(body: #"{"directorProvider":"claude","directorModel":"opus"}"#)
            default: .init(status: 500)
            }
        }
        let c = try await client().directors()
        #expect(c.options.map(\.id) == ["claude", "local"])
        #expect(c.current == DirectorChoice(provider: "claude", model: "opus"))
    }

    @Test func prefersDirectorsRoute() async throws {
        StubProtocol.reset { req, _ in
            req.url!.path == "/engine/api/directors"
                ? .init(body: #"{"directors":[{"id":"xai","label":"Grok","available":true}],"current":{"provider":"xai"}}"#)
                : .init(status: 500)
        }
        let c = try await client().directors()
        #expect(c.options.map(\.id) == ["xai"] && c.current?.provider == "xai")
        #expect(StubProtocol.all.count == 1)
    }

    @Test func persistsChoice() async throws {
        StubProtocol.reset { _, _ in .init(body: #"{"settings":{},"status":{}}"#) }
        try await client().setDirector(DirectorChoice(provider: "apimart", model: "claude-opus-5"))
        let (req, body) = try #require(StubProtocol.last)
        #expect(req.httpMethod == "POST" && req.url!.path == "/engine/api/directors")
        let o = try JSONDecoder().decode([String: JSONValue].self, from: body)
        #expect(o == ["provider": "apimart", "model": "claude-opus-5"])
    }

    @Test func persistsChoiceOnOldEngine() async throws {
        StubProtocol.reset { req, _ in
            req.url!.path == "/engine/api/directors" ? .init(status: 404, body: #"{"error":"no such route"}"#) : .init(body: #"{"settings":{}}"#)
        }
        try await client().setDirector(DirectorChoice(provider: "local"))
        let (req, body) = try #require(StubProtocol.last)
        #expect(req.url!.path == "/engine/api/settings")
        let o = try JSONDecoder().decode([String: JSONValue].self, from: body)
        #expect(o == ["directorProvider": "split", "directorModel": ""])
    }
}
}
