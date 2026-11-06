import Foundation
import Testing
@testable import FilmStudioKit

@Suite struct ChatGPTLocalSignInTests {
    @Test func authorizationBindsTheHostAndAttemptWithPKCE() throws {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        let url = ChatGPTOAuth.authorizationURL(redirectURI: "http://127.0.0.1:54321/auth/callback",
            state: "attempt-state", nonce: "studio-nonce", verifier: verifier,
            hostID: "urn:uuid:testing", clientID: nil)
        let fields = Dictionary(uniqueKeysWithValues: try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems).map { ($0.name, $0.value ?? "") })
        #expect(url.scheme == "https" && url.host == "auth.openai.com")
        #expect(url.path == "/api/accounts/authorize")
        #expect(fields["client_id"] == "dynamic_agent_client")
        #expect(fields["agent_name_hint"] == "Film Studio")
        #expect(fields["ext_agent_host_id"] == "urn:uuid:testing")
        #expect(fields["state"] == "attempt-state" && fields["nonce"] == "studio-nonce")
        #expect(fields["resource"] == "https://api.openai.com/v1")
        #expect(fields["redirect_uri"] == "http://127.0.0.1:54321/auth/callback")
        #expect(fields["code_challenge_method"] == "S256")
        // RFC 7636 Appendix B test vector, independent of our SHA-256 implementation.
        #expect(fields["code_challenge"] == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        #expect(!url.absoluteString.contains(verifier))
    }

    @Test func returningAccountReusesItsIssuedClient() throws {
        let url = ChatGPTOAuth.authorizationURL(redirectURI: "http://127.0.0.1:54321/auth/callback",
            state: "state", nonce: "nonce", verifier: "verifier", hostID: "host", clientID: "issued-client")
        let fields = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        #expect(fields.first(where: { $0.name == "client_id" })?.value == "issued-client")
        #expect(!fields.contains(where: { $0.name == "agent_name_hint" }))
        let callback = try ChatGPTOAuth.callback(target: "/auth/callback?state=state&code=code", state: "state", clientID: "issued-client")
        #expect(callback.clientID == "issued-client")
    }

    @Test(arguments: [
        "/auth/callback?state=other&code=x&client_id=issued",
        "/auth/callback?state=state&state=state&code=x&client_id=issued",
        "/auth/callback?state=state&code=x&code=y&client_id=issued",
        "/auth/callback?state=state&code=x&client_id=different",
        "/auth/callback?state=state&code=&client_id=issued",
        "/callback?state=state&code=x&client_id=issued",
        "/auth/callback?state=state&code=x&client_id=issued#fragment",
        "https://evil.example/auth/callback?state=state&code=x&client_id=issued"
    ]) func rejectsCallbackSubstitution(target: String) {
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callback(target: target, state: "state", clientID: "issued")
        }
    }

    @Test func newRegistrationNeedsIssuedClientAndChecksStateBeforeDenial() {
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callback(target: "/auth/callback?state=state&code=x", state: "state", clientID: nil)
        }
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callback(target: "/auth/callback?state=state&code=x&client_id=dynamic_agent_client", state: "state", clientID: nil)
        }
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callback(target: "/auth/callback?state=wrong&error=access_denied", state: "state", clientID: nil)
        }
        #expect(throws: ChatGPTSignInError.denied) {
            try ChatGPTOAuth.callback(target: "/auth/callback?state=state&error=access_denied", state: "state", clientID: nil)
        }
    }

    @Test(arguments: ["evil.example:54321", "localhost:54321", "127.0.0.1:12345", "127.0.0.1:54321\r\nHost: evil.example", "127.0.0.1:54321\r\n folded: header"])
    func rejectsHostRebinding(host: String) {
        let request = "GET /auth/callback?state=state&code=x&client_id=issued HTTP/1.1\r\nHost: \(host)\r\n\r\n"
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callbackRequest(request, port: 54321, state: "state", clientID: nil)
        }
    }

    @Test func acceptsOnlyLoopbackGetForTheListeningPort() throws {
        let request = "GET /auth/callback?state=state&code=x&client_id=issued HTTP/1.1\r\nHost: 127.0.0.1:54321\r\n\r\n"
        #expect(try ChatGPTOAuth.callbackRequest(request, port: 54321, state: "state", clientID: nil).code == "x")
        #expect(throws: ChatGPTSignInError.invalidCallback) {
            try ChatGPTOAuth.callbackRequest(request.replacingOccurrences(of: "GET ", with: "POST "), port: 54321, state: "state", clientID: nil)
        }
    }

    @Test func codeExchangeRetainsResourceCallbackAndLiteralPlus() throws {
        let request = ChatGPTOAuth.tokenRequest(callback: .init(code: "a+b&c", clientID: "issued-client"),
            redirectURI: "http://127.0.0.1:54321/auth/callback", verifier: "verifier")
        let body = String(decoding: try #require(request.httpBody), as: UTF8.self)
        #expect(request.url?.absoluteString == "https://auth.openai.com/api/accounts/oauth/token")
        #expect(request.httpMethod == "POST")
        #expect(body.contains("code=a%2Bb%26c"))
        let items = try #require(URLComponents(string: "https://example.invalid/?" + body)?.queryItems)
        let fields = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        #expect(fields["resource"] == "https://api.openai.com/v1")
        #expect(fields["redirect_uri"] == "http://127.0.0.1:54321/auth/callback")
        #expect(fields["client_id"] == "issued-client")
        #expect(fields["code_verifier"] == "verifier")
    }

    @Test func identityOnlyConsentCannotEnablePlanUsage() throws {
        let data = Data(#"{"access_token":"a","refresh_token":"r","id_token":"i","scope":"openid profile email offline_access","token_type":"Bearer","expires_in":3600}"#.utf8)
        #expect(throws: ChatGPTSignInError.missingPlanPermission) {
            try ChatGPTOAuth.credentials(from: data, clientID: "issued")
        }
    }

    #if os(macOS)
    @MainActor @Test func hostIdentityIsStableWithoutSavingCredentials() throws {
        let suite = "FilmStudioTests.ChatGPTHost.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = ChatGPTLocalSignIn.stableHostID(defaults: defaults)
        #expect(first.hasPrefix("urn:uuid:"))
        #expect(UUID(uuidString: String(first.dropFirst(9))) != nil)
        #expect(ChatGPTLocalSignIn.stableHostID(defaults: defaults) == first)
        #expect(defaults.persistentDomain(forName: suite)?.count == 1)
    }

    @MainActor @Test func cancellingTheLoopbackAttemptAllowsAFreshAttempt() async throws {
        let attempt = try JSONDecoder().decode(CodexConnectionAttempt.self, from: Data(#"{"connectionId":"attempt","nonce":"nonce","expiresAt":"2030-01-01T00:00:00Z"}"#.utf8))
        let flow = ChatGPTLocalSignIn()
        var states: [String] = []
        for _ in 0..<2 {
            await #expect(throws: CancellationError.self) {
                try await flow.authorize(attempt: attempt, hostID: "urn:uuid:testing") { url in
                    let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
                    let redirect = query.first(where: { $0.name == "redirect_uri" })?.value.flatMap(URL.init(string:))
                    #expect(redirect?.host == "127.0.0.1" && redirect?.path == "/auth/callback")
                    #expect(redirect?.port != nil)
                    if let state = query.first(where: { $0.name == "state" })?.value { states.append(state) }
                    flow.cancel()
                }
            }
        }
        #expect(states.count == 2 && states[0] != states[1])
    }
    #endif
}

extension NetworkTests {
    @Suite struct ChatGPTTransferTests {
        private func attempt() throws -> CodexConnectionAttempt {
            try JSONDecoder().decode(CodexConnectionAttempt.self, from: Data(#"{"connectionId":"attempt","nonce":"nonce","expiresAt":"2030-01-01T00:00:00Z"}"#.utf8))
        }
        private var credentials: ChatGPTCredentials {
            ChatGPTCredentials(clientID: "issued", accessToken: "secret-access", refreshToken: "secret-refresh",
                idToken: "secret-id", scope: ChatGPTOAuth.scopes, tokenType: "Bearer", expiresIn: 3600)
        }
        private func client(_ base: String = "https://studio.example", events: EventLog = EventLog()) -> APIClient {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [StubProtocol.self]
            return APIClient(baseURL: URL(string: base)!, session: URLSession(configuration: config),
                token: { "studio-session" }, onEvent: { events.add($0) })
        }

        @Test func insecureCredentialTransferNeverMakesARequest() async throws {
            StubProtocol.reset { _, _ in .init() }
            for base in ["http://studio.example", "http://127.0.0.1:4848", "https://user:password@studio.example"] {
                let api = client(base)
                await #expect(throws: ChatGPTSignInError.insecureStudio) {
                    try await api.completeCodexConnection(attempt(), credentials: credentials)
                }
            }
            #expect(StubProtocol.all.isEmpty)
        }

        @Test func credentialTransferNeedsAStudioSignIn() async throws {
            StubProtocol.reset { _, _ in .init() }
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [StubProtocol.self]
            for token in [nil, "", "   "] as [String?] {
                let api = APIClient(baseURL: URL(string: "https://studio.example")!, session: URLSession(configuration: config), token: { token })
                #expect(!api.canTransferCodexCredentials)
                await #expect(throws: ChatGPTSignInError.notSignedIn) { try await api.beginCodexConnection() }
                await #expect(throws: ChatGPTSignInError.notSignedIn) {
                    try await api.completeCodexConnection(attempt(), credentials: credentials)
                }
            }
            #expect(StubProtocol.all.isEmpty)
        }

        @Test func credentialTransferUsesOnlySelectedStudioAndAuthenticatedPost() async throws {
            StubProtocol.reset { _, _ in .init(body: #"{"installed":true,"loggedIn":true,"available":true,"state":"connected","loginMethod":"mac_local_oauth"}"#) }
            let status = try await client().completeCodexConnection(attempt(), credentials: credentials)
            #expect(status.loggedIn)
            let (request, body) = try #require(StubProtocol.last)
            #expect(request.url?.absoluteString == "https://studio.example/engine/api/codex/login/complete")
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer studio-session")
            let payload = try JSONDecoder().decode([String: JSONValue].self, from: body)
            #expect(payload["connectionId"] == "attempt" && payload["clientId"] == "issued")
            #expect(payload["refreshToken"] == "secret-refresh" && payload["accessToken"] == "secret-access")
            #expect(StubProtocol.all.count == 1)
        }

        @Test func failedCredentialResponseIsNotLoggedOrExposed() async throws {
            StubProtocol.reset { _, _ in .init(status: 400, body: #"{"error":"secret-access secret-refresh"}"#) }
            let events = EventLog()
            await #expect(throws: ChatGPTSignInError.transferFailed) {
                try await client(events: events).completeCodexConnection(attempt(), credentials: credentials)
            }
            #expect(events.events.isEmpty)
        }

        @Test func secureTransportDisablesPersistenceAndRedirects() async throws {
            let session = ChatGPTSecureTransport.session(configuration: .default)
            defer { session.invalidateAndCancel() }
            #expect(session.configuration.urlCache == nil)
            #expect(session.configuration.httpCookieStorage == nil)
            #expect(session.configuration.urlCredentialStorage == nil)
            let redirect = URLRequest(url: URL(string: "https://other.example/collect")!)
            let response = try #require(HTTPURLResponse(url: URL(string: "https://studio.example")!, statusCode: 307, httpVersion: nil, headerFields: ["Location": redirect.url!.absoluteString]))
            let delegate = try #require(session.delegate as? URLSessionTaskDelegate)
            let task = session.dataTask(with: URL(string: "https://studio.example")!)
            let accepted = await withCheckedContinuation { continuation in
                delegate.urlSession?(session, task: task, willPerformHTTPRedirection: response, newRequest: redirect) {
                    continuation.resume(returning: $0)
                }
            }
            #expect(accepted == nil)
        }
    }
}
