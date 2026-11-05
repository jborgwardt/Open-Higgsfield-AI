import XCTest

/// Walks every main screen against a local engine (offline `local` provider — costs nothing) and saves
/// screenshots. Run with scripts/ui-screenshots.sh, which starts the engine and passes:
///   TEST_RUNNER_FS_SERVER   e.g. http://127.0.0.1:4961
///   TEST_RUNNER_FS_SHOTS    directory for PNGs
///   TEST_RUNNER_FS_PREFIX   file name prefix (iphone / ipad)
@MainActor
final class FilmStudioUITests: XCTestCase {
    private var app = XCUIApplication()
    private let env = ProcessInfo.processInfo.environment
    private var server: String { env["FS_SERVER"] ?? "http://127.0.0.1:4961" }
    private var prefix: String { env["FS_PREFIX"] ?? "device" }

    private func start() {
        continueAfterFailure = false
        app.launchArguments = ["-serverURL", server]
        app.launch()
    }

    // MARK: Helpers

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = "\(prefix)-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = env["FS_SHOTS"] {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("\(prefix)-\(name).png"))
        }
    }

    /// Tab bar on iPhone, sidebar on iPad.
    private func go(_ title: String) {
        let tab = app.tabBars.buttons[title]
        if tab.waitForExistence(timeout: 2) { tab.tap(); return }
        for q in [app.cells.containing(.staticText, identifier: title).firstMatch, app.buttons[title], app.staticTexts[title]] where q.exists {
            q.tap(); return
        }
        XCTFail("no navigation item \(title)")
    }

    private func button(_ prefix: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }
    /// A library tile (labelled "Image: …" / "Video: …").
    private var firstTile: XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Image:' OR label BEGINSWITH 'Video:'")).firstMatch
    }
    private func button(containing text: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    @discardableResult
    private func wait(_ e: XCUIElement, _ timeout: TimeInterval = 20, _ what: String = "") -> XCUIElement {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "timed out waiting for \(what.isEmpty ? e.description : what)")
        return e
    }

    private func type(into field: XCUIElement, _ text: String) {
        field.tap()
        field.typeText(text)
    }

    /// The navigation back button (on iPad the first bar button is the sidebar toggle, so never use that).
    private func back() {
        let b = app.navigationBars.buttons["BackButton"]
        if b.exists { b.tap(); return }
        let any = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'Back' OR identifier == 'BackButton'")).firstMatch
        if any.exists { any.tap() }
    }

    private func dismissKeyboard() {
        guard app.keyboards.count > 0 else { return }
        let done = app.toolbars.buttons["Done"]
        if done.exists { done.tap() } else { app.navigationBars.firstMatch.tap() }
    }

    // MARK: Flows

    func test1_CreateAndLibrary() {
        start()
        wait(app.staticTexts["What will you make?"], 30, "Explore")
        shot("01-explore")

        // Image
        button("Image").tap()
        let prompt = wait(app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch, 10, "prompt field")
        type(into: prompt, "A lighthouse on a cliff at dawn, mist over the sea")
        dismissKeyboard()
        shot("02-create-image")
        button(containing: "Generate Image").tap()
        wait(app.navigationBars["Image"], 60, "image result viewer")
        sleep(2)
        shot("03-image-result")
        back()
        back()

        // Video
        button("Video").tap()
        let vprompt = wait(app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields.firstMatch, 10, "prompt field")
        type(into: vprompt, "Slow push-in on a quiet harbour at night")
        dismissKeyboard()
        shot("04-create-video")
        button(containing: "Generate Video").tap()
        wait(app.navigationBars["Video"], 120, "video result viewer")
        sleep(3)
        shot("05-video-result")
        back()
        back()

        // Library
        go("Library")
        wait(app.staticTexts.matching(NSPredicate(format: "label ENDSWITH 'items'")).firstMatch, 20, "library grid")
        shot("06-library")
        firstTile.tap()
        sleep(2)
        shot("07-library-viewer")
        back()
    }

    func test2_FilmsCharactersSettings() {
        start()
        wait(app.staticTexts["What will you make?"], 30, "Explore")

        go("Films")
        sleep(1)
        shot("08-films-empty")
        button("New Film").tap()
        let title = wait(app.textFields["Title"], 10, "title field")
        type(into: title, "Harbour Lights")
        let script = app.textViews.firstMatch
        type(into: script, "A fisherman walks to the harbour before dawn. He unties his small boat. The engine coughs to life. The boat glides past the lighthouse into the open sea.")
        dismissKeyboard()
        // Shortest film for the test: 30 s.
        let dec = app.steppers.firstMatch.buttons.element(boundBy: 0)
        for _ in 0..<5 { if dec.isEnabled { dec.tap() } }
        shot("09-new-film")
        app.buttons["Create"].tap()

        // Plan → asks for a director first (there is no default).
        wait(button(containing: "Plan with Director"), 20).tap()
        if app.navigationBars["Choose a Director"].waitForExistence(timeout: 8) {
            shot("10-choose-director")
            button("Director").tap()
            wait(button(containing: "No AI"), 5).tap()
            sleep(1)
            app.buttons["Plan Film"].tap()
        }
        wait(button(containing: "Start Rendering"), 60, "planned film")
        sleep(1)
        shot("11-film-planned")
        button(containing: "Start Rendering").tap()
        wait(app.buttons["Play film"], 300, "assembled master")
        sleep(1)
        shot("12-film-done")
        app.buttons["Play film"].tap()
        wait(app.navigationBars["Video"], 20)
        sleep(3)
        shot("13-film-master")
        back()
        back()

        go("Characters")
        sleep(2)
        shot("14-characters")

        go("Settings")
        sleep(2)
        shot("15-settings")
    }

    /// Needs the Characters/Tools API (or scripts/contract-mock.mjs in front of the engine).
    func test3_ToolsAndCharacters() {
        start()
        wait(app.staticTexts["What will you make?"], 30, "Explore")
        wait(button("Talking Avatar"), 20, "tools on Explore")
        sleep(2)
        shot("16-explore-tools")

        // A server-defined tool, rendered from its schema.
        button("Talking Avatar").tap()
        wait(app.navigationBars["Talking Avatar"], 10)
        // The picker row inside the form (not the "Characters" tab).
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Character' AND NOT (label BEGINSWITH 'Characters')")).firstMatch.tap()
        wait(app.buttons["Bub"], 5).tap()
        let line = app.textViews.firstMatch.exists ? app.textViews.firstMatch : app.textFields["Line"]
        type(into: line, "The harbour never sleeps.")
        dismissKeyboard()
        shot("17-tool-form")
        button(containing: "Run Talking Avatar").tap()
        wait(app.navigationBars["Video"], 120, "tool result")
        sleep(2)
        shot("18-tool-result")
        back()
        back()

        go("Characters")
        wait(button("Bub"), 15, "character grid")
        sleep(1)
        shot("19-characters")
        button("Bub").tap()
        wait(app.navigationBars["Bub"], 10)
        sleep(2)
        shot("20-character-detail")
        let generate = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Character Sheet' OR label CONTAINS 'New Sheet'")).firstMatch
        for _ in 0..<6 where !generate.exists { app.swipeUp() }
        generate.tap()
        let approve = button(containing: "Approve Sheet")
        for _ in 0..<30 where !approve.exists {
            sleep(2)
            app.swipeUp()
        }
        wait(approve, 5, "character sheet").tap()
        sleep(2)
        shot("21-character-sheet")
        app.swipeDown()
        app.swipeDown()
        button(containing: "Guided Capture").tap()
        wait(app.staticTexts["Before you start"], 10)
        sleep(1)
        shot("22-guided-capture")
    }

    /// Server-driven config: change it on the engine while the app runs; the app obeys on the next foreground.
    func test4_ServerDrivenConfig() throws {
        try patchConfig(["reset": true])
        start()
        wait(app.staticTexts["What will you make?"], 30, "Explore")
        shot("23-config-before")

        // Flip a tab to web, disable a feature, change a default, set a notice.
        try patchConfig([
            "tabs": ["films": ["kind": "web", "path": "/"]],
            "features": ["saveToPhotos": false],
            "defaults": ["aspect": "9:16"],
            "notice": ["id": UUID().uuidString, "title": "Maintenance tonight", "body": "The studio restarts at 22:00 for an update.", "level": "warning"],
        ])
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        wait(app.staticTexts["Maintenance tonight"], 15, "server notice")
        shot("24-config-notice")

        go("Films")
        wait(app.webViews.firstMatch, 15, "web version of Films")
        sleep(5)
        shot("25-config-films-web")

        go("Explore")
        button("Image").tap()
        wait(app.navigationBars["Create Image"], 10)
        sleep(1)
        shot("26-config-default-aspect")
        back()

        go("Library")
        wait(firstTile, 15).tap()
        wait(app.buttons["More"], 10).tap()
        wait(app.buttons["Copy Prompt"], 5, "the More menu")
        XCTAssertFalse(app.buttons["Save to Photos"].exists, "saveToPhotos is off on the server")
        shot("27-config-no-save-to-photos")

        try patchConfig(["reset": true])
    }

    /// Native sign-in end to end: needs an engine with OIDC pointed at scripts/fake-oidc.mjs (auto-approves
    /// in place of the passkey). ASWebAuthenticationSession → /engine/auth/native → IdP → filmstudio://auth.
    func test5_SignIn() {
        start()
        let signIn = wait(button(containing: "Sign in with"), 30, "sign-in screen")
        sleep(1)
        shot("30-sign-in")
        signIn.tap()
        wait(app.staticTexts["What will you make?"], 40, "signed in")
        shot("31-signed-in")
        go("Settings")
        wait(app.staticTexts["justin@example.com"], 10, "signed-in user")
        shot("32-settings-signed-in")
        // Relaunch: the session comes back from the Keychain.
        app.terminate()
        start()
        wait(app.staticTexts["What will you make?"], 30, "still signed in after relaunch")
        go("Settings")
        let out = wait(app.buttons["Sign Out"], 10)
        out.tap()
        sleep(1)
        let confirm = app.buttons.matching(identifier: "Sign Out")
        confirm.element(boundBy: confirm.count - 1).tap() // the confirmation dialog's button
        wait(button(containing: "Sign in with"), 20, "signed out")
        shot("33-signed-out")
    }

    private func patchConfig(_ body: [String: Any]) throws {
        var r = URLRequest(url: URL(string: "\(server)/engine/api/app/config")!)
        r.httpMethod = "PATCH"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.httpBody = try JSONSerialization.data(withJSONObject: body)
        final class Status: @unchecked Sendable { var code = 0 }
        let status = Status()
        let done = expectation(description: "PATCH /app/config")
        URLSession.shared.dataTask(with: r) { _, resp, _ in
            status.code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        XCTAssertEqual(status.code, 200, "PATCH /app/config failed")
    }
}
