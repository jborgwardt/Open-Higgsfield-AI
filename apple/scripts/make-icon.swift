// Renders the Film Studio app icon (no external assets):
//   swift apple/scripts/make-icon.swift <out-dir>
// Writes icon-ios-1024.png (full bleed, iOS masks it) and icon-mac-1024.png (macOS rounded tile with margin).
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let outDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
let S: CGFloat = 1024
let space = CGColorSpace(name: CGColorSpace.displayP3)!

func color(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: space, components: [CGFloat((hex >> 16) & 0xff) / 255, CGFloat((hex >> 8) & 0xff) / 255, CGFloat(hex & 0xff) / 255, a])!
}

func drawArt(_ ctx: CGContext, in rect: CGRect) {
    let s = rect.width / S
    ctx.saveGState()
    ctx.translateBy(x: rect.minX, y: rect.minY)
    ctx.scaleBy(x: s, y: s)

    // Background: deep violet → near black, with warm and cool glows.
    let bg = CGGradient(colorsSpace: space, colors: [color(0x2B1458), color(0x120A26), color(0x06060B)] as CFArray, locations: [0, 0.55, 1])!
    ctx.drawLinearGradient(bg, start: CGPoint(x: 200, y: S), end: CGPoint(x: 820, y: 0), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    let warm = CGGradient(colorsSpace: space, colors: [color(0xFF6A3D, 0.55), color(0xFF6A3D, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(warm, startCenter: CGPoint(x: 760, y: 700), startRadius: 0, endCenter: CGPoint(x: 760, y: 700), endRadius: 520, options: [])
    let cool = CGGradient(colorsSpace: space, colors: [color(0x2EC5FF, 0.35), color(0x2EC5FF, 0)] as CFArray, locations: [0, 1])!
    ctx.drawRadialGradient(cool, startCenter: CGPoint(x: 180, y: 220), startRadius: 0, endCenter: CGPoint(x: 180, y: 220), endRadius: 460, options: [])

    // Film frame with sprocket holes, slightly tilted.
    ctx.saveGState()
    ctx.translateBy(x: S / 2, y: S / 2 - 10)
    ctx.rotate(by: -0.07)
    let frame = CGRect(x: -330, y: -250, width: 660, height: 500)
    ctx.setShadow(offset: CGSize(width: 0, height: -24), blur: 60, color: color(0x000000, 0.55))
    ctx.addPath(CGPath(roundedRect: frame, cornerWidth: 64, cornerHeight: 64, transform: nil))
    ctx.setFillColor(color(0x0D0C14))
    ctx.fillPath()
    ctx.setShadow(offset: .zero, blur: 0, color: nil)
    // Sprockets
    ctx.setFillColor(color(0xF4EFFA, 0.82))
    for row in [frame.maxY - 58, frame.minY + 26] {
        for i in 0..<7 {
            let x = frame.minX + 52 + CGFloat(i) * 88
            ctx.addPath(CGPath(roundedRect: CGRect(x: x, y: row, width: 46, height: 32), cornerWidth: 9, cornerHeight: 9, transform: nil))
        }
    }
    ctx.fillPath()
    // Picture window: sunset gradient.
    let window = CGRect(x: frame.minX + 40, y: frame.minY + 82, width: frame.width - 80, height: frame.height - 164)
    ctx.saveGState()
    ctx.addPath(CGPath(roundedRect: window, cornerWidth: 26, cornerHeight: 26, transform: nil))
    ctx.clip()
    let pic = CGGradient(colorsSpace: space, colors: [color(0xFFB347), color(0xFF5E62), color(0xB0459F), color(0x4B2C9B)] as CFArray, locations: [0, 0.35, 0.7, 1])!
    ctx.drawLinearGradient(pic, start: CGPoint(x: window.midX, y: window.maxY), end: CGPoint(x: window.midX, y: window.minY), options: [])
    // Horizon hills
    ctx.setFillColor(color(0x1C1236, 0.85))
    ctx.move(to: CGPoint(x: window.minX, y: window.minY + 70))
    ctx.addCurve(to: CGPoint(x: window.maxX, y: window.minY + 95), control1: CGPoint(x: window.minX + 180, y: window.minY + 150), control2: CGPoint(x: window.maxX - 220, y: window.minY + 20))
    ctx.addLine(to: CGPoint(x: window.maxX, y: window.minY))
    ctx.addLine(to: CGPoint(x: window.minX, y: window.minY))
    ctx.fillPath()
    ctx.restoreGState()
    // Play triangle
    ctx.setShadow(offset: CGSize(width: 0, height: -6), blur: 24, color: color(0x000000, 0.35))
    ctx.setFillColor(color(0xFFFFFF, 0.96))
    let tri = CGMutablePath()
    tri.move(to: CGPoint(x: -58, y: -80))
    tri.addLine(to: CGPoint(x: 92, y: 0))
    tri.addLine(to: CGPoint(x: -58, y: 80))
    tri.closeSubpath()
    ctx.addPath(tri)
    ctx.fillPath()
    ctx.restoreGState()

    // Sparkle (the "AI" in the studio), top right.
    func sparkle(_ c: CGPoint, _ r: CGFloat, _ alpha: CGFloat) {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: c.x, y: c.y + r))
        p.addQuadCurve(to: CGPoint(x: c.x + r, y: c.y), control: CGPoint(x: c.x + r * 0.16, y: c.y + r * 0.16))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y - r), control: CGPoint(x: c.x + r * 0.16, y: c.y - r * 0.16))
        p.addQuadCurve(to: CGPoint(x: c.x - r, y: c.y), control: CGPoint(x: c.x - r * 0.16, y: c.y - r * 0.16))
        p.addQuadCurve(to: CGPoint(x: c.x, y: c.y + r), control: CGPoint(x: c.x - r * 0.16, y: c.y + r * 0.16))
        ctx.setShadow(offset: .zero, blur: 40, color: color(0xFFE2B0, 0.9))
        ctx.setFillColor(color(0xFFF8EC, alpha))
        ctx.addPath(p)
        ctx.fillPath()
    }
    sparkle(CGPoint(x: 806, y: 810), 112, 1)
    sparkle(CGPoint(x: 905, y: 655), 46, 0.9)
    ctx.restoreGState()
}

func render(_ size: Int, mac: Bool) -> CGImage {
    let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: (mac ? CGImageAlphaInfo.premultipliedLast : CGImageAlphaInfo.noneSkipLast).rawValue)!
    let full = CGRect(x: 0, y: 0, width: size, height: size)
    if mac {
        // macOS tile: 824/1024 body with a soft drop shadow (Apple's icon grid).
        let inset = CGFloat(size) * 100 / 1024
        let body = full.insetBy(dx: inset, dy: inset).offsetBy(dx: 0, dy: CGFloat(size) * 6 / 1024)
        let path = CGPath(roundedRect: body, cornerWidth: body.width * 0.225, cornerHeight: body.width * 0.225, transform: nil)
        ctx.setShadow(offset: CGSize(width: 0, height: -CGFloat(size) * 10 / 1024), blur: CGFloat(size) * 28 / 1024, color: color(0x000000, 0.45))
        ctx.addPath(path); ctx.setFillColor(color(0x06060B)); ctx.fillPath()
        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.addPath(path); ctx.clip()
        drawArt(ctx, in: body)
    } else {
        drawArt(ctx, in: full)
    }
    return ctx.makeImage()!
}

func write(_ img: CGImage, _ name: String) {
    let url = outDir.appendingPathComponent(name)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
    print("wrote \(url.path)")
}

try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
write(render(1024, mac: false), "icon-ios-1024.png")
write(render(1024, mac: true), "icon-mac-1024.png")
