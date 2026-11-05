import SwiftUI
import WebKit
import FilmStudioKit

/// Signs the in-app web view in with the app's session: `engine_session` (Pocket ID sessions) and `engine_token`
/// (access-code mode, where the code is the token) — the engine ignores whichever doesn't apply (QA-18).
enum WebSession {
    static let names = ["engine_session", "engine_token"]

    static func cookie(name: String = "engine_session", token: String, for url: URL) -> HTTPCookie? {
        guard let host = url.host else { return nil }
        var props: [HTTPCookiePropertyKey: Any] = [
            .name: name, .value: name == "engine_token" ? (token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token) : token,
            .domain: host, .path: "/",
            .expires: Date().addingTimeInterval(30 * 86400),
        ]
        if url.scheme == "https" { props[.secure] = "TRUE" }
        return HTTPCookie(properties: props)
    }

    static func install(token: String?, for url: URL) async {
        guard let token else { return }
        for name in names {
            if let c = cookie(name: name, token: token, for: url) { await WKWebsiteDataStore.default().httpCookieStore.setCookie(c) }
        }
    }

    static func clearCookies(for url: URL) async {
        let store = WKWebsiteDataStore.default().httpCookieStore
        for c in await store.allCookies() where names.contains(c.name) && (url.host.map { c.domain.hasSuffix($0) } ?? false) {
            await store.deleteCookie(c)
        }
    }
}

/// A screen served by the web app instead of native UI. The server can switch any tab or screen to this
/// (app config `kind: "web"`), which replaces a broken native screen without an app update.
struct WebScreen: View {
    let path: String
    var title: String = ""
    @Environment(AppModel.self) private var app
    @State private var ready = false
    @State private var reloadToken = 0
    @State private var loading = true
    @State private var failure: String?

    private var url: URL? {
        let base = app.webBaseURL.absoluteString.trimmingSuffix("/")
        let p = path.isEmpty ? "/" : (path.hasPrefix("/") ? path : "/" + path)
        return URL(string: base + p)
    }

    var body: some View {
        Group {
            if let url, ready {
                WebView(url: url, reloadToken: reloadToken, loading: $loading, failure: $failure)
                    .overlay(alignment: .top) { if loading { ProgressView().progressViewStyle(.linear).tint(.accentColor) } }
                    .overlay {
                        if let failure {
                            ErrorStateView(message: failure) { self.failure = nil; reloadToken += 1 }.background(.background)
                        }
                    }
            } else if url == nil {
                ErrorStateView(message: "The server sent an invalid web address for this screen.")
            } else {
                LoadingView()
            }
        }
        .navigationTitle(title)
        .inlineTitle()
        .toolbar {
            ToolbarItem(placement: .trailing) {
                Menu {
                    Button("Reload", systemImage: "arrow.clockwise") { reloadToken += 1 }
                    if let url { Button("Open in Browser", systemImage: "safari") { Platform.open(url) } }
                } label: { Label("Web", systemImage: "globe") }
            }
        }
        .task(id: app.token) {
            if let url { await WebSession.install(token: app.token, for: url) }
            ready = true
        }
        .onAppear { app.breadcrumb("web:\(path)") }
    }
}

extension String {
    func trimmingSuffix(_ s: String) -> String { hasSuffix(s) ? String(dropLast(s.count)) : self }
}

#if os(iOS)
private struct WebView: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    @Binding var loading: Bool
    @Binding var failure: String?

    func makeCoordinator() -> WebCoordinator { WebCoordinator(loading: $loading, failure: $failure) }
    func makeUIView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: WebCoordinator.configuration())
        v.navigationDelegate = context.coordinator
        v.allowsBackForwardNavigationGestures = true
        v.isInspectable = true
        v.scrollView.refreshControl = context.coordinator.refreshControl(for: v)
        v.isOpaque = false  // no white flash before the (dark) page paints
        v.backgroundColor = .systemBackground
        v.underPageBackgroundColor = .systemBackground
        context.coordinator.load(url, in: v, token: reloadToken)
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) { context.coordinator.load(url, in: v, token: reloadToken) }
}
#else
private struct WebView: NSViewRepresentable {
    let url: URL
    let reloadToken: Int
    @Binding var loading: Bool
    @Binding var failure: String?

    func makeCoordinator() -> WebCoordinator { WebCoordinator(loading: $loading, failure: $failure) }
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: WebCoordinator.configuration())
        v.navigationDelegate = context.coordinator
        v.allowsBackForwardNavigationGestures = true
        v.isInspectable = true
        v.underPageBackgroundColor = .windowBackgroundColor
        context.coordinator.load(url, in: v, token: reloadToken)
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) { context.coordinator.load(url, in: v, token: reloadToken) }
}
#endif

final class WebCoordinator: NSObject, WKNavigationDelegate {
    @Binding var loading: Bool
    @Binding var failure: String?
    private var loadedURL: URL?
    private var loadedToken = -1

    init(loading: Binding<Bool>, failure: Binding<String?>) {
        _loading = loading
        _failure = failure
    }

    static func configuration() -> WKWebViewConfiguration {
        let c = WKWebViewConfiguration()
        c.websiteDataStore = .default()
        #if os(iOS)
        c.allowsInlineMediaPlayback = true
        #endif
        return c
    }

    func load(_ url: URL, in v: WKWebView, token: Int) {
        guard url != loadedURL || token != loadedToken else { return }
        if url == loadedURL, v.url != nil { v.reload() } else { v.load(URLRequest(url: url)) }
        loadedURL = url
        loadedToken = token
    }

    #if os(iOS)
    func refreshControl(for v: WKWebView) -> UIRefreshControl {
        let rc = UIRefreshControl()
        rc.addAction(UIAction { [weak v, weak rc] _ in v?.reload(); rc?.endRefreshing() }, for: .valueChanged)
        return rc
    }
    #endif

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loading = true; failure = nil }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loading = false }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { loading = false }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        loading = false
        if (error as NSError).code != NSURLErrorCancelled { failure = error.localizedDescription }
    }

    /// Links that leave the studio open in the system browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url, let current = loadedURL else { return .allow }
        if action.navigationType == .linkActivated, url.host != current.host, url.scheme?.hasPrefix("http") == true {
            Platform.open(url)
            return .cancel
        }
        return .allow
    }
}

/// Wraps a native screen so the server can swap it for its web version (config `screens` / tab `kind`).
struct ScreenGate<Content: View>: View {
    let id: String
    var params: [String: String] = [:]
    var title: String = ""
    @ViewBuilder let content: () -> Content
    @Environment(AppModel.self) private var app

    var body: some View {
        let p = app.config.presentation(for: id)
        if p.web {
            WebScreen(path: fill(p.path ?? "/"), title: title)
        } else {
            content().onAppear { app.breadcrumb(id) }
        }
    }

    private func fill(_ path: String) -> String {
        params.reduce(path) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? $1.value) }
    }
}

/// "Open on the web" for any screen — the escape hatch when a native screen misbehaves.
/// Works inside menus: the root view presents the sheet.
struct OpenOnWebButton: View {
    let path: String
    var title: String = ""
    @Environment(AppModel.self) private var app
    var body: some View {
        if app.config.isOn("openOnWeb") {
            Button("Open on the Web", systemImage: "globe") { app.webSheet = .init(path: path, title: title) }
        }
    }
}

struct WebSheetRequest: Identifiable {
    let id = UUID()
    let path: String
    let title: String
}
