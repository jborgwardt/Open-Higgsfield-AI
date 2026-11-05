// swift-tools-version:6.2
// Networking, models, sign-in, server-driven config and diagnostics for the Film Studio app.
// Platform-neutral (Foundation, Security, ImageIO) so it unit-tests with `swift test` on the Mac.
import PackageDescription

let package = Package(
    name: "FilmStudioKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [.library(name: "FilmStudioKit", targets: ["FilmStudioKit"])],
    targets: [
        .target(name: "FilmStudioKit", resources: [.copy("Resources/default-app-config.json")]),
        .testTarget(name: "FilmStudioKitTests", dependencies: ["FilmStudioKit"]),
    ]
)
