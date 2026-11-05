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

/// iPhone: a floating Liquid Glass tab bar (Home · Characters · CREATE · Library · Profile) over content.
/// iPad / Mac: a sidebar with the same sections and a persistent Create. Order, visibility and native-vs-web
/// come from the server config.
struct MainView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @SceneStorage("tab") private var tab = "explore"
    @Namespace private var ns

    private static let featureTabs: Set<String> = ["explore", "create", "films", "characters", "tools"]
    /// Server tabs; Create is the centre button / persistent sidebar item, never a tab of its own.
    private var tabs: [AppConfig.Tab] {
        app.config.visibleTabs.filter { $0.id != "create" && (!Self.featureTabs.contains($0.id) || app.config.isOn($0.id)) }
    }
    /// Four around the Create button; Films and Tools stay reachable from Home and Profile.
    private var barTabs: [AppConfig.Tab] {
        var list = tabs
        for drop in ["tools", "films"] where list.count > 4 { list.removeAll { $0.id == drop } }
        return Array(list.prefix(4))
    }
    private var compact: Bool {
        #if os(iOS)
        sizeClass == .compact
        #else
        false
        #endif
    }

    var body: some View {
        content
            .environment(\.heroNamespace, ns)
            .focusedSceneValue(\.tabSelection, $tab)
            .onChange(of: compact, initial: true) { _, c in app.compactWindow = c; app.reachableTabs = Set((c ? barTabs : tabs).map(\.id)) }
            .onChange(of: tabs.map(\.id)) { _, _ in app.reachableTabs = Set((compact ? barTabs : tabs).map(\.id)) }
            .onChange(of: app.requestedTab, initial: true) { _, t in
                guard let t else { return }
                app.requestedTab = nil
                if t == "create", compact { app.composer = app.composerDraft ?? ComposerRequest(); app.composerDraft = nil; return }
                withAnimation(.snappy) { tab = t }
            }
            .onChange(of: tabs.map(\.id), initial: true) { _, ids in
                if !ids.contains(tab), tab != "create" || compact, let first = ids.first { tab = first }
            }
            .onAppear {
                // `-startTab films` (launch argument) opens a section directly — used for screenshots.
                if let t = UserDefaults.standard.string(forKey: "startTab"), t == "create" || tabs.contains(where: { $0.id == t }) {
                    if t == "create" { app.openComposer() } else { tab = t }
                }
                #if DEBUG
                if UserDefaults.standard.bool(forKey: "openComposer") { app.openComposer() }
                #endif
            }
    }

    @ViewBuilder private var content: some View {
        #if os(iOS)
        if compact { phoneTabs } else { split }
        #else
        split
        #endif
    }

    #if os(iOS)
    private var immersive: Bool { app.immersiveDepth > 0 }
    /// Landscape iPhone (compact height): a slimmer bar so it doesn't eat a quarter of the screen (QA-14).
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var barHeight: CGFloat { verticalSizeClass == .compact ? 50 : StudioTabBar.height }

    private var phoneTabs: some View {
        @Bindable var app = app
        let list = barTabs
        return TabView(selection: $tab) {
            ForEach(list) { t in
                Tab(value: t.id) {
                    NavigationStack { TabRoot(tab: t) }
                        .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: immersive ? 0 : barHeight + 8) }
                        .toolbarVisibility(.hidden, for: .tabBar)
                }
            }
        }
        .overlay(alignment: .bottom) {
            if !immersive {
                VStack(spacing: 8) {
                    WorkingPill(tab: $tab, tabs: list.map(\.id))
                    StudioTabBar(tabs: list, selection: $tab, height: barHeight) { app.openComposer() }
                }
                .padding(.bottom, 2)
                .ignoresSafeArea(.keyboard)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.snappy, value: immersive)
        .fullScreenCover(item: $app.composer) { req in
            NavigationStack { ComposerView(request: req, dismissable: true) }
                .environment(app)
                .zoomTransition(req.sourceID ?? "create-button", in: ns)
        }
    }
    #endif

    private var split: some View {
        NavigationSplitView {
            List(selection: Binding<String?>(get: { tab }, set: { if let v = $0 { tab = v } })) {
                if app.config.isOn("create") {
                    Label { Text("Create").font(.headline) } icon: { Image(systemName: "sparkle").foregroundStyle(Color.onLime).padding(5).background(Color.lime, in: Circle()) }
                        .tag("create")
                }
                Section {
                    ForEach(tabs) { t in
                        Label(t.displayTitle, systemImage: t.displaySymbol).tag(t.id)
                    }
                }
                if !app.generations.runs.filter({ !$0.isFinished }).isEmpty {
                    Section("Generating") {
                        ForEach(app.generations.runs.filter { !$0.isFinished }) { r in
                            HStack {
                                ProgressView(value: r.job?.fraction ?? 0).progressViewStyle(.circular).controlSize(.small).tint(.lime)
                                Text(r.title).lineLimit(1).font(.caption)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Film Studio")
            .scrollContentBackground(.hidden)
            // Selected row: white on dark grey, not white on lime (unreadable, QA-13).
            .tint(Color(white: 0.26))
            #if os(macOS)
            .navigationSplitViewColumnWidth(min: 190, ideal: 220)
            #endif
        } detail: {
            if tab == "create", app.config.isOn("create") {
                NavigationStack { ComposerView(request: app.composerDraft) }
            } else if let t = tabs.first(where: { $0.id == tab }) ?? tabs.first {
                NavigationStack { TabRoot(tab: t) }.id(t.id)
            }
        }
    }
}

extension AppConfig.Tab {
    /// Higgsfield-style names for the two tabs whose old titles don't fit the new bar.
    var displayTitle: String {
        switch id {
        case "explore": "Home"
        case "settings": "Profile"
        default: title
        }
    }
    var displaySymbol: String {
        switch id {
        case "explore": "house"
        case "settings": "person.crop.circle"
        case "characters": "person.crop.square.on.square.angled"
        case "library": "square.grid.2x2"
        default: sfSymbol
        }
    }
}

#if os(iOS)
/// The floating glass tab bar with the big lime Create button in the middle.
struct StudioTabBar: View {
    static let height: CGFloat = 66
    let tabs: [AppConfig.Tab]
    @Binding var selection: String
    var height: CGFloat = StudioTabBar.height
    let create: () -> Void
    private var slim: Bool { height < Self.height }
    @Environment(AppModel.self) private var app
    @Environment(\.heroNamespace) private var ns

    var body: some View {
        let half = (tabs.count + 1) / 2
        HStack(spacing: 0) {
            ForEach(tabs.prefix(half)) { item($0) }
            if app.config.isOn("create") { createButton }
            ForEach(tabs.dropFirst(half)) { item($0) }
        }
        .padding(.horizontal, 6)
        .frame(height: height)
        .frame(maxWidth: slim ? 560 : .infinity)
        .studioGlass(Capsule(), tint: .black.opacity(0.45))
        .padding(.horizontal, 14)
    }

    private func item(_ t: AppConfig.Tab) -> some View {
        let on = selection == t.id
        return Button {
            if selection != t.id { Platform.selection() }
            else { app.scrollToTopTick[t.id, default: 0] += 1 } // re-tap: back to the top (QA-10)
            withAnimation(.snappy) { selection = t.id }
        } label: {
            VStack(spacing: 3) {
                Image(systemName: t.displaySymbol).symbolVariant(on ? .fill : .none).font(.system(size: 19, weight: .semibold))
                    .frame(height: 24)
                if !slim {
                    // Scales with Dynamic Type up to a point the bar can hold (QA-15).
                    Text(t.displayTitle).font(.caption2.weight(.semibold)).dynamicTypeSize(...DynamicTypeSize.xxLarge).lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            .foregroundStyle(on ? Color.white : Color.white.opacity(0.55))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(t.displayTitle)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private var createButton: some View {
        Button {
            Platform.impact()
            create()
        } label: {
            Image(systemName: "sparkle")
                .font(.system(size: 24, weight: .heavy))
                .foregroundStyle(Color.onLime)
                .frame(width: 64, height: slim ? 40 : 50)
                .background(Capsule().fill(Color.lime))
                .shadow(color: Color.lime.opacity(0.35), radius: 12)
        }
        .buttonStyle(PressScale())
        .zoomSource("create-button", in: ns)
        .padding(.horizontal, 6)
        .accessibilityLabel("Create")
    }
}

/// Generations in flight float above the tab bar as a glass pill; tap to see them in the Library.
private struct WorkingPill: View {
    @Binding var tab: String
    let tabs: [String]
    @Environment(AppModel.self) private var app

    var body: some View {
        let runs = app.generations.runs.filter { !$0.isFinished }
        if let lead = runs.first {
            Button {
                if tabs.contains("library") { withAnimation(.snappy) { tab = "library" } }
            } label: {
                HStack(spacing: 10) {
                    ProgressView(value: lead.job?.fraction ?? 0).progressViewStyle(.circular).controlSize(.small).tint(.lime)
                    Text(runs.count > 1 ? "\(runs.count) generating" : "Generating · \(lead.title)").font(.subheadline.weight(.semibold)).lineLimit(1)
                    if let f = lead.job?.fraction { Text("\(Int(f * 100))%").font(.subheadline.monospacedDigit()).foregroundStyle(Color.lime) }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .studioGlass(Capsule(), interactive: true)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityHint("Shows it in the Library")
        }
    }
}
#endif

/// One tab's root screen: native, or the web app when the server says so.
struct TabRoot: View {
    let tab: AppConfig.Tab
    @Environment(AppModel.self) private var app

    var body: some View {
        // The server notice / update offer sits under the navigation bar of every tab.
        screen.safeAreaInset(edge: .top, spacing: 0) { BannerStack() }
    }

    @ViewBuilder private var screen: some View {
        let p = app.config.presentation(for: tab.id)
        if p.web {
            WebScreen(path: p.path ?? tab.path, title: tab.title).onAppear { app.breadcrumb("web:\(tab.id)") }
        } else {
            Group {
                switch tab.id {
                case "explore": HomeView()
                case "library": LibraryView()
                case "create": ComposerView()
                case "films": FilmsView()
                case "characters": CharactersView()
                case "tools": ToolsView()
                case "settings": ProfileView()
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
            if app.isOffline {
                BannerView(icon: "wifi.slash", title: "Offline", message: "Showing your last Home. New generations need the studio.", tint: .orange,
                           actionTitle: "Retry", action: { Task { await app.retryOnline() } })
            }
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
        VStack(spacing: 18) {
            Image("BrandMark").resizable().frame(width: 96, height: 96)
            ProgressView().tint(.lime)
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
                // The title already says "can't reach"; don't repeat the transport message.
                let detail = message.localizedCaseInsensitiveContains("reach the studio") ? "The server didn't answer. Check your connection or the server address." : message
                Text("\(detail)\n\(app.serverURL.host ?? app.serverURL.absoluteString)")
            } actions: {
                Button("Try Again") { Task { await app.start() } }.buttonStyle(.lime)
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
                Button("Install Update") { Platform.open(url) }.buttonStyle(.lime)
            }
            Button("Check Again") { Task { await app.start() } }
        }
    }
}
