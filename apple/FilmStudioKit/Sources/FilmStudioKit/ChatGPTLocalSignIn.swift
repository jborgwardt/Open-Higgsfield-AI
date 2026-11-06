import Foundation
import CryptoKit
import Security
#if os(macOS)
import Network
#endif

enum ChatGPTOAuth {
    static let resource = "https://api.openai.com/v1"
    static let tokenEndpoint = URL(string: "https://auth.openai.com/api/accounts/oauth/token")!
    static let scopes = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"

    static func randomValue() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw ChatGPTSignInError.invalidAttempt
        }
        return base64URL(Data(bytes))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    static func authorizationURL(redirectURI: String, state: String, nonce: String, verifier: String,
                                 hostID: String, clientID: String?) -> URL {
        var components = URLComponents(string: "https://auth.openai.com/api/accounts/authorize")!
        var fields = [
            URLQueryItem(name: "client_id", value: clientID ?? "dynamic_agent_client"),
            URLQueryItem(name: "ext_agent_host_id", value: hostID),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "resource", value: resource),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "code_challenge", value: base64URL(Data(SHA256.hash(data: Data(verifier.utf8)))))
        ]
        if clientID == nil { fields.append(URLQueryItem(name: "agent_name_hint", value: "Film Studio")) }
        components.queryItems = fields
        return components.url!
    }

    struct Callback: Sendable { let code: String; let clientID: String }

    static func callback(target: String, state: String, clientID: String?) throws -> Callback {
        guard target.hasPrefix("/auth/callback?"),
              let components = URLComponents(string: "http://127.0.0.1" + target),
              components.path == "/auth/callback", components.fragment == nil,
              let items = components.queryItems else { throw ChatGPTSignInError.invalidCallback }
        var values: [String: String] = [:]
        for item in items {
            guard values[item.name] == nil else { throw ChatGPTSignInError.invalidCallback }
            values[item.name] = item.value ?? ""
        }
        guard let receivedState = values["state"], constantTimeEqual(receivedState, state) else {
            throw ChatGPTSignInError.invalidCallback
        }
        if values["error"] != nil { throw ChatGPTSignInError.denied }
        guard let code = values["code"], !code.isEmpty,
              let issuedID = values["client_id"] ?? clientID,
              !issuedID.isEmpty, issuedID != "dynamic_agent_client",
              clientID == nil || clientID == issuedID else { throw ChatGPTSignInError.invalidCallback }
        return Callback(code: code, clientID: issuedID)
    }

    static func callbackRequest(_ request: String, port: UInt16, state: String, clientID: String?) throws -> Callback {
        guard let end = request.range(of: "\r\n\r\n") else { throw ChatGPTSignInError.invalidCallback }
        let lines = request[..<end.lowerBound].components(separatedBy: "\r\n")
        let start = (lines.first ?? "").split(separator: " ")
        let headers = lines.dropFirst()
        let hosts = headers.filter { $0.lowercased().hasPrefix("host:") }
        guard start.count == 3, start[0] == "GET", ["HTTP/1.1", "HTTP/1.0"].contains(start[2]),
              !headers.contains(where: { $0.hasPrefix(" ") || $0.hasPrefix("\t") }),
              hosts.count == 1,
              hosts[0].dropFirst(5).trimmingCharacters(in: .whitespaces) == "127.0.0.1:\(port)" else {
            throw ChatGPTSignInError.invalidCallback
        }
        return try callback(target: String(start[1]), state: state, clientID: clientID)
    }

    private static func constantTimeEqual(_ left: String, _ right: String) -> Bool {
        let a = Array(left.utf8), b = Array(right.utf8)
        guard a.count == b.count else { return false }
        return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
    }

    static func tokenRequest(callback: Callback, redirectURI: String, verifier: String) -> URLRequest {
        let fields = ["grant_type": "authorization_code", "client_id": callback.clientID,
                      "code": callback.code, "code_verifier": verifier, "redirect_uri": redirectURI,
                      "resource": resource]
        // RFC 3986 unreserved characters only; a literal '+' must not become a form space.
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let body = fields.sorted { $0.key < $1.key }.map {
            $0.key.addingPercentEncoding(withAllowedCharacters: allowed)! + "=" +
                $0.value.addingPercentEncoding(withAllowedCharacters: allowed)!
        }.joined(separator: "&")
        var request = URLRequest(url: tokenEndpoint)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Data(body.utf8)
        return request
    }

    static func credentials(from data: Data, clientID: String) throws -> ChatGPTCredentials {
        struct Reply: Decodable {
            let access_token: String, refresh_token: String, id_token: String, scope: String, token_type: String
            let expires_in: Int
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: data),
              !reply.access_token.isEmpty, !reply.refresh_token.isEmpty, !reply.id_token.isEmpty,
              reply.token_type.lowercased() == "bearer", reply.expires_in > 0 else {
            throw ChatGPTSignInError.tokenExchangeFailed
        }
        let granted = Set(reply.scope.split(separator: " ").map(String.init))
        guard granted.isSuperset(of: ["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]) else {
            throw ChatGPTSignInError.missingPlanPermission
        }
        return ChatGPTCredentials(clientID: clientID, accessToken: reply.access_token,
                                  refreshToken: reply.refresh_token, idToken: reply.id_token,
                                  scope: reply.scope, tokenType: reply.token_type, expiresIn: reply.expires_in)
    }
}

#if os(macOS)
/// One in-memory OAuth attempt. Only the selected studio retains/refreshes credentials.
@MainActor public final class ChatGPTLocalSignIn {
    private var listener: NWListener?
    private var ready: CheckedContinuation<UInt16, Error>?
    private var callback: CheckedContinuation<ChatGPTOAuth.Callback, Error>?
    private var deadline: Task<Void, Never>?
    private var connections: [UUID: NWConnection] = [:]
    private var expectedState = ""
    private var expectedClientID: String?
    private var port: UInt16 = 0
    private var running = false
    private var terminalError: (any Error)?

    public init() {}

    public static func stableHostID(defaults: UserDefaults = .standard) -> String {
        let key = "FilmStudio.ChatGPT.localHostID"
        if let existing = defaults.string(forKey: key), existing.hasPrefix("urn:uuid:"),
           UUID(uuidString: String(existing.dropFirst(9))) != nil { return existing }
        let value = "urn:uuid:" + UUID().uuidString.lowercased()
        defaults.set(value, forKey: key)
        return value
    }

    public func authorize(attempt: CodexConnectionAttempt, hostID: String,
                          openBrowser: @escaping @MainActor (URL) -> Void) async throws -> ChatGPTCredentials {
        guard !running else { throw ChatGPTSignInError.alreadyRunning }
        guard !attempt.connectionId.isEmpty, !attempt.nonce.isEmpty,
              let expiration = attempt.expirationDate, expiration > Date(),
              attempt.clientId != "dynamic_agent_client" else { throw ChatGPTSignInError.invalidAttempt }
        let state = try ChatGPTOAuth.randomValue()
        let verifier = try ChatGPTOAuth.randomValue()
        running = true
        terminalError = nil
        expectedState = state
        expectedClientID = attempt.clientId
        defer {
            stop(CancellationError())
            running = false
            expectedState = ""
            expectedClientID = nil
            terminalError = nil
        }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            deadline = Task { [weak self] in
                do {
                    try await Task.sleep(for: .seconds(max(0, min(600, expiration.timeIntervalSinceNow))))
                    self?.stop(ChatGPTSignInError.timedOut)
                } catch {}
            }
            let listeningPort = try await startListener()
            try Task.checkCancellation()
            if let terminalError { throw terminalError }
            let redirectURI = "http://127.0.0.1:\(listeningPort)/auth/callback"
            let url = ChatGPTOAuth.authorizationURL(redirectURI: redirectURI, state: expectedState,
                                                   nonce: attempt.nonce, verifier: verifier,
                                                   hostID: hostID, clientID: attempt.clientId)
            let result: ChatGPTOAuth.Callback = try await withCheckedThrowingContinuation { continuation in
                callback = continuation
                openBrowser(url)
            }
            listener?.cancel()
            listener = nil
            try Task.checkCancellation()
            let session = ChatGPTSecureTransport.session()
            defer { session.invalidateAndCancel() }
            let data: Data, response: URLResponse
            do { (data, response) = try await session.data(for: ChatGPTOAuth.tokenRequest(callback: result, redirectURI: redirectURI, verifier: verifier)) }
            catch { if Task.isCancelled { throw CancellationError() }; throw ChatGPTSignInError.tokenExchangeFailed }
            if let terminalError { throw terminalError }
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                throw ChatGPTSignInError.tokenExchangeFailed
            }
            return try ChatGPTOAuth.credentials(from: data, clientID: result.clientID)
        } onCancel: { Task { @MainActor [weak self] in self?.stop(CancellationError()) } }
    }

    public func cancel() { stop(CancellationError()) }

    private func startListener() async throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let newListener: NWListener
        do { newListener = try NWListener(using: parameters) }
        catch { throw ChatGPTSignInError.listenerUnavailable }
        listener = newListener
        newListener.newConnectionHandler = { [weak self] connection in
            Task { @MainActor in self?.accept(connection) }
        }
        return try await withCheckedThrowingContinuation { continuation in
            ready = continuation
            newListener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    guard let self else { return }
                    switch state {
                    case .ready:
                        guard let port = self.listener?.port?.rawValue else {
                            self.stop(ChatGPTSignInError.listenerUnavailable); return
                        }
                        self.port = port
                        self.ready?.resume(returning: port); self.ready = nil
                    case .failed: self.stop(ChatGPTSignInError.listenerUnavailable)
                    default: break
                    }
                }
            }
            newListener.start(queue: .main)
        }
    }

    private func accept(_ connection: NWConnection) {
        guard listener != nil, connections.count < 8 else { connection.cancel(); return }
        let id = UUID()
        connections[id] = connection
        connection.start(queue: .main)
        receive(connection, id: id, accumulated: Data())
    }

    private func receive(_ connection: NWConnection, id: UUID, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self, self.connections[id] != nil else { return }
                var bytes = accumulated
                if let data { bytes.append(data) }
                guard bytes.count <= 8192, error == nil else { self.close(id); return }
                if let text = String(data: bytes, encoding: .utf8), text.contains("\r\n\r\n") {
                    self.handle(text, connection: connection, id: id)
                } else if complete { self.close(id) }
                else { self.receive(connection, id: id, accumulated: bytes) }
            }
        }
    }

    private func handle(_ request: String, connection: NWConnection, id: UUID) {
        do {
            let result = try ChatGPTOAuth.callbackRequest(request, port: port, state: expectedState, clientID: expectedClientID)
            respond(connection, id: id, success: true) { [weak self] in
                self?.callback?.resume(returning: result); self?.callback = nil
            }
        } catch ChatGPTSignInError.denied {
            respond(connection, id: id, success: false) { [weak self] in self?.stop(ChatGPTSignInError.denied) }
        } catch { respond(connection, id: id, success: false) }
    }

    private func respond(_ connection: NWConnection, id: UUID, success: Bool, completion: (@MainActor () -> Void)? = nil) {
        let body = success ? "Return to Film Studio to finish connecting your studio." : "This sign-in response was not accepted. Return to Film Studio."
        let header = "HTTP/1.1 \(success ? "200 OK" : "400 Bad Request")\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nContent-Security-Policy: default-src 'none'\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n"
        connection.send(content: Data((header + body).utf8), completion: .contentProcessed { [weak self] _ in
            Task { @MainActor in self?.close(id); completion?() }
        })
    }

    private func close(_ id: UUID) { connections.removeValue(forKey: id)?.cancel() }

    private func stop(_ error: any Error) {
        terminalError = error
        deadline?.cancel(); deadline = nil
        ready?.resume(throwing: error); ready = nil
        callback?.resume(throwing: error); callback = nil
        listener?.cancel(); listener = nil
        for connection in connections.values { connection.cancel() }
        connections.removeAll()
    }
}
#endif
