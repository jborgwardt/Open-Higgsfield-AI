import Foundation
import Security

/// Native sign-in with ASWebAuthenticationSession:
/// `<server>/engine/auth/native?state=…` → Pocket ID passkey → `filmstudio://auth?session=…&state=…`.
public enum NativeSignIn {
    public static let callbackScheme = "filmstudio"

    public static func newState() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func startURL(server: URL, state: String) -> URL {
        var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
        c.percentEncodedPath = c.percentEncodedPath.trimmingSuffix("/") + "/engine/auth/native"
        c.queryItems = [URLQueryItem(name: "state", value: state)]
        return c.url!
    }

    public enum Failure: Error, LocalizedError, Equatable {
        case notOurCallback
        case stateMismatch
        case server(String)
        case noSession
        public var errorDescription: String? {
            switch self {
            case .notOurCallback: "Sign-in returned to the wrong place."
            case .stateMismatch: "Sign-in check failed. Please try again."
            case .server(let m): m
            case .noSession: "Sign-in didn't return a session."
            }
        }
    }

    /// Validates the callback and returns the session token.
    public static func session(from callback: URL, expectedState: String) throws -> String {
        guard callback.scheme?.lowercased() == callbackScheme, callback.host?.lowercased() == "auth",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems else { throw Failure.notOurCallback }
        let q = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        if let e = q["error"], !e.isEmpty {
            // An error is only trusted (shown) for our own attempt.
            guard q["state"] == expectedState else { throw Failure.stateMismatch }
            throw Failure.server(e)
        }
        guard q["state"] == expectedState else { throw Failure.stateMismatch }
        guard let s = q["session"], !s.isEmpty else { throw Failure.noSession }
        return s
    }
}

/// The user-entered server address.
public enum ServerAddress {
    public static let defaultURL = URL(string: "https://films.heil.haus")!

    public enum Problem: Error, LocalizedError, Equatable {
        case empty, invalid, insecure
        public var errorDescription: String? {
            switch self {
            case .empty: "Enter the studio's address."
            case .invalid: "That doesn't look like a web address."
            case .insecure: "Use https:// — plain http is only allowed for localhost."
            }
        }
    }

    /// Normalizes input like "films.heil.haus", "https://films.heil.haus/", "localhost:4848" or a pasted
    /// "…/engine/api/health" URL to the server origin (plus any base path).
    public static func parse(_ input: String) throws -> URL {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { throw Problem.empty }
        if !s.contains("://") {
            let hostPart = s.split(separator: "/").first.map(String.init) ?? s
            s = (isLocalHost(hostPart.split(separator: ":").first.map(String.init) ?? hostPart) || hostPart.hasPrefix("[::1]") ? "http://" : "https://") + s
        }
        guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = c.host, !host.isEmpty else { throw Problem.invalid }
        if scheme == "http" && !isLocalHost(host) { throw Problem.insecure }
        c.scheme = scheme
        c.host = host.lowercased()
        c.query = nil
        c.fragment = nil
        var path = c.path
        if let r = path.range(of: "/engine/") { path = String(path[..<r.lowerBound]) }
        while path.hasSuffix("/") { path.removeLast() }
        c.path = path
        guard let url = c.url else { throw Problem.invalid }
        return url
    }

    public static func isLocalHost(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        return h == "localhost" || h == "127.0.0.1" || h == "::1"
    }
    public static func isLocal(_ url: URL) -> Bool { isLocalHost(url.host ?? "") }
}

/// Where the session token lives.
public protocol TokenStore: Sendable {
    func token(for server: URL) -> String?
    func setToken(_ token: String?, for server: URL)
}

/// Session tokens in the Keychain, one per server (so switching servers keeps each sign-in).
public final class KeychainTokenStore: TokenStore, @unchecked Sendable {
    private let service: String
    private let cache = NSCache<NSString, NSString>()
    public init(service: String = "com.borgwardt.filmstudio.session") { self.service = service }

    private func base(_ server: URL) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: server.absoluteString]
    }

    public func token(for server: URL) -> String? {
        if let c = cache.object(forKey: server.absoluteString as NSString) { return c.length == 0 ? nil : c as String }
        var q = base(server)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let token = SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? (out as? Data).flatMap { String(data: $0, encoding: .utf8) } : nil
        cache.setObject((token ?? "") as NSString, forKey: server.absoluteString as NSString)
        return token
    }

    public func setToken(_ token: String?, for server: URL) {
        cache.setObject((token ?? "") as NSString, forKey: server.absoluteString as NSString)
        SecItemDelete(base(server) as CFDictionary)
        guard let token, !token.isEmpty else { return }
        var q = base(server)
        q[kSecValueData as String] = Data(token.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecAttrLabel as String] = "Film Studio session (\(server.host ?? "server"))"
        SecItemAdd(q as CFDictionary, nil)
    }
}

public final class MemoryTokenStore: TokenStore, @unchecked Sendable {
    private var tokens: [String: String] = [:]
    private let lock = NSLock()
    public init(_ initial: [URL: String] = [:]) { for (k, v) in initial { tokens[k.absoluteString] = v } }
    public func token(for server: URL) -> String? { lock.lock(); defer { lock.unlock() }; return tokens[server.absoluteString] }
    public func setToken(_ token: String?, for server: URL) { lock.lock(); defer { lock.unlock() }; tokens[server.absoluteString] = token }
}
