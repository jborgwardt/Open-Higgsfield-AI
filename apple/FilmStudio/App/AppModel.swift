import SwiftUI
import AuthenticationServices
import WebKit
import FilmStudioKit

/// App-wide state: which server, the session, the server-driven config, shared catalogs, diagnostics.
@Observable
final class AppModel {
    enum Phase: Equatable {
        case starting
        case signIn
        case ready
        case unreachable(String)
        case updateRequired(String?)
    }

    private(set) var serverURL: URL
    private(set) var client: APIClient
    var phase: Phase = .starting
    var health: Health?
    private(set) var config: AppConfig
    var catalog: Catalog?
    var sound: SoundCatalog = .empty
    var characters: [StudioCharacter] = []
    /// nil = unknown yet, false = the server doesn't have the Characters API (404).
    var charactersAvailable: Bool?
    var sessionExpired = false
    var signInError: String?
    var isSigningIn = false
    /// Bumped to make every visible screen reload (pull to refresh everywhere, ⌘R, after re-auth).
    var refreshTick = 0
    var dismissedNotice: String? = UserDefaults.standard.string(forKey: "dismissedNotice") {
        didSet { UserDefaults.standard.set(dismissedNotice, forKey: "dismissedNotice") }
    }
    /// Cross-screen requests (handled by the window that shows the target screen).
    var requestedTab: String?
    var requestNewFilm = false
    var pendingStartFrame: UploadedAsset?
    var webSheet: WebSheetRequest?
    /// Film directors and the server-side choice (no default — the user must pick).
    var directors: DirectorCatalog?
    let generations = GenerationStore()
    @ObservationIgnored var isStarting = false

    @ObservationIgnored let tokens: TokenStore
    @ObservationIgnored let images = ImagePipeline()
    @ObservationIgnored let diagnostics: DiagnosticsReporter
    @ObservationIgnored private let configCache = ConfigCache.standard
    @ObservationIgnored private var lastConfigFetch = Date.distantPast
    @ObservationIgnored private var metrics: MetricsSubscriber?

    var token: String? { tokens.token(for: serverURL) }
    var webBaseURL: URL { config.webBaseUrl.flatMap { URL(string: $0) } ?? serverURL }
    var needsAuth: Bool { health?.auth ?? true }
    var updateState: AppConfig.UpdateState { config.updateState(appVersion: DeviceFacts.appVersion) }
    var hiddenProviders: Set<String> { config.hiddenProviders }

    init() {
        let defaults = UserDefaults.standard
        // `-serverURL http://127.0.0.1:4951` as a launch argument also lands here (UserDefaults argument domain).
        let server = defaults.string(forKey: "serverURL").flatMap { try? ServerAddress.parse($0) } ?? ServerAddress.defaultURL
        serverURL = server
        tokens = KeychainTokenStore()
        config = ConfigCache.standard.load(server: server) ?? .fallback
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("FilmStudio", isDirectory: true)
        diagnostics = DiagnosticsReporter(file: support.appendingPathComponent("diagnostics-queue.json"), device: DeviceFacts.info)
        client = APIClient(baseURL: server, token: { nil })
        client = makeClient()

        // Crash from the previous run → report now; then arm the sentinel for this run.
        let crashFile = support.appendingPathComponent("crash-marker")
        if let crash = CrashSentinel.previousCrash(file: crashFile) {
            let screen = defaults.string(forKey: "breadcrumb")
            record(DiagnosticEntry(level: "crash", kind: "crash", message: "Previous run crashed: \(CrashSentinel.signalName(crash))", screen: screen, detail: crash))
        }
        CrashSentinel.install(file: crashFile)
        metrics = MetricsSubscriber(reporter: diagnostics)
    }

    private func makeClient() -> APIClient {
        let server = serverURL, tokens = tokens
        return APIClient(baseURL: server, token: { tokens.token(for: server) }, onEvent: { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        })
    }

    // MARK: Launch

    func start() async {
        if phase != .ready { phase = .starting }
        // 1. Update gate first, unauthenticated: a broken build can be replaced even if sign-in is broken.
        if let v = try? await client.appVersion(), VersionNumber(DeviceFacts.appVersion) < VersionNumber(v.minVersion) {
            phase = .updateRequired(v.updateUrl)
            return
        }
        // 2. Who am I?
        do {
            let h = try await client.health()
            health = h
            if h.authed {
                phase = .ready
                await afterSignIn()
            } else {
                phase = .signIn
            }
        } catch {
            phase = .unreachable(error.localizedDescription)
        }
    }

    private func afterSignIn() async {
        sessionExpired = false
        signInError = nil
        await refreshConfig(force: true)
        async let cat = try? client.catalog()
        async let snd = try? client.sound()
        if let c = await cat { catalog = c }
        if let s = await snd { sound = s }
        await loadCharacters()
    }

    /// On launch, on foreground and every `polling.configMs`.
    func refreshConfig(force: Bool = false) async {
        guard phase == .ready else { return }
        let every = Double(config.polling["configMs"] ?? 300_000) / 1000
        guard force || Date().timeIntervalSince(lastConfigFetch) > every else { return }
        lastConfigFetch = Date()
        if let (cfg, data) = try? await client.appConfig() {
            config = cfg
            configCache.save(data, server: serverURL)
        }
        await configureDiagnostics()
        if case .required = updateState { phase = .updateRequired(config.updateUrl) }
    }

    func foregrounded() async {
        if phase == .ready {
            await refreshConfig()
            await diagnostics.flush()
        } else if case .unreachable = phase {
            await start()
        }
    }

    /// "Animate in Create": opens Create (its own tab, or pushed on Explore) with this image as the start frame.
    func openCreate(startFrame: UploadedAsset) {
        pendingStartFrame = startFrame
        requestedTab = config.visibleTabs.contains { $0.id == "create" } ? "create" : "explore"
    }

    func catalogIfNeeded() async {
        if catalog == nil { catalog = try? await client.catalog() }
    }

    func reloadCatalog() async {
        if let c = try? await client.catalog() { catalog = c }
        if let s = try? await client.sound() { sound = s }
    }

    func loadCharacters() async {
        guard config.isOn("characters") else { return }
        do {
            characters = try await client.characters()
            charactersAvailable = true
        } catch let e as APIError where e.isMissingRoute {
            charactersAvailable = false
            characters = []
        } catch {}
    }

    // MARK: Sign-in

    func signIn(using session: WebAuthenticationSession) async {
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        let state = NativeSignIn.newState()
        let url = NativeSignIn.startURL(server: serverURL, state: state)
        do {
            let callback = try await session.authenticate(using: url, callbackURLScheme: NativeSignIn.callbackScheme, preferredBrowserSession: .ephemeral)
            let token = try NativeSignIn.session(from: callback, expectedState: state)
            try await adopt(token: token)
        } catch let e as ASWebAuthenticationSessionError where e.code == .canceledLogin {
            // The user closed the sheet.
        } catch {
            signInError = error.localizedDescription
            record(DiagnosticEntry(level: "warn", kind: "error", message: "Sign-in failed: \(error.localizedDescription)", screen: "signIn"))
        }
    }

    /// For engines in access-code mode (no Pocket ID): the code itself is the Bearer token.
    func signIn(accessCode: String) async {
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        do { try await adopt(token: accessCode.trimmingCharacters(in: .whitespacesAndNewlines)) } catch { signInError = error.localizedDescription }
    }

    private func adopt(token: String) async throws {
        let previous = tokens.token(for: serverURL)
        tokens.setToken(token, for: serverURL)
        let h = try await client.health()
        guard h.authed else {
            tokens.setToken(previous, for: serverURL)
            throw APIError.unauthorized("The studio did not accept this sign-in.")
        }
        health = h
        phase = .ready
        await afterSignIn()
        refreshTick += 1
    }

    func signOut() async {
        await client.logout()
        tokens.setToken(nil, for: serverURL)
        await WebSession.clearCookies(for: serverURL)
        health = try? await client.health()
        characters = []
        phase = (health?.authed ?? false) ? .ready : .signIn
    }

    func setServer(_ url: URL) async {
        guard url != serverURL else { await start(); return }
        UserDefaults.standard.set(url.absoluteString, forKey: "serverURL")
        serverURL = url
        client = makeClient()
        config = configCache.load(server: url) ?? .fallback
        catalog = nil
        sound = .empty
        characters = []
        charactersAvailable = nil
        directors = nil
        health = nil
        sessionExpired = false
        await images.clear()
        await start()
    }

    // MARK: Diagnostics

    private func handle(_ event: APIEvent) {
        switch event {
        case .unauthorized(let route):
            if phase == .ready, needsAuth, !sessionExpired {
                sessionExpired = true
                record(DiagnosticEntry(level: "info", kind: "request", message: "Session expired", route: route, status: 401))
            }
        case .requestFailed(let method, let route, let status, let message):
            record(DiagnosticEntry(level: (status ?? 0) >= 500 || status == nil ? "error" : "warn", kind: "request", message: message, route: route, method: method, status: status, screen: breadcrumbScreen))
        case .decodeFailed(let route, let message):
            record(DiagnosticEntry(level: "error", kind: "decode", message: message, route: route, screen: breadcrumbScreen))
        }
    }

    func record(_ entry: DiagnosticEntry) {
        Task { await diagnostics.record(entry) }
    }

    /// Report a user-visible failure from a screen.
    func report(_ error: Error, screen: String, action: String) {
        if error is CancellationError { return }
        if let e = error as? APIError {
            // Requests and decoding are reported by the client already.
            switch e { case .transport, .server, .decoding, .unauthorized: return; default: break }
        }
        record(DiagnosticEntry(level: "error", kind: "error", message: "\(action): \(error.localizedDescription)", screen: screen))
    }

    private var breadcrumbScreen: String? { UserDefaults.standard.string(forKey: "breadcrumb") }
    func breadcrumb(_ screen: String) { UserDefaults.standard.set(screen, forKey: "breadcrumb") }

    private func configureDiagnostics() async {
        let client = client
        await diagnostics.configure(enabled: config.isOn("diagnostics") && phase == .ready, sender: { entries, device in
            try await client.postLog(entries, device: device)
        })
    }
}
