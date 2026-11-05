import SwiftUI

// Film Studio design language (Higgsfield-style): pure black canvas, one electric-lime accent, white text,
// muted greys, big bold UPPERCASE condensed display type over media. Liquid Glass only for floating chrome.

extension Color {
    /// The one accent: primary actions, selection, the Create button.
    static let lime = Color(red: 0.824, green: 1.0, blue: 0.227) // #D2FF3A
    /// Text and glyphs on lime.
    static let onLime = Color.black
    static let canvas = Color.black
    /// Raised surfaces on black (cards without media, chips, fields).
    static let surface = Color(white: 0.085)
    static let surfaceHigh = Color(white: 0.14)
    static let hairline = Color.white.opacity(0.09)
    static let textSecondary = Color(white: 0.62)
    static let textTertiary = Color(white: 0.42)
}

extension Font {
    /// Display headlines: heavy, compressed, set in uppercase by `DisplayTitle`.
    static func display(_ size: CGFloat, weight: Font.Weight = .black) -> Font {
        .system(size: size, weight: weight).width(.compressed)
    }
    /// Condensed labels (chips, badges, section kickers).
    static func label(_ size: CGFloat = 13, weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight).width(.condensed)
    }
}

/// An uppercase, condensed, tightly tracked headline.
struct DisplayTitle: View {
    let text: String
    var size: CGFloat = 30
    var lineLimit: Int? = 2
    init(_ text: String, size: CGFloat = 30, lineLimit: Int? = 2) { self.text = text; self.size = size; self.lineLimit = lineLimit }
    var body: some View {
        Text(text.uppercased())
            .font(.display(size))
            .tracking(-0.2)
            .lineSpacing(-size * 0.12)
            .lineLimit(lineLimit)
            .minimumScaleFactor(0.7)
    }
}

/// Section header for feeds: "VIDEO MODELS ............ See all ›".
struct StudioSectionHeader: View {
    let title: String
    var subtitle: String = ""
    var action: (() -> Void)?
    var body: some View {
        HStack(alignment: .lastTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                DisplayTitle(title, size: 24, lineLimit: 1)
                if !subtitle.isEmpty { Text(subtitle).font(.footnote).foregroundStyle(Color.textSecondary).lineLimit(1) }
            }
            Spacer(minLength: 12)
            if let action {
                Button(action: action) {
                    HStack(spacing: 2) {
                        Text("See all")
                        Image(systemName: "chevron.right").font(.caption2.weight(.heavy))
                    }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.textSecondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 16)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Buttons

/// The lime primary button (Generate, Create, Sign in).
struct LimeButtonStyle: ButtonStyle {
    var size: ControlSize = .large
    var fullWidth = false
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size == .large ? 17 : 14, weight: .heavy))
            .foregroundStyle(Color.onLime.opacity(isEnabled ? 1 : 0.45))
            .padding(.horizontal, size == .large ? 22 : 14)
            .padding(.vertical, size == .large ? 15 : 9)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .background(Capsule().fill(Color.lime.opacity(isEnabled ? 1 : 0.35)))
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed ? 0.965 : 1)
            .brightness(configuration.isPressed ? -0.06 : 0)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// Dark pill for secondary actions on black.
struct DarkPillButtonStyle: ButtonStyle {
    var size: ControlSize = .regular
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: size == .large ? 16 : 14, weight: .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, size == .large ? 20 : 14)
            .padding(.vertical, size == .large ? 13 : 9)
            .background(Capsule().fill(Color.surfaceHigh))
            .overlay(Capsule().strokeBorder(Color.hairline))
            .contentShape(Capsule())
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == LimeButtonStyle {
    static var lime: LimeButtonStyle { LimeButtonStyle() }
    static func lime(_ size: ControlSize = .large, fullWidth: Bool = false) -> LimeButtonStyle { LimeButtonStyle(size: size, fullWidth: fullWidth) }
}
extension ButtonStyle where Self == DarkPillButtonStyle {
    static var darkPill: DarkPillButtonStyle { DarkPillButtonStyle() }
}

/// A compact filter / option chip. Selected chips are lime.
struct StudioChip: View {
    let title: String
    var systemImage: String?
    var selected = false
    var showsChevron = false
    var body: some View {
        HStack(spacing: 5) {
            if let systemImage { Image(systemName: systemImage).font(.system(size: 12, weight: .bold)) }
            Text(title).lineLimit(1)
            if showsChevron { Image(systemName: "chevron.down").font(.system(size: 9, weight: .heavy)).opacity(0.7) }
        }
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(selected ? Color.onLime : .white)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Capsule().fill(selected ? Color.lime : Color.surfaceHigh))
        .overlay(Capsule().strokeBorder(selected ? .clear : Color.hairline))
        .contentShape(Capsule())
    }
}

/// A small uppercase badge over media ("NEW", provider names).
struct MediaBadge: View {
    let text: String
    var lime = false
    var body: some View {
        Text(text.uppercased())
            .font(.label(10, weight: .heavy))
            .tracking(0.4)
            .foregroundStyle(lime ? Color.onLime : .white)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(Capsule().fill(lime ? Color.lime : Color.black.opacity(0.55)))
            .lineLimit(1)
    }
}

// MARK: - Effects

/// Loading shimmer for placeholder cards.
struct Shimmer: ViewModifier {
    var active = true
    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.overlay {
            if active && !reduceMotion {
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, .white.opacity(0.10), .clear], startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.8)
                        .offset(x: phase * geo.size.width * 1.4)
                        .blendMode(.plusLighter)
                }
                .allowsHitTesting(false)
                .onAppear { withAnimation(.linear(duration: 1.3).repeatForever(autoreverses: false)) { phase = 1 } }
            }
        }
        .clipped()
    }
}

extension View {
    func shimmer(_ active: Bool = true) -> some View { modifier(Shimmer(active: active)) }

    /// Bottom-up black gradient so white type reads over any media.
    func bottomScrim(_ strength: Double = 0.85, height: CGFloat = 0.6) -> some View {
        overlay {
            LinearGradient(stops: [.init(color: .clear, location: 1 - height), .init(color: .black.opacity(strength), location: 1)],
                           startPoint: .top, endPoint: .bottom)
            .allowsHitTesting(false)
        }
    }

    /// The black canvas behind a whole screen.
    func studioCanvas() -> some View {
        background(Color.canvas.ignoresSafeArea())
            .scrollContentBackground(.hidden)
    }

    /// Zoom transition source (tile → viewer / composer). iOS only; a no-op on the Mac.
    @ViewBuilder func zoomSource(_ id: String, in ns: Namespace.ID?) -> some View {
        #if os(iOS)
        if let ns { matchedTransitionSource(id: id, in: ns) } else { self }
        #else
        self
        #endif
    }

    @ViewBuilder func zoomTransition(_ id: String?, in ns: Namespace.ID?) -> some View {
        #if os(iOS)
        if let id, let ns { navigationTransition(.zoom(sourceID: id, in: ns)) } else { self }
        #else
        self
        #endif
    }
}

extension EnvironmentValues {
    /// Shared namespace for zoom transitions between tiles and the composer / viewer.
    @Entry var heroNamespace: Namespace.ID? = nil
}

/// Stable, dark, slightly tinted placeholder art per id (used until real preview media exists).
struct SeededGradient: View {
    let seed: String
    var body: some View {
        let h = Double(seed.unicodeScalars.reduce(UInt32(5381)) { ($0 &* 33) &+ $1.value } % 360) / 360
        ZStack {
            LinearGradient(colors: [Color(hue: h, saturation: 0.55, brightness: 0.30), Color(hue: (h + 0.1).truncatingRemainder(dividingBy: 1), saturation: 0.7, brightness: 0.09)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            RadialGradient(colors: [Color(hue: h, saturation: 0.5, brightness: 0.55).opacity(0.45), .clear], center: .init(x: 0.75, y: 0.2), startRadius: 0, endRadius: 220)
        }
    }
}
