import XCTest

/// QA walkthrough of the Higgsfield-style redesign against a VPS test engine (access-code mode, free `local`
/// models only). Every generation is guarded: it only proceeds when the composer's model chip names a free
/// offline model. Run with:
///   TEST_RUNNER_FS_SERVER=http://127.0.0.1:4967 TEST_RUNNER_FS_CODE=<code> TEST_RUNNER_FS_SHOTS=<dir> \
///   TEST_RUNNER_FS_PREFIX=iphone xcodebuild test … -only-testing:FilmStudioUITests/QAWalkthroughTests
/// Screenshots (and accessibility dumps, `*.txt`) land in FS_SHOTS as qa-<prefix>-<name>.png.
@MainActor
final class QAWalkthroughTests: XCTestCase {
    private var app = XCUIApplication()
    private let env = ProcessInfo.processInfo.environment
    private var server: String { env["FS_SERVER"] ?? "http://127.0.0.1:4967" }
    private var prefix: String { env["FS_PREFIX"] ?? "device" }
    private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// Free offline models on the engine. Nothing else may ever be generated with.
    static let freeVideo = "Animatic (offline previs)"
    static let freeImage = "Previs plate (offline)"

    override func setUp() {
        continueAfterFailure = true
    }

    private func start(_ extra: [String] = []) {
        app.launchArguments = ["-serverURL", server] + extra
        app.launch()
        let field = app.secureTextFields["Access code"]
        if let code = env["FS_CODE"], !code.isEmpty, field.waitForExistence(timeout: 8) {
            field.tap()
            field.typeText(code)
            app.buttons["Sign In"].tap()
        }
        // Signed in = the main chrome exists (the app may restore a tab other than Home).
        XCTAssertTrue(app.buttons["Create"].firstMatch.waitForExistence(timeout: 30) || app.staticTexts["FILM STUDIO"].exists, "main UI did not appear")
    }

    // MARK: Helpers

    private func shot(_ name: String) {
        let png = XCUIScreen.main.screenshot().pngRepresentation
        let a = XCTAttachment(data: png, uniformTypeIdentifier: "public.png")
        a.name = "qa-\(prefix)-\(name)"
        a.lifetime = .keepAlways
        add(a)
        if let dir = env["FS_SHOTS"] {
            try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent("qa-\(prefix)-\(name).png"))
        }
    }

    private func dump(_ name: String) {
        guard let dir = env["FS_SHOTS"] else { return }
        try? app.debugDescription.write(to: URL(fileURLWithPath: dir).appendingPathComponent("qa-\(prefix)-\(name).txt"), atomically: true, encoding: .utf8)
    }

    private func note(_ text: String) {
        guard let dir = env["FS_SHOTS"] else { return }
        let url = URL(fileURLWithPath: dir).appendingPathComponent("qa-\(prefix)-notes.log")
        let line = "[\(name)] \(text)\n"
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(line.data(using: .utf8)!); try? h.close() }
        else { try? line.write(to: url, atomically: true, encoding: .utf8) }
    }

    private func btn(_ label: String) -> XCUIElement { app.buttons[label].firstMatch }
    private func btn(prefix p: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", p)).firstMatch
    }
    private func btn(containing t: String) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "label CONTAINS %@", t)).firstMatch
    }

    @discardableResult
    private func wait(_ e: XCUIElement, _ timeout: TimeInterval = 15, _ what: String = "") -> Bool {
        let ok = e.waitForExistence(timeout: timeout)
        if !ok { note("MISSING: \(what.isEmpty ? e.description : what)") }
        XCTAssertTrue(ok, "timed out waiting for \(what.isEmpty ? e.description : what)")
        return ok
    }

    /// Tab bar button on iPhone (custom bar: plain buttons), sidebar cell on iPad.
    private func go(_ title: String) {
        if isPad {
            let cell = app.cells.containing(.staticText, identifier: title).firstMatch
            if cell.waitForExistence(timeout: 3) { cell.tap(); return }
            let any = app.staticTexts[title].firstMatch
            if any.exists { any.tap(); return }
            // A collapsed sidebar: open it.
            let toggle = app.navigationBars.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Sidebar'")).firstMatch
            if toggle.exists { toggle.tap(); if cell.waitForExistence(timeout: 3) { cell.tap(); return } }
        }
        let b = btn(title)
        if b.waitForExistence(timeout: 3) { b.tap(); return }
        XCTFail("no navigation item \(title)")
    }

    /// Profile → a row (Films / Tools / Settings) on iPhone; the sidebar on iPad.
    private func openViaProfile(_ row: String) {
        if isPad, app.cells.containing(.staticText, identifier: row).firstMatch.waitForExistence(timeout: 2) { go(row); return }
        go("Profile")
        let r = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", row)).firstMatch
        if wait(r, 8, "Profile row \(row)") { r.tap() }
    }

    private func back() {
        let b = app.navigationBars.buttons["BackButton"]
        if b.exists { b.tap(); return }
        let any = app.navigationBars.buttons.matching(NSPredicate(format: "label == 'Back' OR identifier == 'BackButton'")).firstMatch
        if any.exists { any.tap(); return }
        // Custom chrome (hidden nav bar): swipe from the left edge.
        let s = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        s.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)))
    }

    private func closeComposer() {
        let close = btn("Close")
        if close.waitForExistence(timeout: 3) { close.tap() } else { back() }
        sleep(1)
    }

    private func dismissKeyboard() {
        guard app.keyboards.count > 0 else { return }
        let done = app.buttons["Done"].firstMatch
        if done.exists && done.isHittable { done.tap(); return }
        let title = app.navigationBars.staticTexts.firstMatch
        if title.exists { title.tap() }
        if app.keyboards.count > 0 { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.12)).tap() }
        if app.keyboards.count > 0 { note("keyboard could not be dismissed") }
    }

    private func scrollHome(toFind label: String, max: Int = 14) -> XCUIElement {
        let e = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", label)).firstMatch
        for _ in 0..<max where !(e.exists && e.isHittable) { app.swipeUp(velocity: .slow) }
        return e
    }

    /// The composer's model chip, labelled "Model: <name>".
    private var modelChip: XCUIElement { btn(prefix: "Model:") }

    /// Picks a free model in the composer's picker. Returns false (and never generates) if it could not.
    @discardableResult
    private func chooseFreeModel(video: Bool) -> Bool {
        let want = video ? Self.freeVideo : Self.freeImage
        guard wait(modelChip, 10, "model chip") else { return false }
        if modelChip.label.contains(want) { return true }
        modelChip.tap()
        guard wait(app.navigationBars["Models"], 8, "model picker") else { return false }
        let seg = app.segmentedControls.buttons[video ? "Video" : "Image"]
        if seg.exists { seg.tap() }
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", want)).firstMatch
        for _ in 0..<12 where !(card.exists && card.isHittable) { app.swipeUp() }
        guard card.exists else { note("free model card \(want) not found in picker"); return false }
        card.tap()
        sleep(1)
        return modelChip.label.contains(want)
    }

    /// Only taps Generate when the model chip names a free model.
    private func generateGuarded(video: Bool) -> Bool {
        let want = video ? Self.freeVideo : Self.freeImage
        guard modelChip.exists, modelChip.label.contains(want) else {
            XCTFail("refusing to generate: model is \(modelChip.exists ? modelChip.label : "unknown"), not \(want)")
            return false
        }
        let g = btn(prefix: "Generate")
        guard wait(g, 5, "Generate button"), g.isEnabled else { note("Generate disabled"); return false }
        g.tap()
        return true
    }

    private func typePrompt(_ text: String) {
        let field = app.textViews["Prompt"].exists ? app.textViews["Prompt"] : (app.textFields["Prompt"].exists ? app.textFields["Prompt"] : app.textViews.firstMatch)
        guard wait(field, 8, "prompt field") else { return }
        field.tap()
        field.typeText(text)
        dismissKeyboard()
    }

    // MARK: 01 Home feed

    func test01_HomeFeed() {
        start()
        sleep(4)
        shot("01-home-top")
        dump("01-home-top")
        sleep(2)
        shot("01b-home-top-2s-later") // autoplay check: compare with 01
        // Hero carousel: swipe through.
        let hero = app.scrollViews.firstMatch
        if hero.exists {
            app.swipeLeft()
            sleep(2)
            shot("02-hero-swiped")
        }
        var i = 0
        for _ in 0..<14 {
            app.swipeUp(velocity: .slow)
            sleep(1)
            i += 1
            shot(String(format: "03-home-scroll-%02d", i))
        }
        dump("03-home-bottom")
        // Back to top by tapping Home again.
        go("Home")
        sleep(1)
        shot("04-home-retap")
    }

    // MARK: 02 Home tile actions

    func test02_HomeTileActions() {
        start()
        sleep(3)
        // Hero tile → composer preconfigured.
        let heroCard = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Studio'")).firstMatch
        if wait(heroCard, 10, "hero card") {
            note("hero first: \(heroCard.label)")
            heroCard.tap()
            sleep(2)
            shot("10-hero-tap")
            dump("10-hero-tap")
            closeComposer()
        }
        // Video model tile.
        let vm = scrollHome(toFind: "Video Models")
        note("video models header exists: \(vm.exists)")
        sleep(1)
        shot("11-video-models-shelf")
        dump("11-video-models-shelf")
        // First tile below the header: match by known catalogue names (feed copy is server-driven).
        let modelTile = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Kling' OR label CONTAINS[c] 'Veo' OR label CONTAINS[c] 'Seedance' OR label CONTAINS[c] 'Grok'")).firstMatch
        if modelTile.exists {
            note("model tile: \(modelTile.label)")
            modelTile.tap()
            sleep(2)
            shot("12-model-tile-composer")
            note("model chip after model tile: \(modelChip.exists ? modelChip.label : "none")")
            closeComposer()
        }
        // Presets (viral effects) grid.
        _ = scrollHome(toFind: "Viral Effects")
        sleep(1)
        shot("13-presets")
        // Tools grid / shelf.
        _ = scrollHome(toFind: "Apps")
        sleep(1)
        shot("14-apps")
        dump("14-apps")
        _ = scrollHome(toFind: "Image Models")
        sleep(1)
        shot("15-image-models")
        _ = scrollHome(toFind: "Your Characters")
        sleep(1)
        shot("16-characters-shelf")
        _ = scrollHome(toFind: "Recent")
        sleep(1)
        shot("17-recent")
        dump("17-recent")
    }

    /// Taps every item in a section by id-agnostic label list from the feed, one at a time, and records where it lands.
    func test03_EveryTileLands() {
        start()
        sleep(3)
        let labels: [String] = (env["FS_TILES"] ?? "").split(separator: "|").map(String.init)
        for (n, label) in labels.enumerated() {
            let tile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            for _ in 0..<16 where !(tile.exists && tile.isHittable) { app.swipeUp(velocity: .fast) }
            var tries = 0
            while !(tile.exists && tile.isHittable), tries < 6 { // shelves scroll horizontally
                let shelf = app.scrollViews.containing(.button, identifier: label).firstMatch
                if shelf.exists { shelf.swipeLeft() } else { break }
                tries += 1
            }
            guard tile.exists, tile.isHittable else { note("TILE NOT REACHABLE: \(label)"); app.terminate(); start(); continue }
            tile.tap()
            sleep(2)
            let landed: String
            if modelChip.exists { landed = "composer [\(modelChip.label)]" }
            else if let nb = app.navigationBars.allElementsBoundByIndex.last(where: { !$0.identifier.isEmpty }) { landed = "nav: \(nb.identifier)" }
            else { landed = "other" }
            note("TILE \(label) → \(landed)")
            shot(String(format: "20-tile-%02d", n))
            app.terminate()
            start()
            sleep(2)
        }
    }

    // MARK: 04 Create composer

    func test04_Composer() {
        start()
        let create = btn("Create")
        guard wait(create, 10, "Create button") else { return }
        create.tap()
        sleep(2)
        shot("30-composer-open")
        dump("30-composer-open")
        // Mode switch
        let imageMode = app.buttons["IMAGE"].firstMatch
        if imageMode.exists { imageMode.tap(); sleep(1); shot("31-composer-image-mode") }
        let videoMode = app.buttons["VIDEO"].firstMatch
        if videoMode.exists { videoMode.tap(); sleep(1) }
        // Model picker
        modelChip.tap()
        if wait(app.navigationBars["Models"], 8, "model picker") {
            sleep(2)
            shot("32-model-picker-video")
            dump("32-model-picker")
            app.swipeUp(); sleep(1); shot("33-model-picker-video-2")
            app.swipeUp(); app.swipeUp(); sleep(1); shot("33b-model-picker-video-3")
            let seg = app.segmentedControls.buttons["Image"]
            if seg.exists { seg.tap(); sleep(2); shot("34-model-picker-image") }
            btn("Close").tap()
            sleep(1)
        }
        // Free video model + every chip
        XCTAssertTrue(chooseFreeModel(video: true), "could not select the free video model")
        shot("35-composer-free-video")
        dump("35-composer-free-video")
        for chip in ["16:9", "aspectratio"] {
            let c = btn(containing: chip)
            if c.exists { c.tap(); sleep(1); shot("36-aspect-menu"); dump("36-aspect-menu"); let opt = btn("9:16"); if opt.exists { opt.tap() } else { app.tap() }; break }
        }
        let dur = app.buttons.matching(NSPredicate(format: "label MATCHES '.*[0-9]+s.*'")).firstMatch
        if dur.exists { dur.tap(); sleep(1); shot("37-duration-menu"); let o = btn("4 s"); if o.exists { o.tap() } }
        let frames = btn(containing: "Start frame")
        if frames.exists { frames.tap(); sleep(1); shot("38-frames-menu"); dump("38-frames-menu"); let s = btn(prefix: "Start frame"); if s.exists { s.tap(); sleep(3); shot("39-photos-picker"); dump("39-photos-picker")
            let photo = app.scrollViews.images.firstMatch.exists ? app.scrollViews.images.firstMatch : app.images.matching(NSPredicate(format: "label CONTAINS 'Photo'")).firstMatch
            if photo.exists { photo.tap(); sleep(4); shot("40-start-frame-attached") } else { note("no photo in picker"); app.swipeDown() }
        } }
        typePrompt("Slow push-in on a quiet harbour at night, lanterns flicker")
        shot("41-composer-ready")
        guard generateGuarded(video: true) else { return }
        sleep(1)
        shot("42-generating")
        dump("42-generating")
        // Result
        var done = false
        for t in 0..<60 {
            sleep(2)
            if t == 2 { shot("43-progress") }
            if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GENERATING'")).count == 0 { done = true; break }
        }
        note("video generation finished within 120s: \(done)")
        sleep(2)
        shot("44-video-result-stage")
        dump("44-video-result-stage")
        // Remix actions on the stage / viewer
        for a in ["Use as Start Frame", "Animate", "Upscale", "Open", "View"] where btn(containing: a).exists { note("stage action available: \(a)") }
        let openResult = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Video:' OR label CONTAINS 'Open result' OR label CONTAINS 'View'")).firstMatch
        if openResult.exists { openResult.tap(); sleep(3); shot("45-result-viewer"); dump("45-result-viewer")
            let more = btn("More"); if more.exists { more.tap(); sleep(1); shot("46-viewer-more"); dump("46-viewer-more"); app.swipeDown() }
            back()
        }
        // Image generation
        if imageMode.exists { imageMode.tap(); sleep(1) }
        XCTAssertTrue(chooseFreeModel(video: false), "could not select the free image model")
        let ref = btn(containing: "Reference")
        note("image reference chip exists (local/plate refs=0 so expected hidden): \(ref.exists)")
        typePrompt("A red lighthouse on a cliff at dawn")
        guard generateGuarded(video: false) else { return }
        sleep(1)
        shot("47-image-generating")
        for _ in 0..<30 { sleep(2); if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GENERATING'")).count == 0 { break } }
        sleep(2)
        shot("48-image-result")
        dump("48-image-result")
        closeComposer()
        shot("49-after-close")
    }

    /// Progress pill: start a generation, close the composer while it runs.
    func test05_ProgressPill() {
        start()
        btn("Create").tap()
        sleep(2)
        XCTAssertTrue(chooseFreeModel(video: true))
        let d10 = app.buttons.matching(NSPredicate(format: "label MATCHES '.*[0-9]+s.*'")).firstMatch
        if d10.exists { d10.tap(); let o = btn("10 s"); if o.waitForExistence(timeout: 2) { o.tap() } }
        typePrompt("Waves rolling over black rocks under a storm")
        guard generateGuarded(video: true) else { return }
        sleep(1)
        closeComposer()
        shot("50-progress-pill")
        dump("50-progress-pill")
        let pill = btn(prefix: "Generating")
        if pill.exists { pill.tap(); sleep(1); shot("51-library-with-placeholder") }
        else { note("no progress pill after closing the composer mid-generation"); go("Library"); sleep(1); shot("51-library-with-placeholder") }
        dump("51-library")
        sleep(20)
        shot("52-library-after-finish")
    }

    // MARK: 06 Library

    func test06_Library() {
        start()
        go("Library")
        sleep(3)
        shot("60-library")
        dump("60-library")
        for f in ["Videos", "Images", "Films", "Characters", "All"] {
            let c = btn(f)
            if c.exists && c.isHittable { c.tap(); sleep(2); shot("61-filter-\(f.lowercased())") } else { note("filter chip missing/unhittable: \(f) exists=\(c.exists)") }
        }
        if !(btn("All").exists && btn("All").isHittable) { app.terminate(); start(); go("Library"); sleep(3) }
        let tile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Video:' OR label BEGINSWITH 'Image:'")).firstMatch
        if wait(tile, 10, "library tile") {
            tile.press(forDuration: 1.2)
            sleep(1)
            shot("62-long-press")
            dump("62-long-press")
            let cancel = app.buttons["Cancel"]
            if cancel.exists { cancel.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.05)).tap() }
            sleep(1)
            let vid = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Video:'")).firstMatch
            if vid.exists { vid.tap(); sleep(4); shot("63-viewer-video"); dump("63-viewer-video"); back(); sleep(1) }
            let img = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Image:'")).firstMatch
            if img.exists { img.tap(); sleep(2); shot("64-viewer-image"); dump("64-viewer-image")
                let more = btn("More"); if more.exists { more.tap(); sleep(1); shot("65-viewer-more"); app.swipeDown() }
                back(); sleep(1)
            }
        }
        // Delete the last tile via long-press → Remove.
        let all = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Image:'"))
        let before = all.count
        if before > 0 {
            let t = all.element(boundBy: before - 1)
            for _ in 0..<5 where !t.isHittable { app.swipeUp() }
            t.press(forDuration: 1.2)
            let rm = btn(prefix: "Remove")
            if rm.waitForExistence(timeout: 3) { rm.tap(); sleep(1); shot("66-delete-confirm"); let c = app.buttons.matching(NSPredicate(format: "label == 'Remove'")); if c.count > 0 { c.element(boundBy: c.count - 1).tap() } }
            sleep(3)
            note("image tiles before delete \(before), after \(all.count)")
            shot("67-after-delete")
        }
        // Pull to refresh
        app.swipeDown(velocity: .fast); app.swipeDown(velocity: .fast)
        sleep(2)
        shot("68-after-refresh")
        let search = btn("Search")
        if search.exists { search.tap(); sleep(1); app.typeText("lighthouse"); sleep(1); shot("69-search"); dismissKeyboard() }
    }

    // MARK: 07 Films

    func test07_Films() {
        start()
        openViaProfile("Films")
        sleep(3)
        shot("70-films")
        dump("70-films")
        // Existing seeded film
        let seeded = env["FS_SKIP_SEED"] == "1" ? app.buttons["__none__"] : app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Harbour Seed'")).firstMatch
        if seeded.exists { seeded.tap(); sleep(3)
            if btn("New film").exists && btn("New film").isHittable {
                note("BUG? tapping the film card in Profile → Films did not open the film; trying Library → Films")
                go("Library"); sleep(2)
                let fchip = app.scrollViews.buttons["Films"].firstMatch
                if fchip.exists { fchip.tap(); sleep(2) }
                let card = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Harbour Seed'")).firstMatch
                if card.exists { card.tap(); sleep(3) }
            }
            shot("71-film-detail"); dump("71-film-detail")
            app.swipeUp(); sleep(1); shot("72-film-detail-2")
            let shotRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Shot'")).firstMatch
            if shotRow.exists { shotRow.tap(); sleep(2); shot("73-edit-shot"); dump("73-edit-shot"); back(); sleep(1) }
            let play = btn(prefix: "Play film")
            for _ in 0..<4 where !play.exists { app.swipeDown() }
            if play.exists { play.tap(); sleep(4); shot("74-film-play"); back(); sleep(1) } else { note("no Play film on seeded film") }
        } else { note("seeded film not listed") }
        app.terminate(); start(); openViaProfile("Films"); sleep(2)
        // New film with the split director + free models
        let new = btn(prefix: "New Film").exists ? btn(prefix: "New Film") : btn(prefix: "New film")
        guard wait(new, 8, "New Film") else { return }
        new.tap()
        sleep(2)
        shot("75-new-film")
        dump("75-new-film")
        // Pickers first (no keyboard yet), then the text: the script editor's keyboard can't be dismissed.
        pickInForm("Video model", Self.freeVideo)
        pickInForm("Keyframe model", Self.freeImage)
        if env["FS_DIRECTOR_PICK"] != "0" { pickInForm("Director", "No AI") }
        let dec = app.steppers.firstMatch.buttons.element(boundBy: 0)
        for _ in 0..<4 where !(dec.exists && dec.isHittable) { app.swipeDown(velocity: .slow) }
        for _ in 0..<6 where dec.exists && dec.isHittable && dec.isEnabled { dec.tap() }
        shot("76-new-film-pickers")
        dump("76-new-film-pickers")
        let title = app.textFields["Title"]
        if title.exists { title.tap(); title.typeText("QA Lighthouse") }
        let script = app.textViews.firstMatch
        if script.exists { script.tap(); script.typeText("A keeper climbs the lighthouse stairs. He lights the lamp. The beam sweeps the sea. A ship turns toward shore.") }
        shot("78-new-film-filled")
        let createFilm = app.navigationBars.buttons["Create"]
        guard wait(createFilm, 5, "New Film Create") else { return }
        createFilm.tap()
        sleep(3)
        shot("79-film-created")
        dump("79-film-created")
        guard let prod = latestProduction(titled: "QA Lighthouse") else { XCTFail("film not on server"); return }
        let brief = prod["brief"] as? [String: Any] ?? [:]
        note("server brief: video=\(brief["videoModel"] ?? "-") image=\(brief["imageModel"] ?? "-") director=\(brief["directorProvider"] ?? "-") autoScreen=\(brief["autoScreen"] ?? "-") minutes=\(brief["targetMinutes"] ?? "-")")
        guard brief["videoModel"] as? String == "local/animatic", brief["imageModel"] as? String == "local/plate" else {
            XCTFail("refusing to render: brief models are not the free local ones"); return
        }
        // The app has no switch for these; keep the test free (Gemini screening, likeness scoring).
        _ = api("PATCH", "/productions/\(prod["id"] as! String)", ["autoScreen": false, "likenessQA": false, "music": "off", "narration": false])
        let plan = btn(containing: "Plan with Director")
        if wait(plan, 10, "Plan with Director") { plan.tap() }
        if app.navigationBars["Choose a Director"].waitForExistence(timeout: 5) {
            shot("79b-choose-director"); dump("79b-choose-director")
            if env["FS_DIRECTOR_PICK"] != "0" { pickInForm("Director", "No AI") }
            let p2 = app.buttons["Plan Film"]; if p2.exists { p2.tap() }
        }
        let render = btn("Render").exists ? btn("Render") : btn(containing: "Start Rendering")
        _ = btn("Render").waitForExistence(timeout: 60)
        guard wait(render, 60, "planned film") else { shot("79c-plan-failed"); return }
        sleep(1)
        shot("7a-film-planned")
        dump("7a-film-planned")
        render.tap()
        let pause = btn(prefix: "Pause")
        if pause.waitForExistence(timeout: 10) { sleep(1); shot("7b-rendering"); pause.tap(); sleep(3); shot("7c-paused"); dump("7c-paused") }
        else { note("no Pause button while rendering") }
        let resume = btn("Resume").waitForExistence(timeout: 10) ? btn("Resume") : btn("Render")
        if resume.waitForExistence(timeout: 10) { resume.tap() } else { note("no Resume after pause") }
        let play = app.buttons["Play film"]
        if wait(play, 300, "assembled master") {
            sleep(1)
            shot("7d-film-done")
            // Edit a shot
            let shotRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Shot' OR label CONTAINS 'Shot 1'")).firstMatch
            for _ in 0..<5 where !shotRow.exists { app.swipeUp() }
            if shotRow.exists { shotRow.tap(); sleep(2); shot("7e-edit-shot"); dump("7e-edit-shot")
                let prompt = app.textFields["Prompt"].exists ? app.textFields["Prompt"] : app.textViews.firstMatch
                if prompt.exists { prompt.tap(); prompt.typeText(" Fog rolls in."); dismissKeyboard() }
                let save = btn(containing: "Save & Re-render")
                if save.exists, freeBrief(prod["id"] as! String) { save.tap(); sleep(3); shot("7f-shot-rerender") } else { back() }
                sleep(2)
            } else { note("no shot rows on finished film"); dump("7e-no-shot-rows") }
            for _ in 0..<6 { app.swipeDown() }
            let assemble = btn(prefix: "Re-assemble").exists ? btn(prefix: "Re-assemble") : btn(prefix: "Assemble")
            if assemble.waitForExistence(timeout: 120), assemble.isEnabled { assemble.tap(); sleep(5); shot("7g-reassemble") } else { note("Assemble not available") }
            if play.waitForExistence(timeout: 120) { play.tap(); sleep(4); shot("7h-film-playing"); dump("7h-film-playing"); back() }
        }
    }

    /// Picks `option` from a Form picker row titled `row` (menu style).
    private func pickInForm(_ row: String, _ option: String) {
        dismissKeyboard()
        let r = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", row)).firstMatch
        for _ in 0..<8 where !(r.exists && r.isHittable) { app.swipeUp() }
        for _ in 0..<8 where !(r.exists && r.isHittable) { app.swipeDown() }
        guard r.exists else { note("form row missing: \(row)"); return }
        r.tap()
        let o = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", option)).firstMatch
        _ = o.waitForExistence(timeout: 3)
        for _ in 0..<6 where !(o.exists && o.isHittable) {
            let m = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.6))
            m.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)))
        }
        if o.exists && o.isHittable { o.tap() } else {
            let c = app.cells.containing(NSPredicate(format: "label BEGINSWITH %@", option)).firstMatch
            if c.exists { c.tap() } else { note("option \(option) missing in \(row)"); dump("pick-\(row)"); app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap() }
        }
        sleep(1)
    }

    private func freeBrief(_ id: String) -> Bool {
        guard let p = api("GET", "/productions/\(id)", nil) as? [String: Any], let b = p["brief"] as? [String: Any] else { return false }
        return b["videoModel"] as? String == "local/animatic" && b["imageModel"] as? String == "local/plate"
    }

    private func latestProduction(titled t: String) -> [String: Any]? {
        guard let list = api("GET", "/productions", nil) as? [[String: Any]] else { return nil }
        guard let s = list.filter({ ($0["title"] as? String) == t }).sorted(by: { ($0["createdAt"] as? String ?? "") > ($1["createdAt"] as? String ?? "") }).first,
              let id = s["id"] as? String else { return nil }
        return api("GET", "/productions/\(id)", nil) as? [String: Any]
    }

    /// Engine API call with the access code (JSON in/out).
    private func api(_ method: String, _ path: String, _ body: [String: Any]?) -> Any? {
        var r = URLRequest(url: URL(string: "\(server)/engine/api\(path)")!)
        r.httpMethod = method
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let code = env["FS_CODE"], !code.isEmpty { r.setValue("Bearer \(code)", forHTTPHeaderField: "Authorization") }
        if let body { r.httpBody = try? JSONSerialization.data(withJSONObject: body) }
        final class Box: @unchecked Sendable { var data: Data? }
        let box = Box()
        let done = expectation(description: "\(method) \(path)")
        URLSession.shared.dataTask(with: r) { d, _, _ in box.data = d; done.fulfill() }.resume()
        wait(for: [done], timeout: 15)
        return box.data.flatMap { try? JSONSerialization.jsonObject(with: $0) }
    }

    // MARK: 08 Characters

    func test08_Characters() {
        start()
        go("Characters")
        sleep(3)
        shot("80-characters")
        dump("80-characters")
        let new = btn("New Character").exists ? btn("New Character") : btn(prefix: "New")
        guard wait(new, 8, "New Character") else { return }
        new.tap()
        sleep(2)
        shot("81-new-character")
        dump("81-new-character")
        let name = app.textFields.matching(NSPredicate(format: "placeholderValue == 'Name'")).firstMatch
        if name.exists { name.tap(); name.typeText("QA Keeper") }
        let desc = app.textFields.matching(NSPredicate(format: "placeholderValue BEGINSWITH 'Who'")).firstMatch
        if desc.exists { desc.tap(); desc.typeText("An old lighthouse keeper") }
        let create = app.navigationBars.buttons["Create"]
        if create.exists { create.tap() }
        sleep(3)
        shot("82-character-detail")
        dump("82-character-detail")
        let add = btn(prefix: "Add Photos")
        for _ in 0..<4 where !add.exists { app.swipeUp() }
        if add.exists { add.tap(); sleep(3); shot("83-add-photos-picker"); dump("83-photos")
            let photo = app.scrollViews.images.firstMatch
            if photo.exists { photo.tap(); sleep(1); let a = app.buttons["Add"]; if a.exists { a.tap() }; sleep(6); shot("84-character-with-photo") } else { app.swipeDown() }
        }
        app.swipeUp(); sleep(1); shot("85-coverage"); dump("85-coverage")
        app.swipeUp(); sleep(1); shot("86-character-bottom")
        // Never tap "Generate Character Sheet" (paid).
    }

    // MARK: 09 Tools

    func test09_Tools() {
        start()
        openViaProfile("Tools")
        sleep(3)
        shot("90-tools")
        dump("90-tools")
        app.swipeUp(); sleep(1); shot("91-tools-2")
        app.swipeDown(); app.swipeDown()
        let names = (env["FS_TOOLS"] ?? "").split(separator: "|").map(String.init)
        for (n, t) in names.enumerated() {
            let b = app.buttons.matching(NSPredicate(format: "label BEGINSWITH[c] %@", t)).firstMatch
            for _ in 0..<10 where !(b.exists && b.isHittable) { app.swipeUp() }
            guard b.exists else { note("tool tile missing: \(t)"); continue }
            b.tap()
            sleep(2)
            shot(String(format: "92-tool-%02d", n))
            dump(String(format: "92-tool-%02d", n))
            let run = btn(prefix: "Run ")
            for _ in 0..<5 where !run.exists { app.swipeUp() }
            if run.exists { note("tool \(t): run enabled with empty form = \(run.isEnabled)"); if n == 0 { shot("93-tool-run-visible") } }
            else { note("tool \(t): no Run button found") }
            back()
            sleep(1)
            app.swipeDown(); app.swipeDown(); app.swipeDown()
        }
    }

    // MARK: 10 Profile / Settings

    func test10_Settings() {
        start()
        go("Profile")
        sleep(2)
        shot("100-profile")
        dump("100-profile")
        openViaProfile("Settings")
        sleep(2)
        shot("101-settings")
        dump("101-settings")
        for i in 2...6 { app.swipeUp(); sleep(1); shot("10\(i)-settings-\(i)") }
        dump("106-settings-bottom")
        app.swipeDown(); app.swipeDown(); app.swipeDown(); app.swipeDown()
        let director = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] 'Director'")).firstMatch
        if director.exists { director.tap(); sleep(2); shot("107-director-picker"); dump("107-director-picker"); back(); sleep(1) } else { note("no director row in Settings") }
    }

    // MARK: 11 Server-driven config

    func test11_NoticeAndForcedUpdate() throws {
        try patchConfig(["reset": true])
        start()
        try patchConfig(["notice": ["id": UUID().uuidString, "title": "Maintenance tonight", "body": "The studio restarts at 22:00.", "level": "warning"]])
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        wait(app.staticTexts["Maintenance tonight"], 15, "server notice")
        sleep(1)
        shot("110-notice")
        try patchConfig(["minVersion": "99.0.0", "latestVersion": "99.0.0", "notice": NSNull()])
        XCUIDevice.shared.press(.home)
        sleep(2)
        app.activate()
        wait(app.staticTexts["Update required"], 15, "forced update screen")
        sleep(1)
        shot("111-forced-update")
        dump("111-forced-update")
        try patchConfig(["reset": true])
        let again = btn("Check Again")
        if again.exists { again.tap() }
        wait(app.staticTexts["FILM STUDIO"], 15, "Home after restore")
        shot("112-restored")
        // Web fallback for a tab
        try patchConfig(["tabs": ["library": ["kind": "web", "path": "/#library"]]])
        XCUIDevice.shared.press(.home); sleep(2); app.activate(); sleep(3)
        go("Library")
        sleep(6)
        shot("113-library-web-fallback")
        dump("113-web")
        try patchConfig(["reset": true])
    }

    // MARK: 12 Resilience

    /// Run with the tunnel down (the runner script stops it before this test).
    func test12_Offline() {
        app.launchArguments = ["-serverURL", server]
        app.launch()
        sleep(8)
        shot("120-offline-launch")
        dump("120-offline-launch")
        go("Library")
        sleep(3)
        shot("121-offline-library")
        let create = btn("Create")
        if create.exists { create.tap(); sleep(2); shot("122-offline-composer"); dump("122-offline-composer"); closeComposer() }
    }

    /// A bad access code / revoked session: the runner script sets FS_CODE wrong and clears the keychain first.
    func test13_Unauthorized() {
        app.launchArguments = ["-serverURL", server]
        app.launch()
        let field = app.secureTextFields["Access code"]
        if field.waitForExistence(timeout: 10) {
            field.tap(); field.typeText("wrong-code-123"); app.buttons["Sign In"].tap()
            sleep(3)
            shot("130-wrong-code")
            dump("130-wrong-code")
        } else { shot("130-no-signin-screen"); dump("130-no-signin") }
    }

    func test14_BackgroundMidJob() {
        start()
        btn("Create").tap()
        sleep(2)
        XCTAssertTrue(chooseFreeModel(video: true))
        typePrompt("A train crossing a bridge at dusk")
        guard generateGuarded(video: true) else { return }
        sleep(1)
        XCUIDevice.shared.press(.home)
        sleep(15)
        app.activate()
        sleep(3)
        shot("140-after-background")
        dump("140-after-background")
    }

    func test15_Rotation() {
        start()
        sleep(3)
        XCUIDevice.shared.orientation = .landscapeLeft
        sleep(3)
        shot("150-home-landscape")
        go("Library"); sleep(3); shot("151-library-landscape")
        btn("Create").tap(); sleep(2); shot("152-composer-landscape"); closeComposer()
        XCUIDevice.shared.orientation = .portrait
        sleep(2)
        shot("153-portrait-again")
    }

    func test16_DynamicTypeXXL() {
        app.launchArguments = ["-serverURL", server, "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXL"]
        app.launch()
        XCTAssertTrue(app.staticTexts["FILM STUDIO"].waitForExistence(timeout: 30))
        sleep(4)
        shot("160-xxl-home")
        app.swipeUp(); sleep(1); shot("161-xxl-home-2")
        btn("Create").tap(); sleep(2); shot("162-xxl-composer"); closeComposer()
        go("Library"); sleep(2); shot("163-xxl-library")
        go("Profile"); sleep(2); shot("164-xxl-profile")
    }

    func test17_ManyAutoplayTiles() {
        start()
        sleep(3)
        for i in 0..<30 { app.swipeUp(velocity: .fast); if i % 10 == 9 { shot("17\(i / 10)-memory-scroll") } }
        for _ in 0..<30 { app.swipeDown(velocity: .fast) }
        sleep(2)
        shot("174-memory-back-top")
        go("Library")
        for _ in 0..<10 { app.swipeUp(velocity: .fast) }
        sleep(2)
        shot("175-memory-library")
        XCTAssertEqual(app.state, .runningForeground, "app died during heavy scrolling")
    }


    /// Start frame from Photos: does the upload ever finish (thumbnail with START, Generate enabled)?
    func test18_StartFrameUpload() {
        start()
        btn("Create").tap()
        sleep(2)
        XCTAssertTrue(chooseFreeModel(video: true))
        typePrompt("Lantern light on wet cobblestones")
        let frames = btn(containing: "Start frame")
        guard wait(frames, 5, "Start frame chip") else { return }
        frames.tap()
        let s = btn(prefix: "Start frame")
        guard wait(s, 5, "Start frame… menu item") else { return }
        s.tap()
        sleep(3)
        let photo = app.scrollViews.images.firstMatch
        guard wait(photo, 10, "a photo in the picker") else { return }
        photo.tap()
        for t in [3, 10, 30, 60] {
            sleep(UInt32(t == 3 ? 3 : t - [3, 10, 30, 60][max(0, [3, 10, 30, 60].firstIndex(of: t)! - 1)]))
            shot("180-start-frame-after-\(t)s")
            let gen = btn(prefix: "Generate")
            note("after \(t)s: START thumb=\(btn("Remove start").exists) generate enabled=\(gen.exists && gen.isEnabled)")
        }
        dump("180-start-frame")
        if generateGuarded(video: true) {
            for _ in 0..<40 { sleep(2); if app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'GENERATING'")).count == 0 { break } }
            sleep(2)
            shot("181-start-frame-result")
            dump("181-start-frame-result")
        }
    }

    private func patchConfig(_ body: [String: Any]) throws {
        var r = URLRequest(url: URL(string: "\(server)/engine/api/app/config")!)
        r.httpMethod = "PATCH"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let code = env["FS_CODE"], !code.isEmpty { r.setValue("Bearer \(code)", forHTTPHeaderField: "Authorization") }
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
