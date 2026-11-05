import SwiftUI
import FilmStudioKit

/// Profile: who is signed in, the studio's other places (Films, Tools) and Settings.
struct ProfileView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        List {
            Section {
                HStack(spacing: 14) {
                    Text(initials)
                        .font(.display(26))
                        .foregroundStyle(Color.onLime)
                        .frame(width: 64, height: 64)
                        .background(Color.lime, in: Circle())
                    VStack(alignment: .leading, spacing: 3) {
                        DisplayTitle(app.health?.user?.name ?? "Film Studio", size: 26, lineLimit: 1).foregroundStyle(.white)
                        Text(app.health?.user?.email ?? app.serverURL.host ?? "").font(.subheadline).foregroundStyle(Color.textSecondary).lineLimit(1)
                        Text(app.serverURL.host ?? app.serverURL.absoluteString).font(.caption.monospaced()).foregroundStyle(Color.textTertiary)
                    }
                }
                .padding(.vertical, 6)
                .listRowBackground(Color.clear)
            }

            Section {
                if app.config.isOn("films") {
                    NavigationLink { FilmsView() } label: { row("Films", "Long-form: script to finished film", "film.stack") }
                }
                if app.config.isOn("tools") {
                    NavigationLink { ToolsView() } label: { row("Tools", "Effects, edits, upscale, lipsync, audio", "square.grid.2x2") }
                }
                if app.config.isOn("characters"), !app.config.visibleTabs.contains(where: { $0.id == "characters" }) {
                    NavigationLink { CharactersView() } label: { row("Characters", "Same face in every shot", "person.crop.square.on.square.angled") }
                }
            } header: { header("Studio") }

            Section {
                NavigationLink { SettingsView() } label: { row("Settings", "Server, account, director, providers", "gearshape") }
                if let url = app.config.updateUrl.flatMap(URL.init(string:)), case .available(let v) = app.updateState {
                    Button { Platform.open(url) } label: { row("Install \(v)", "A new version is ready", "arrow.down.app") }
                }
                OpenOnWebButton(path: "/", title: "Film Studio")
            } header: { header("App") }
        }
        .studioCanvas()
        .navigationTitle("Profile")
        .inlineTitle()
    }

    private var initials: String {
        let name = app.health?.user?.name ?? "FS"
        let parts = name.split(separator: " ").prefix(2).compactMap(\.first)
        return parts.isEmpty ? "FS" : String(parts).uppercased()
    }

    private func header(_ t: String) -> some View {
        Text(t.uppercased()).font(.label(12, weight: .heavy)).tracking(0.8).foregroundStyle(Color.textTertiary)
    }

    private func row(_ title: String, _ subtitle: String, _ symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(Color.lime)
                .frame(width: 36, height: 36).background(Color.surfaceHigh, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(.white)
                Text(subtitle).font(.caption).foregroundStyle(Color.textSecondary).lineLimit(1)
            }
        }
    }
}
