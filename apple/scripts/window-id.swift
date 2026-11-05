// Prints the CGWindowID of the frontmost on-screen window owned by a process name (for `screencapture -l`).
//   swift apple/scripts/window-id.swift "Film Studio"
import CoreGraphics
import Foundation

let owner = CommandLine.arguments.dropFirst().first ?? "Film Studio"
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
let match = list.first { ($0[kCGWindowOwnerName as String] as? String) == owner && ($0[kCGWindowLayer as String] as? Int) == 0 }
if let id = match?[kCGWindowNumber as String] as? Int { print(id) } else { exit(1) }
