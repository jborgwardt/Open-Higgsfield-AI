import SwiftUI
import FilmStudioKit

@main
struct FilmStudioApp: App {
    @State private var app = AppModel()

    init() {
        #if os(macOS)
        // Film Studio is dark-only. Forcing the app appearance also covers save panels, alerts and menus.
        NSApplication.shared.appearance = NSAppearance(named: .darkAqua)
        #endif
        #if DEBUG && os(macOS)
        DebugSnapshot.scheduleIfRequested()
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .preferredColorScheme(.dark)
        }
        #if os(macOS)
        .defaultSize(width: 1240, height: 820)
        #endif
        .commands {
            StudioCommands(app: app)
            SidebarCommands()
            ToolbarCommands()
        }

        #if os(macOS)
        Settings {
            NavigationStack { SettingsView() }
                .environment(app)
                .preferredColorScheme(.dark)
                .frame(minWidth: 520, idealWidth: 560, minHeight: 600)
        }
        #endif
    }
}

extension FocusedValues {
    @Entry var tabSelection: Binding<String>?
}

/// Menu bar (Mac, iPad with keyboard): refresh, jump to sections, new film.
struct StudioCommands: Commands {
    let app: AppModel
    @FocusedBinding(\.tabSelection) private var tab

    struct Shortcut: Identifiable { let id: String; let title: String; let key: KeyEquivalent }
    private var shortcuts: [Shortcut] {
        var out: [Shortcut] = []
        for (i, t) in app.config.visibleTabs.prefix(9).enumerated() {
            out.append(Shortcut(id: t.id, title: t.title, key: KeyEquivalent(Character(String(i + 1)))))
        }
        return out
    }

    var body: some Commands {
        CommandMenu("Studio") {
            Button("Refresh") { app.refreshTick += 1 }
                .keyboardShortcut("r")
                .disabled(app.phase != .ready)
            Divider()
            ForEach(shortcuts) { s in
                Button(s.title) { tab = s.id }
                    .keyboardShortcut(s.key)
                    .disabled(tab == nil)
            }
            Divider()
            if app.config.isOn("films") {
                Button("New Film…") {
                    tab = "films"
                    app.requestNewFilm = true
                }
                .keyboardShortcut("n", modifiers: [.command, .shift])
                .disabled(tab == nil || app.phase != .ready)
            }
        }
    }
}
