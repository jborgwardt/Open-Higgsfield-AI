import SwiftUI
import FilmStudioKit

/// Load state for a screen.
enum Loadable<Value> {
    case loading
    case loaded(Value)
    case failed(String)
    case unavailable // the server doesn't have this feature yet

    var value: Value? { if case .loaded(let v) = self { return v }; return nil }
    var isLoading: Bool { if case .loading = self { return true }; return false }
}

struct LoadingView: View {
    var text = "Loading…"
    var body: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.large)
            Text(text).font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ErrorStateView: View {
    let message: String
    var retry: (() async -> Void)?
    var body: some View {
        ContentUnavailableView {
            Label("Something went wrong", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            if let retry {
                Button("Try Again") { Task { await retry() } }.buttonStyle(.lime)
            }
        }
    }
}

/// A feature whose API is not on this server yet (404 "no such route").
struct NotDeployedView: View {
    let title: String
    let systemImage: String
    let message: String
    var webPath: String?
    var retry: () async -> Void
    @Environment(AppModel.self) private var app
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(message)
        } actions: {
            Button("Check Again") { Task { await retry() } }.buttonStyle(.lime)
            if let webPath { OpenOnWebButton(path: webPath, title: title) }
        }
    }
}

struct StatusBadge: View {
    let text: String
    let tint: Color
    var spinning = false
    var body: some View {
        HStack(spacing: 4) {
            if spinning { ProgressView().controlSize(.mini) }
            Text(text).lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(tint)
        .background(tint.opacity(0.14), in: Capsule())
    }
}

extension ProductionStatus {
    var tint: Color {
        switch self {
        case .done, .review, .planned: .green
        case .running, .planning: .blue
        case .paused: .orange
        case .error: .red
        default: .secondary
        }
    }
}

extension ShotStatus {
    var tint: Color {
        switch self {
        case .done: .green
        case .running: .blue
        case .error: .red
        case .handoff: .orange
        default: .secondary
        }
    }
}

/// Top-of-screen banner for server notices and update offers.
struct BannerView: View {
    let icon: String
    let title: String
    let message: String
    let tint: Color
    var actionTitle: String?
    var action: (() -> Void)?
    var dismiss: (() -> Void)?
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                if !title.isEmpty { Text(title).font(.subheadline.weight(.semibold)) }
                if !message.isEmpty { Text(message).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                if let actionTitle, let action {
                    Button(actionTitle, action: action).font(.subheadline.weight(.semibold)).padding(.top, 2)
                }
            }
            Spacer(minLength: 0)
            if let dismiss {
                Button(action: dismiss) { Image(systemName: "xmark").font(.caption.weight(.bold)).padding(6) }
                    .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Dismiss")
            }
        }
        .padding(12)
        .studioGlass(RoundedRectangle(cornerRadius: 18, style: .continuous), tint: tint.opacity(0.12))
        .padding(.horizontal)
        .padding(.vertical, 6)
    }
}

extension Double {
    var clock: String {
        let s = Int(self.rounded())
        return String(format: "%d:%02d", s / 60, s % 60)
    }
}
