#if DEBUG && os(macOS)
import AppKit

/// Debug builds only: `-snapshotAfter 6` renders the main window to
/// ~/Library/Containers/com.borgwardt.filmstudio/Data/Documents/snapshot.png and quits.
/// Lets scripts capture Mac screenshots without screen-recording permission.
enum DebugSnapshot {
    static func scheduleIfRequested() {
        let delay = UserDefaults.standard.double(forKey: "snapshotAfter")
        guard delay > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
            guard let window = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil && $0.frame.width > 400 }),
                  let view = window.contentView?.superview ?? window.contentView,
                  let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { NSApp.terminate(nil); return }
            view.cacheDisplay(in: view.bounds, to: rep)
            let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("snapshot.png")
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
            NSApp.terminate(nil)
        }
    }
}
#endif
