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

/// Glass instead of a solid fill: `tint` colours it (selected chips, the ember primary), Reduce Transparency → `fallback`.
private struct GlassFill<S: Shape>: ViewModifier {
    let shape: S
    var tint: Color?
    var interactive: Bool
    var fallback: Color
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(tint ?? fallback, in: shape)
        } else {
            content.glassEffect({ var g = Glass.regular; if let tint { g = g.tint(tint) }; if interactive { g = g.interactive() }; return g }(), in: shape)
        }
    }
}

extension View {
    /// Liquid Glass background in `shape` (solid `fallback` with Reduce Transparency).
    func glassFill<S: Shape>(_ shape: S, tint: Color? = nil, interactive: Bool = true, fallback: Color = .surfaceHigh) -> some View {
        modifier(GlassFill(shape: shape, tint: tint, interactive: interactive, fallback: fallback))
    }

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
