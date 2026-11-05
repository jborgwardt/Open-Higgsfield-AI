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
                VStack(spacing: 28) {
                    Spacer(minLength: 40)
                    Image("BrandMark")
                        .resizable()
                        .frame(width: 112, height: 112)
                        .shadow(color: .orange.opacity(0.25), radius: 24)
                        .accessibilityHidden(true)
                    VStack(spacing: 8) {
                        Text("Film Studio").font(.largeTitle.weight(.bold))
                        Text(app.serverURL.host ?? app.serverURL.absoluteString)
                            .font(.callout.monospaced()).foregroundStyle(.secondary)
                    }
                    SignInControls()
                        .frame(maxWidth: 380)
                    Button(showServer ? "Hide server" : "Use a different server") { withAnimation { showServer.toggle() } }
                        .font(.footnote)
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
            .background(Color.groupedBackground)
        }
    }
}

/// The buttons/fields; shared by the sign-in screen and the session-expired sheet.
struct SignInControls: View {
    @Environment(AppModel.self) private var app
    @Environment(\.webAuthenticationSession) private var webAuth
    @State private var code = ""

    var body: some View {
        VStack(spacing: 14) {
            if app.health?.usesPocketID ?? true {
                Button {
                    Task { await app.signIn(using: webAuth) }
                } label: {
                    HStack {
                        if app.isSigningIn { ProgressView().tint(.white) } else { Image(systemName: "person.badge.key.fill") }
                        Text("Sign in with \(app.health?.provider ?? "Pocket ID")")
                    }
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .disabled(app.isSigningIn)
                .keyboardShortcut(.defaultAction)
                Text("Uses your passkey. Your session is stored in the Keychain on this device.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                SecureField("Access code", text: $code)
                    .textContentType(.password)
                    .plainField()
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { Task { await app.signIn(accessCode: code) } }
                Button {
                    Task { await app.signIn(accessCode: code) }
                } label: {
                    Text("Sign In").font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
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
                Image(systemName: "lock.rotation").font(.system(size: 48)).foregroundStyle(Color.accentColor)
                Text("Sign in again").font(.title2.weight(.bold))
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
