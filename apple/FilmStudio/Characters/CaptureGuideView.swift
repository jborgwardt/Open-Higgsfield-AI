import SwiftUI
import PhotosUI
import FilmStudioKit

/// Step-by-step reference capture: one angle at a time, with the server's checklist and tips.
struct CaptureGuideView: View {
    let character: StudioCharacter
    let coverage: Coverage?
    let onChange: () async -> Void
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var done: Set<String> = []
    @State private var busy: String?
    @State private var error: String?
    @State private var picks: [String: PhotosPickerItem] = [:]
    @State private var video: PhotosPickerItem?
    @State private var cameraStep: AppConfig.CaptureStep?

    private var capture: AppConfig.Capture { app.config.capture }

    var body: some View {
        NavigationStack {
            ScreenGate(id: "capture", params: ["id": character.id], title: capture.title) {
                List {
                    Section {
                        Text(capture.intro).font(.callout)
                        ForEach(capture.tips, id: \.self) { tip in
                            Label(tip, systemImage: "checkmark.seal").font(.subheadline)
                        }
                    } header: { Text("Before you start") }

                    Section {
                        ForEach(capture.checklist) { step in stepRow(step) }
                    } header: {
                        Text("Angles · \(capture.checklist.filter(isDone).count)/\(capture.checklist.count)")
                    }

                    if app.config.isOn("videoRefImport") {
                        Section {
                            PhotosPicker(selection: $video, matching: .videos) {
                                Label("Import a \(Int(capture.videoMinSeconds))–\(Int(capture.videoMaxSeconds)) s head-turn video", systemImage: "video.badge.plus")
                            }
                        } header: { Text("Or use a video") } footer: { Text(capture.videoInstruction) }
                    }

                    if let error { Section { Text(error).foregroundStyle(.red) } }
                }
            }
            .navigationTitle(character.name)
            .inlineTitle()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
                if let busy {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 6) { ProgressView().controlSize(.small); Text(busy).font(.caption) }
                    }
                }
            }
            .onChange(of: video) { _, item in
                guard let item else { return }
                video = nil
                Task { await add(item: item, angle: nil) }
            }
            #if os(iOS)
            .fullScreenCover(item: $cameraStep) { step in
                CameraCaptureView(step: step, zoom: capture.cameraZoom) { data in
                    Task { await add(data: data, angle: step.id) }
                }
            }
            #endif
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 680)
        #endif
    }

    private func isDone(_ s: AppConfig.CaptureStep) -> Bool {
        done.contains(s.id) || (coverage?.has(s.id) ?? false) || character.refs.contains { $0.angle == s.id }
    }

    private func stepRow(_ step: AppConfig.CaptureStep) -> some View {
        let ok = isDone(step)
        return HStack(spacing: 12) {
            Image(systemName: step.sfSymbol)
                .font(.title3).frame(width: 36, height: 36)
                .background((ok ? Color.green : Color.accentColor).opacity(0.15), in: Circle())
                .foregroundStyle(ok ? .green : Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(step.title).font(.subheadline.weight(.semibold))
                Text(step.instruction).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            if ok { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green).accessibilityLabel("Done") }
            #if os(iOS)
            if app.config.isOn("cameraCapture"), CameraController.isAvailable {
                Button { cameraStep = step } label: { Image(systemName: "camera.fill") }
                    .buttonStyle(.glass).accessibilityLabel("Take \(step.title) photo")
            }
            #endif
            PhotosPicker(selection: Binding(get: { picks[step.id] }, set: { item in
                guard let item else { return }
                Task { await add(item: item, angle: step.id) }
            }), matching: .images) { Image(systemName: "photo.on.rectangle") }
                .buttonStyle(.glass)
                .accessibilityLabel("Choose \(step.title) photo")
        }
        .disabled(busy != nil)
    }

    private func add(item: PhotosPickerItem, angle: String?) async {
        busy = "Uploading…"
        do {
            let asset = try await MediaUpload.upload(item, app: app)
            try await attach(asset.id, angle: angle)
        } catch { fail(error) }
        busy = nil
    }

    private func add(data: Data, angle: String) async {
        busy = "Uploading…"
        do {
            let asset = try await MediaUpload.image(data, name: "\(angle).jpg", app: app)
            try await attach(asset.id, angle: angle)
        } catch { fail(error) }
        busy = nil
    }

    private func attach(_ assetId: String, angle: String?) async throws {
        busy = "Checking quality…"
        try await app.client.addCharacterRefs(character.id, assetIds: [assetId], angle: angle)
        if let angle { done.insert(angle) }
        Platform.haptic()
        await onChange()
    }

    private func fail(_ e: Error) {
        error = e.localizedDescription
        app.report(e, screen: "capture", action: "Add reference")
    }
}
