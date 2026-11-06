import Foundation

/// Google AI Ultra plan sign-in on the studio (the plan's included Nano Banana, Lyria and voices).
/// Public metadata only: the Google tokens stay on the studio server.
public struct GoogleUltraStatus: Decodable, Hashable, Sendable {
    public var connected: Bool
    public var email: String?
    /// Whether the studio has the OAuth client secret it needs to finish a sign-in.
    public var hasSecret: Bool

    public init(connected: Bool, email: String? = nil, hasSecret: Bool = true) {
        self.connected = connected; self.email = email; self.hasSecret = hasSecret
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyKey.self)
        connected = c.bool("connected", default: false)
        email = c.string("email")?.nonEmpty
        hasSecret = c.bool("hasSecret", default: true)
    }
}

/// The Google consent page for a plan sign-in. Only official HTTPS Google origins are ever opened.
public struct GoogleUltraLogin: Decodable, Sendable {
    public var url: String

    public var consentURL: URL? {
        guard let components = URLComponents(string: url),
              components.scheme?.lowercased() == "https",
              components.user == nil, components.password == nil,
              components.port == nil || components.port == 443,
              let host = components.host?.lowercased(),
              host == "google.com" || host.hasSuffix(".google.com") else { return nil }
        return components.url
    }
}

public extension APIClient {
    func googleUltraStatus() async throws -> GoogleUltraStatus {
        let path = "/google-ultra/login"
        var request = makeRequest("GET", path)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data = try await perform(request, route: path)
        return try decode(GoogleUltraStatus.self, from: data, route: path)
    }

    /// Starts a sign-in; open the returned consent page in the browser.
    func beginGoogleUltraLogin() async throws -> GoogleUltraLogin {
        try await send("POST", "/google-ultra/login")
    }

    /// `code` is the authorization code or the whole localhost address the browser was sent to.
    func completeGoogleUltraLogin(code: String) async throws -> GoogleUltraStatus {
        try await send("POST", "/google-ultra/login/complete", json: ["code": .string(code.trimmingCharacters(in: .whitespacesAndNewlines))])
    }

    func signOutGoogleUltra() async throws -> GoogleUltraStatus {
        try await send("POST", "/google-ultra/logout")
    }
}
