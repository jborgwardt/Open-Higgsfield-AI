import Foundation

/// Public connection metadata only. Account credentials stay on the studio server.
public struct CodexConnectionStatus: Decodable, Hashable, Sendable {
    public enum State: String, Decodable, Sendable {
        case signedOut = "signed_out"
        case pending
        case connected
        case error
    }

    public struct Account: Decodable, Hashable, Sendable {
        public let email: String?
        public let plan: String?
    }

    public let installed: Bool
    public let loggedIn: Bool
    public let available: Bool
    public let state: State
    public let verificationUrl: String?
    public let userCode: String?
    public let expiresAt: String?
    public let account: Account?
    public let error: String?
    /// A missing or unrecognized capability must never enable a sign-in flow.
    public let loginMethod: String?

    public var expirationDate: Date? { ISODate.parse(expiresAt) }

    /// Only open sign-in destinations on official HTTPS origins, never arbitrary server URLs.
    public var verificationURL: URL? {
        guard let verificationUrl,
              let components = URLComponents(string: verificationUrl),
              components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil || components.port == 443,
              let host = components.host?.lowercased(),
              host == "openai.com" || host.hasSuffix(".openai.com") ||
                host == "chatgpt.com" || host.hasSuffix(".chatgpt.com") else { return nil }
        return components.url
    }
}

public extension APIClient {
    /// Reading the connection never starts sign-in or changes the chosen director.
    func codexConnection() async throws -> CodexConnectionStatus {
        let path = "/codex/login"
        var request = makeRequest("GET", path)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data = try await perform(request, route: path)
        return try decode(CodexConnectionStatus.self, from: data, route: path)
    }

    func beginCodexConnection() async throws -> CodexConnectionAttempt {
        guard hasStudioSession else { throw ChatGPTSignInError.notSignedIn }
        guard canTransferCodexCredentials else { throw ChatGPTSignInError.insecureStudio }
        return try await send("POST", "/codex/login")
    }

    func cancelCodexConnection(_ connectionID: String) async throws -> CodexConnectionStatus {
        try await send("POST", "/codex/login/cancel", json: ["connectionId": .string(connectionID)])
    }

    func disconnectCodex() async throws -> CodexConnectionStatus {
        try await send("POST", "/codex/logout")
    }

    /// Credentials only ever go to an HTTPS studio this app is signed in to (a non-empty studio session).
    var canTransferCodexCredentials: Bool {
        baseURL.scheme?.lowercased() == "https" && baseURL.user == nil && baseURL.password == nil && hasStudioSession
    }

    /// A real studio sign-in (Pocket ID session or access code), not just a server address.
    var hasStudioSession: Bool { !(token ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// No redirects, disk cache, or diagnostics containing the credential response.
    func completeCodexConnection(_ attempt: CodexConnectionAttempt, credentials: ChatGPTCredentials) async throws -> CodexConnectionStatus {
        guard hasStudioSession else { throw ChatGPTSignInError.notSignedIn }
        guard canTransferCodexCredentials else { throw ChatGPTSignInError.insecureStudio }
        let body: [String: JSONValue] = [
            "connectionId": .string(attempt.connectionId), "clientId": .string(credentials.clientID),
            "accessToken": .string(credentials.accessToken), "refreshToken": .string(credentials.refreshToken),
            "idToken": .string(credentials.idToken), "scope": .string(credentials.scope),
            "tokenType": .string(credentials.tokenType), "expiresIn": .number(Double(credentials.expiresIn))
        ]
        let request = makeRequest("POST", "/codex/login/complete", body: try JSONEncoder().encode(body))
        let secureSession = ChatGPTSecureTransport.session(configuration: session.configuration)
        defer { secureSession.invalidateAndCancel() }
        let data: Data, response: URLResponse
        do { (data, response) = try await secureSession.data(for: request) }
        catch { if Task.isCancelled { throw CancellationError() }; throw ChatGPTSignInError.transferFailed }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw ChatGPTSignInError.transferFailed
        }
        guard let status = try? JSONDecoder().decode(CodexConnectionStatus.self, from: data) else {
            throw ChatGPTSignInError.transferFailed
        }
        return status
    }
}

public struct CodexConnectionAttempt: Decodable, Sendable {
    public let connectionId: String
    public let nonce: String
    public let expiresAt: String
    public let clientId: String?
    public var expirationDate: Date? { ISODate.parse(expiresAt) }
}

public enum ChatGPTSignInError: Error, LocalizedError, Equatable, Sendable {
    case insecureStudio, notSignedIn, invalidCallback, denied, timedOut, listenerUnavailable
    case tokenExchangeFailed, missingPlanPermission, transferFailed, invalidAttempt, alreadyRunning

    public var errorDescription: String? {
        switch self {
        case .insecureStudio: "ChatGPT sign-in requires an HTTPS studio server."
        case .notSignedIn: "Sign in to your studio first, then connect ChatGPT."
        case .invalidCallback: "The sign-in response did not match this attempt. Start again."
        case .denied: "ChatGPT sign-in was not approved."
        case .timedOut: "Sign-in expired. Start again when you're ready."
        case .listenerUnavailable: "Film Studio couldn't open its local sign-in callback. Try again."
        case .tokenExchangeFailed: "ChatGPT couldn't complete this sign-in. Start a new attempt."
        case .missingPlanPermission: "ChatGPT plan usage wasn't granted. Authorize plan usage when signing in."
        case .transferFailed: "The studio couldn't verify and save the ChatGPT connection. Refresh its status before trying again."
        case .invalidAttempt: "The studio returned an invalid or expired sign-in attempt."
        case .alreadyRunning: "A ChatGPT sign-in is already in progress."
        }
    }
}

/// Lives only during code exchange and secure transfer; never persisted on this Mac.
public struct ChatGPTCredentials: Sendable {
    let clientID: String
    let accessToken: String
    let refreshToken: String
    let idToken: String
    let scope: String
    let tokenType: String
    let expiresIn: Int
}

enum ChatGPTSecureTransport {
    private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }

    static func session(configuration source: URLSessionConfiguration = .ephemeral) -> URLSession {
        let configuration = source.copy() as! URLSessionConfiguration
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 45
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }
}
