import SwiftUI
import FilmStudioKit

/// Gates the app: update required → sign in → main UI, plus session-expiry and web sheets.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        @Bindable var app = app
        Group {
            switch app.phase {
            case .starting: SplashView()
            case .signIn: SignInView()
            case .unreachable(let message): UnreachableView(message: message)
            case .updateRequired(let url): UpdateRequiredView(updateURL: url)
            case .ready: MainView()
            }
        }
        .animation(.default, value: app.phase)
        .task { await app.startIfNeeded() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await app.foregrounded() } }
        }
        .sheet(isPresented: $app.sessionExpired) { ReauthSheet().environment(app) }
        .sheet(item: $app.webSheet) { req in
            NavigationStack {
                WebScreen(path: req.path, title: req.title)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { app.webSheet = nil } } }
            }
            .environment(app)
            #if os(macOS)
            .frame(minWidth: 900, minHeight: 640)
            #endif
        }
    }
}

extension AppModel {
    /// Several windows share one model; only the first one starts it.
    func startIfNeeded() async {
        guard phase == .starting, !isStarting else { return }
        isStarting = true
        await start()
        isStarting = false
    }
}

/// Tabs on iPhone; a sidebar on iPad and the Mac. Order, visibility and native-vs-web come from the server.
struct MainView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @SceneStorage("tab") private var tab = "explore"
    @State private var showSettings = false

    private static let featureTabs: Set<String> = ["explore", "create", "films", "characters", "tools"]
    private var tabs: [AppConfig.Tab] {
        app.config.visibleTabs.filter { !Self.featureTabs.contains($0.id) || app.config.isOn($0.id) }
    }

    var body: some View {
        content
            .safeAreaInset(edge: .top, spacing: 0) { BannerStack() }
            .focusedSceneValue(\.tabSelection, $tab)
            .onChange(of: app.requestedTab, initial: true) { _, t in
                guard let t else { return }
                tab = t
                app.requestedTab = nil
            }
            .onChange(of: tabs.map(\.id), initial: true) { _, ids in
                if !ids.contains(tab), let first = ids.first { tab = first }
            }
    }

    @ViewBuilder private var content: some View {
        #if os(iOS)
        if sizeClass == .compact { phoneTabs } else { split }
        #else
        split
        #endif
    }

    /// iPhone: at most five tabs; Settings moves to a toolbar button when there are more.
    private var phoneTabs: some View {
        let list = tabs.count > 5 ? tabs.filter { $0.id != "settings" } : tabs
        let settingsInToolbar = list.count < tabs.count
        return TabView(selection: $tab) {
            ForEach(list) { t in
                NavigationStack {
                    TabRoot(tab: t)
                        .toolbar {
                            if settingsInToolbar {
                                ToolbarItem(placement: .cancellationAction) {
                                    Button("Settings", systemImage: "gearshape") { showSettings = true }
                                }
                            }
                        }
                }
                .tabItem { Label(t.title, systemImage: t.sfSymbol) }
                .tag(t.id)
            }
        }
        .sheet(isPresented: $showSettings) {
            NavigationStack {
                SettingsView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showSettings = false } } }
            }
            .environment(app)
        }
    }

    private var split: some View {
        NavigationSplitView {
            List(selection: Binding<String?>(get: { tab }, set: { if let v = $0 { tab = v } })) {
                Section {
                    ForEach(tabs) { t in
                        Label(t.title, systemImage: t.sfSymbol).tag(t.id)
                    }
                }
                if !app.generations.runs.filter({ !$0.isFinished }).isEmpty {
                    Section("Working") {
                        ForEach(app.generations.runs.filter { !$0.isFinished }) { r in
                            HStack {
                                ProgressView(value: r.job?.fraction ?? 0).progressViewStyle(.circular).controlSize(.small)
                                Text(r.title).lineLimit(1).font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Film Studio")
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220)
            #endif
        } detail: {
            if let t = tabs.first(where: { $0.id == tab }) ?? tabs.first {
                NavigationStack { TabRoot(tab: t) }.id(t.id)
            }
        }
    }
}

/// One tab's root screen: native, or the web app when the server says so.
struct TabRoot: View {
    let tab: AppConfig.Tab
    @Environment(AppModel.self) private var app

    var body: some View {
        let p = app.config.presentation(for: tab.id)
        if p.web {
            WebScreen(path: p.path ?? tab.path, title: tab.title).onAppear { app.breadcrumb("web:\(tab.id)") }
        } else {
            Group {
                switch tab.id {
                case "explore": ExploreView()
                case "library": LibraryView()
                case "create": CreateView()
                case "films": FilmsView()
                case "characters": CharactersView()
                case "tools": ToolsView()
                case "settings": SettingsView()
                default:
                    // A tab this app version doesn't know: show its web page.
                    WebScreen(path: tab.path, title: tab.title)
                }
            }
            .onAppear { app.breadcrumb(tab.id) }
        }
    }
}

/// Server notice + update offer.
struct BannerStack: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        VStack(spacing: 0) {
            if let n = app.config.notice, n.isCritical || app.dismissedNotice != n.id {
                BannerView(
                    icon: n.level == "info" ? "info.circle.fill" : "exclamationmark.triangle.fill",
                    title: n.title, message: n.body,
                    tint: n.level == "info" ? .blue : n.isCritical ? .red : .orange,
                    dismiss: n.isCritical ? nil : { withAnimation { app.dismissedNotice = n.id } }
                )
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            if case .available(let v) = app.updateState, let url = app.config.updateUrl.flatMap(URL.init(string:)), app.dismissedNotice != "update-\(v)" {
                BannerView(icon: "arrow.down.app.fill", title: "Update available", message: "Film Studio \(v) is ready to install.", tint: .accentColor,
                           actionTitle: "Install", action: { Platform.open(url) },
                           dismiss: { withAnimation { app.dismissedNotice = "update-\(v)" } })
            }
        }
        .animation(.default, value: app.config.notice)
    }
}

struct SplashView: View {
    var body: some View {
        VStack(spacing: 16) {
            Image("BrandMark").resizable().frame(width: 96, height: 96).clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            ProgressView()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("LaunchBackground"))
    }
}

struct UnreachableView: View {
    let message: String
    @Environment(AppModel.self) private var app
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Can't reach the studio", systemImage: "wifi.exclamationmark")
            } description: {
                Text("\(message)\n\(app.serverURL.host ?? app.serverURL.absoluteString)")
            } actions: {
                Button("Try Again") { Task { await app.start() } }.buttonStyle(.borderedProminent)
                NavigationLink("Server Settings") { Form { ServerSection() }.studioForm().navigationTitle("Server") }
            }
        }
    }
}

struct UpdateRequiredView: View {
    let updateURL: String?
    @Environment(AppModel.self) private var app
    var body: some View {
        ContentUnavailableView {
            Label("Update required", systemImage: "arrow.down.app")
        } description: {
            Text("This version of Film Studio (\(DeviceFacts.appVersion)) is no longer supported by the studio. Install the new version to continue.")
        } actions: {
            if let s = updateURL ?? app.config.updateUrl, let url = URL(string: s) {
                Button("Install Update") { Platform.open(url) }.buttonStyle(.borderedProminent)
            }
            Button("Check Again") { Task { await app.start() } }
        }
    }
}
