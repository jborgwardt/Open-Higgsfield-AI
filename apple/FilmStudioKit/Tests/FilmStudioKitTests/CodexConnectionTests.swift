import Foundation
import Testing
@testable import FilmStudioKit

private func connectionJSON(state: String = "signed_out", url: String? = nil, extra: [String: Any] = [:]) throws -> Data {
    var object: [String: Any] = [
        "installed": true, "loggedIn": state == "connected", "available": state == "connected",
        "state": state, "verificationUrl": url as Any? ?? NSNull(),
        "userCode": NSNull(), "expiresAt": NSNull(), "account": NSNull(), "error": NSNull()
    ]
    object.merge(extra, uniquingKeysWith: { _, new in new })
    return try JSONSerialization.data(withJSONObject: object)
}

@Suite struct CodexConnectionDecodingTests {
    @Test func signedOutDoesNotImplySignInCapability() throws {
        let status = try JSONDecoder().decode(CodexConnectionStatus.self, from: connectionJSON())
        #expect(status.state == .signedOut)
        #expect(!status.loggedIn)
        #expect(!status.available)
        #expect(status.loginMethod == nil)
        #expect(status.verificationURL == nil)
        #expect(status.account == nil)
    }

    @Test func pendingCanUseURLWithoutUserCode() throws {
        let status = try JSONDecoder().decode(CodexConnectionStatus.self, from: connectionJSON(
            state: "pending", url: "https://auth.openai.com/example",
            extra: ["expiresAt": "2026-11-06T01:00:00.000Z"]))
        #expect(status.state == .pending)
        #expect(status.userCode == nil)
        #expect(status.verificationURL?.host == "auth.openai.com")
        #expect(status.expirationDate != nil)
    }

    @Test func connectedAccountFieldsAreOptional() throws {
        let status = try JSONDecoder().decode(CodexConnectionStatus.self, from: connectionJSON(
            state: "connected", extra: ["account": ["plan": "Plus"]]))
        #expect(status.available)
        #expect(status.loggedIn)
        #expect(status.account?.plan == "Plus")
        #expect(status.account?.email == nil)
    }

    @Test(arguments: [
        "http://auth.openai.com/login", "https://openai.com.evil.example/login",
        "https://notopenai.com/login", "https://chatgpt.com@evil.example/login",
        "https://user:password@auth.openai.com/login", "file:///tmp/login",
        "https://chatgpt.com:8443/login", "//chatgpt.com/login"
    ]) func rejectsUnsafeSignInDestinations(url: String) throws {
        let status = try JSONDecoder().decode(CodexConnectionStatus.self, from: connectionJSON(state: "pending", url: url))
        #expect(status.verificationURL == nil)
    }

    @Test func unknownStateFailsClosed() throws {
        #expect(throws: DecodingError.self) {
            try JSONDecoder().decode(CodexConnectionStatus.self, from: connectionJSON(state: "unexpected"))
        }
    }
}

extension NetworkTests {
    @Suite struct CodexConnectionClientTests {
        @Test func statusIsAuthenticatedReadOnlyAndUncached() async throws {
            let body = String(decoding: try connectionJSON(), as: UTF8.self)
            StubProtocol.reset { _, _ in .init(body: body) }
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [StubProtocol.self]
            let client = APIClient(baseURL: URL(string: "https://studio.example")!,
                                   session: URLSession(configuration: config), token: { "test-session" })
            let status = try await client.codexConnection()
            #expect(status.state == .signedOut)
            let (request, data) = try #require(StubProtocol.last)
            #expect(request.url?.path == "/engine/api/codex/login")
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-session")
            #expect(request.cachePolicy == .reloadIgnoringLocalCacheData)
            #expect(data.isEmpty)
            #expect(StubProtocol.all.count == 1)
        }
    }
}
