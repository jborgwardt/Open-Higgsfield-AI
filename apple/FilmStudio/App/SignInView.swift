import SwiftUI
import AuthenticationServices
import FilmStudioKit

/// Pocket ID passkey sign-in (ASWebAuthenticationSession), or an access code on code-mode engines.
struct SignInView: View {
    @Environment(AppModel.self) private var app
    @State private var showServer = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 26) {
                    Spacer(minLength: 56)
                    Image("BrandMark")
                        .resizable()
                        .frame(width: 104, height: 104)
                        .shadow(color: Color.violet.opacity(0.4), radius: 28) // brand violet halo (was off-palette orange)
                        .accessibilityHidden(true)
                    VStack(spacing: 10) {
                        Text("FILM STUDIO")
                            .font(.display(56))
                            .tracking(-0.5)
                            .foregroundStyle(.white)
                            .accessibilityAddTraits(.isHeader)
                        Text("Images, video, effects and whole films —\nrendered on your own studio.")
                            .font(.callout).foregroundStyle(Color.textSecondary).multilineTextAlignment(.center)
                        Text(app.serverURL.host ?? app.serverURL.absoluteString)
                            .font(.caption.monospaced()).foregroundStyle(Color.textTertiary)
                            .padding(.horizontal, 10).padding(.vertical, 5)
                            .glassFill(Capsule(), interactive: false)
                    }
                    SignInControls()
                        .frame(maxWidth: 380)
                        .padding(.top, 8)
                    Button(showServer ? "Hide server" : "Use a different server") { withAnimation { showServer.toggle() } }
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.textSecondary)
                    if showServer {
                        Form { ServerSection() }
                            .studioForm()
                            .frame(maxWidth: 480, minHeight: 220)
                            .scrollDisabled(true)
                    }
                    Spacer(minLength: 20)
                }
                .padding()
                .frame(maxWidth: .infinity)
            }
            .background {
                ZStack {
                    Color.canvas
                    RadialGradient(colors: [Color.ember.opacity(0.13), .clear], center: .init(x: 0.5, y: 0.18), startRadius: 0, endRadius: 360)
                }
                .ignoresSafeArea()
            }
        }
    }
}

/// The buttons/fields; shared by the sign-in screen and the session-expired sheet.
struct SignInControls: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var code = ""
    @State private var signInTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 14) {
            if app.health?.usesPocketID ?? true {
                Button {
                    #if os(macOS)
                    // The system passkey window only appears once Film Studio is the active app;
                    // launched or clicked in the background it otherwise waits silently.
                    NSApplication.shared.activate()
                    #endif
                    signInTask = Task { await app.signIn(using: webAuth) }
                } label: {
                    HStack {
                        if app.isSigningIn { ProgressView().tint(.black) } else { Image(systemName: "person.badge.key.fill") }
                        Text("Sign in with \(app.health?.provider ?? "Pocket ID")")
                    }
                }
                .buttonStyle(.ember(.large, fullWidth: true))
                .disabled(app.isSigningIn)
                .keyboardShortcut(.defaultAction)
                if app.isSigningIn {
                    // Never look frozen: say what we're waiting for and offer a way out.
                    Text("Waiting for the Pocket ID passkey window… If you don't see it, check behind this window.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Cancel sign-in") { signInTask?.cancel(); signInTask = nil; app.cancelSignIn() }
                        .buttonStyle(.plain).font(.callout.weight(.semibold)).foregroundStyle(Color.ember)
                } else {
                    Text("Uses your passkey. Your session is stored in the Keychain on this device.")
                        .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }
            } else {
                SecureField("Access code", text: $code)
                    .textContentType(.password)
                    .plainField()
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await app.signIn(accessCode: code) } }
                Button {
                    Task { await app.signIn(accessCode: code) }
                } label: {
                    Text("Sign In")
                }
                .buttonStyle(.ember(.large, fullWidth: true))
                .disabled(code.isEmpty || app.isSigningIn)
            }
            if let error = app.signInError {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout).foregroundStyle(.red).multilineTextAlignment(.center)
            }
        }
    }
}

/// Shown when the session expires (any 401) while using the app.
struct ReauthSheet: View {
    @Environment(AppModel.self) private var app
    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                Image(systemName: "lock.rotation").font(.system(size: 48)).foregroundStyle(Color.ember)
                DisplayTitle("Sign in again", size: 32).foregroundStyle(.white)
                Text("Your studio session has expired. Sign in to pick up where you left off — nothing running on the server was interrupted.")
                    .multilineTextAlignment(.center).foregroundStyle(.secondary)
                SignInControls()
            }
            .padding(28)
            .frame(maxWidth: 440)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Later") { app.sessionExpired = false } }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(app.isSigningIn)
    }
}
