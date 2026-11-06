#if os(iOS)
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// System camera (photo or video). Returns JPEG data for a photo or a temp file URL for a video.
struct CameraCapture: UIViewControllerRepresentable {
    enum Result { case photo(Data), video(URL) }
    var onDone: (Result?) -> Void

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let c = UIImagePickerController()
        c.sourceType = .camera
        c.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        c.videoQuality = .typeHigh
        c.delegate = context.coordinator
        return c
    }
    func updateUIViewController(_ c: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onDone: (Result?) -> Void
        init(onDone: @escaping (Result?) -> Void) { self.onDone = onDone }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let url = info[.mediaURL] as? URL {
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent("camera-\(UUID().uuidString).\(url.pathExtension.isEmpty ? "mov" : url.pathExtension)")
                try? FileManager.default.copyItem(at: url, to: dest)
                onDone(.video(dest))
            } else if let img = info[.originalImage] as? UIImage, let data = img.jpegData(compressionQuality: 0.92) {
                onDone(.photo(data))
            } else { onDone(nil) }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { onDone(nil) }
    }
}
#endif
