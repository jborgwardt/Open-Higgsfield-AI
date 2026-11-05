import SwiftUI
import FilmStudioKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

enum Platform {
    #if os(macOS)
    static let isMac = true
    #else
    static let isMac = false
    #endif

    static var isPad: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
        #else
        false
        #endif
    }

    static func open(_ url: URL) {
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }

    static func haptic(_ success: Bool = true) {
        #if os(iOS)
        UINotificationFeedbackGenerator().notificationOccurred(success ? .success : .error)
        #endif
    }
}

extension Color {
    static var groupedBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemGroupedBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
    static var cardBackground: Color {
        #if os(iOS)
        Color(uiColor: .secondarySystemGroupedBackground)
        #else
        Color(nsColor: .controlBackgroundColor)
        #endif
    }
    static var tileBackground: Color {
        #if os(iOS)
        Color(uiColor: .tertiarySystemFill)
        #else
        Color(nsColor: .quaternaryLabelColor).opacity(0.5)
        #endif
    }
}

extension View {
    /// Inline navigation titles on iPhone/iPad; no-op on the Mac.
    @ViewBuilder func inlineTitle() -> some View {
        #if os(iOS)
        navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }

    @ViewBuilder func urlField() -> some View {
        #if os(iOS)
        keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    @ViewBuilder func plainField() -> some View {
        #if os(iOS)
        textInputAutocapitalization(.never).autocorrectionDisabled()
        #else
        autocorrectionDisabled()
        #endif
    }

    /// The grouped form look on every platform.
    @ViewBuilder func studioForm() -> some View {
        formStyle(.grouped)
    }

    func card(padding: CGFloat = 14) -> some View {
        self.padding(padding)
            .background(Color.cardBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

extension ToolbarItemPlacement {
    static var trailing: ToolbarItemPlacement {
        #if os(iOS)
        .topBarTrailing
        #else
        .primaryAction
        #endif
    }
}

/// Device facts for diagnostics.
enum DeviceFacts {
    static var model: String {
        #if targetEnvironment(simulator)
        return (ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "Simulator") + " (Simulator)"
        #else
        var size = 0
        let key = Platform.isMac ? "hw.model" : "hw.machine"
        sysctlbyname(key, nil, &size, nil, 0)
        var buf = [CChar](repeating: 0, count: max(size, 1))
        sysctlbyname(key, &buf, &size, nil, 0)
        return String(decoding: buf.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        #endif
    }
    static var os: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        #if os(iOS)
        let name = UIDevice.current.userInterfaceIdiom == .pad ? "iPadOS" : "iOS"
        #else
        let name = "macOS"
        #endif
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
    static var platform: String {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? "iPadOS" : "iOS"
        #else
        "macOS"
        #endif
    }
    static var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }
    static var build: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0" }
    static var installID: String {
        if let id = UserDefaults.standard.string(forKey: "installID") { return id }
        let id = UUID().uuidString
        UserDefaults.standard.set(id, forKey: "installID")
        return id
    }
    static var info: DeviceInfo {
        DeviceInfo(app: appVersion, build: build, device: model, os: os, platform: platform, install: installID)
    }
}
