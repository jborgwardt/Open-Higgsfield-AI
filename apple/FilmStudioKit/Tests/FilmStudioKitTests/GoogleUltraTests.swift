import Foundation
import Testing
@testable import FilmStudioKit

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(T.self, from: Data(json.utf8))
}

@Suite struct GoogleUltraTests {
    @Test func decodesLoginStatus() throws {
        let s = try decode(GoogleUltraStatus.self, #"{"connected":true,"email":"me@example.com","hasSecret":true}"#)
        #expect(s.connected && s.email == "me@example.com" && s.hasSecret)
        let out = try decode(GoogleUltraStatus.self, #"{"connected":false,"email":null,"hasSecret":false}"#)
        #expect(!out.connected && out.email == nil && !out.hasSecret)
    }

    @Test func opensOnlyGoogleConsentPages() throws {
        #expect(try decode(GoogleUltraLogin.self, #"{"url":"https://accounts.google.com/o/oauth2/v2/auth?client_id=x"}"#).consentURL != nil)
        #expect(try decode(GoogleUltraLogin.self, #"{"url":"http://accounts.google.com/x"}"#).consentURL == nil)
        #expect(try decode(GoogleUltraLogin.self, #"{"url":"https://evilgoogle.com/x"}"#).consentURL == nil)
        #expect(try decode(GoogleUltraLogin.self, #"{"url":"https://google.com.evil.example/x"}"#).consentURL == nil)
    }

    @Test func statusCarriesUltraSignIn() throws {
        let r = try decode(StatusReport.self, #"{"providers":{"google":{"label":"Google · Gemini API (paid key)","available":true},"google-ultra":{"label":"Google AI Ultra (your plan)","available":false}},"googleUltra":{"connected":false,"email":null,"hasSecret":true}}"#)
        #expect(r.googleUltra == GoogleUltraStatus(connected: false, email: nil, hasSecret: true))
        #expect(Set(r.providers.map(\.label)) == ["Google · Gemini API (paid key)", "Google AI Ultra (your plan)"])
        #expect(try decode(StatusReport.self, #"{"providers":{}}"#).googleUltra == nil)
    }

    @Test func paidApiAndPlanAreSeparateGroups() throws {
        let c = try decode(Catalog.self, #"{"models":[{"id":"google/gemini-3-pro-image","provider":"google","label":"Nano Banana Pro (Gemini API)","kind":"image","available":true},{"id":"google-ultra/nano-banana-pro","provider":"google-ultra","label":"Nano Banana Pro (AI Ultra plan)","kind":"image","available":true}],"providers":{}}"#)
        let groups = c.groups(kind: "image")
        #expect(groups.map(\.provider) == ["google", "google-ultra"])
        #expect(groups.map(\.label) == ["Google · Gemini API (paid key)", "Google AI Ultra (your plan)"])
        // The billing source stays visible on the model itself.
        #expect(c.models.map(\.displayName) == ["Nano Banana Pro (Gemini API)", "Nano Banana Pro (AI Ultra plan)"])
    }

    @Test func directorNames() throws {
        #expect(DirectorCatalog.displayName("google") == "Google Gemini API")
        #expect(DirectorCatalog.displayName("google-ultra") == "Google AI Ultra")
        let s = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"providers":{"google":{"available":true}},"googleUltra":{"connected":true}}"#.utf8))
        let c = DirectorCatalog.synthesized(from: s)
        #expect(c.option("google-ultra")?.available == true && c.option("google-ultra")?.defaultModel == "gemini-3.8-flash")
        #expect(c.option("google")?.label == "Google Gemini API (paid key)")
    }
}
