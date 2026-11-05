#if os(iOS)
import SwiftUI
import AVFoundation
import FilmStudioKit

/// Back camera at the server-configured zoom (default 2×) with a framing guide for one capture step.
nonisolated final class CameraController: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "filmstudio.camera")
    private var continuation: CheckedContinuation<Data, Error>?

    static var isAvailable: Bool { AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil }

    func start(zoom: Double) async throws {
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            throw NSError(domain: "FilmStudio", code: 2, userInfo: [NSLocalizedDescriptionKey: "Allow camera access in Settings → Film Studio."])
        }
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            queue.async {
                do {
                    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) else { throw NSError(domain: "FilmStudio", code: 3, userInfo: [NSLocalizedDescriptionKey: "No back camera."]) }
                    self.session.beginConfiguration()
                    self.session.sessionPreset = .photo
                    let input = try AVCaptureDeviceInput(device: device)
                    if self.session.canAddInput(input) { self.session.addInput(input) }
                    if self.session.canAddOutput(self.output) { self.session.addOutput(self.output) }
                    self.output.maxPhotoQualityPrioritization = .quality
                    self.session.commitConfiguration()
                    try device.lockForConfiguration()
                    device.videoZoomFactor = min(max(1, zoom), device.maxAvailableVideoZoomFactor)
                    if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
                    device.unlockForConfiguration()
                    self.session.startRunning()
                    c.resume()
                } catch { c.resume(throwing: error) }
            }
        }
    }

    func stop() { queue.async { self.session.stopRunning() } }

    func capture() async throws -> Data {
        try await withCheckedThrowingContinuation { c in
            queue.async {
                self.continuation = c
                let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
                settings.photoQualityPrioritization = .quality
                self.output.capturePhoto(with: settings, delegate: self)
            }
        }
    }

    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        if let error { continuation?.resume(throwing: error) }
        else if let data = photo.fileDataRepresentation() { continuation?.resume(returning: data) }
        else { continuation?.resume(throwing: NSError(domain: "FilmStudio", code: 4, userInfo: [NSLocalizedDescriptionKey: "The photo couldn't be read."])) }
        continuation = nil
    }
}

private struct PreviewLayerView: UIViewRepresentable {
    let session: AVCaptureSession
    final class V: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
    func makeUIView(context: Context) -> V {
        let v = V()
        v.preview.session = session
        v.preview.videoGravity = .resizeAspectFill
        return v
    }
    func updateUIView(_ v: V, context: Context) {}
}

struct CameraCaptureView: View {
    let step: AppConfig.CaptureStep
    let zoom: Double
    let onUse: (Data) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var camera = CameraController()
    @State private var shot: Data?
    @State private var error: String?
    @State private var capturing = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let shot, let img = UIImage(data: shot) {
                Image(uiImage: img).resizable().scaledToFit()
            } else {
                PreviewLayerView(session: camera.session).ignoresSafeArea()
                guide
            }
            VStack {
                VStack(spacing: 4) {
                    Text(step.title).font(.headline)
                    Text(step.instruction).font(.subheadline).multilineTextAlignment(.center)
                    Text("\(zoom.formatted())× · back camera · 1.5–2 m").font(.caption).foregroundStyle(.white.opacity(0.7))
                }
                .padding(12)
                .foregroundStyle(.white)
                .studioGlass(RoundedRectangle(cornerRadius: 18, style: .continuous), tint: .black.opacity(0.35))
                .padding(.top, 12)
                if let error { Text(error).font(.callout).foregroundStyle(.white).padding(10).background(.red.opacity(0.8), in: Capsule()) }
                Spacer()
                controls.padding(.bottom, 28)
            }
            .padding(.horizontal)
        }
        .task {
            do { try await camera.start(zoom: zoom) } catch { self.error = error.localizedDescription }
        }
        .onDisappear { camera.stop() }
        .statusBarHidden()
    }

    private var guide: some View {
        GeometryReader { g in
            let full = step.id == "fullBody"
            let w = g.size.width * (full ? 0.42 : 0.6)
            let h = full ? g.size.height * 0.78 : w * 1.3
            RoundedRectangle(cornerRadius: full ? 40 : w / 2, style: .continuous)
                .strokeBorder(.white.opacity(0.75), style: StrokeStyle(lineWidth: 2, dash: [8, 6]))
                .frame(width: w, height: h)
                .position(x: g.size.width / 2, y: g.size.height / 2)
        }
        .allowsHitTesting(false)
    }

    private var controls: some View {
        HStack {
            Button(shot == nil ? "Cancel" : "Retake") {
                if shot == nil { dismiss() } else { shot = nil }
            }
            .buttonStyle(.glass)
            .frame(width: 110)
            Spacer()
            if shot == nil {
                Button {
                    capturing = true
                    Task {
                        do { shot = try await camera.capture() } catch { self.error = error.localizedDescription }
                        capturing = false
                    }
                } label: {
                    Circle().strokeBorder(.white, lineWidth: 4).frame(width: 74, height: 74)
                        .overlay(Circle().fill(.white).padding(8).opacity(capturing ? 0.5 : 1))
                }
                .disabled(capturing || error != nil)
                .accessibilityLabel("Take photo")
            }
            Spacer()
            Button("Use Photo") {
                if let shot { onUse(shot) }
                dismiss()
            }
            .fontWeight(.semibold)
            .buttonStyle(.glassProminent)
            .frame(width: 110)
            .opacity(shot == nil ? 0 : 1)
            .disabled(shot == nil)
        }
    }
}
#endif
