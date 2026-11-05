import SwiftUI

/// Liquid Glass for the app's own floating chrome (banners, pills, overlay controls).
/// System bars, sidebars, toolbars and sheets get glass from the SDK on their own; this is only for custom pieces.
/// With Reduce Transparency on, glass becomes a solid, high-contrast surface.
private struct StudioGlass<S: InsettableShape>: ViewModifier {
    let shape: S
    var tint: Color?
    var interactive: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    func body(content: Content) -> some View {
        if reduceTransparency {
            content
                .background(Color.cardBackground, in: shape)
                .overlay(shape.strokeBorder(tint?.opacity(0.6) ?? Color.secondary.opacity(0.35)))
        } else {
            content.glassEffect(glass, in: shape)
        }
    }

    private var glass: Glass {
        var g = Glass.regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
}

extension View {
    /// Floating glass surface in `shape`; `interactive` for things you tap.
    func studioGlass<S: InsettableShape>(_ shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(StudioGlass(shape: shape, tint: tint, interactive: interactive))
    }

    func studioGlass(tint: Color? = nil, interactive: Bool = false) -> some View {
        studioGlass(Capsule(), tint: tint, interactive: interactive)
    }

    /// Primary actions (Generate, Plan, Render) use prominent glass; secondary ones plain glass.
    @ViewBuilder func glassButton(prominent: Bool = false) -> some View {
        if prominent { buttonStyle(.glassProminent) } else { buttonStyle(.glass) }
    }
}

/// App-wide appearance. Film Studio is dark-first; Settings can follow the system or force light.
enum Appearance: String, CaseIterable, Identifiable {
    case dark, system, light
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var scheme: ColorScheme? {
        switch self {
        case .dark: .dark
        case .light: .light
        case .system: nil
        }
    }
}
