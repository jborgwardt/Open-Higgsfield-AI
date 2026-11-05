// Renders the Film Studio app icon layers + flat fallbacks.
// Usage: swiftc -O scripts/render-app-icon.swift -o /tmp/render-icon && /tmp/render-icon <outdir>
// Then copy aperture.png/spark.png into FilmStudio/Resources/AppIcon.icon/Assets and icon-*.png into AppIcon.appiconset.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

// Film Studio icon: an aperture iris whose opening holds a spark of creation.
let S: CGFloat = 1024
let C = CGPoint(x: S/2, y: S/2)
let R: CGFloat = 318        // aperture outer radius
let r: CGFloat = 132        // hexagon opening radius
let gap: CGFloat = 20       // blade gap
let rot: CGFloat = -12 * .pi / 180
let sparkR: CGFloat = 168   // spark tip radius
let cs = CGColorSpace(name: CGColorSpace.displayP3)!

func ctx(_ w: Int) -> CGContext {
    let c = CGContext(data: nil, width: w, height: w, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    c.setShouldAntialias(true)
    // flip so y goes down like SVG
    c.translateBy(x: 0, y: CGFloat(w)); c.scaleBy(x: CGFloat(w)/S, y: -CGFloat(w)/S)
    return c
}
func save(_ c: CGContext, _ path: String) {
    let img = c.makeImage()!
    let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil); CGImageDestinationFinalize(d)
}
func col(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(colorSpace: cs, components: [CGFloat((hex>>16)&255)/255, CGFloat((hex>>8)&255)/255, CGFloat(hex&255)/255, a])!
}
func pt(_ rad: CGFloat, _ ang: CGFloat) -> CGPoint { CGPoint(x: C.x + rad*cos(ang), y: C.y + rad*sin(ang)) }
func hexV(_ i: Int) -> CGPoint { pt(r, rot + CGFloat(i) * .pi/3) }
// intersect ray from p in direction d with circle radius R
func hitCircle(_ p: CGPoint, _ d: CGPoint) -> CGPoint {
    let ox = p.x - C.x, oy = p.y - C.y
    let b = ox*d.x + oy*d.y, cc = ox*ox + oy*oy - R*R
    let t = -b + sqrt(b*b - cc)
    return CGPoint(x: p.x + t*d.x, y: p.y + t*d.y)
}
func norm(_ v: CGPoint) -> CGPoint { let l = hypot(v.x, v.y); return CGPoint(x: v.x/l, y: v.y/l) }

// Gap line i: through hex vertex i, along direction of edge (i-1 -> i), out to the rim.
func gapLine(_ i: Int) -> (CGPoint, CGPoint) {
    let a = hexV(i-1), b = hexV(i)
    let d = norm(CGPoint(x: b.x-a.x, y: b.y-a.y))
    return (a, hitCircle(b, d))
}
func aperturePath() -> CGPath {
    let p = CGMutablePath()
    p.addEllipse(in: CGRect(x: C.x-R, y: C.y-R, width: 2*R, height: 2*R))
    return p
}
func drawAperture(_ c: CGContext, flat: Bool) {
    c.saveGState()
    c.beginTransparencyLayer(auxiliaryInfo: nil)
    // blades as individual wedges so the flat version can shade them
    for i in 0..<6 {
        let blade = CGMutablePath()
        let (_, pi) = gapLine(i)
        let (_, pn) = gapLine(i+1)
        blade.move(to: hexV(i))
        blade.addLine(to: pn)
        let a0 = atan2(pn.y-C.y, pn.x-C.x), a1 = atan2(pi.y-C.y, pi.x-C.x)
        blade.addArc(center: C, radius: R, startAngle: a0, endAngle: a1, clockwise: true)
        blade.closeSubpath()
        c.saveGState()
        c.addPath(blade); c.clip()
        if flat {
            // alternate shading gives the iris a subtle turn
            let k = CGFloat(i % 2 == 0 ? 0 : 1)
            let top = col(0xFFFFFF, 1.0 - 0.06*k), bot = col(0xE9E2FF, 0.94 - 0.08*k)
            let g = CGGradient(colorsSpace: cs, colors: [top, bot] as CFArray, locations: [0, 1])!
            c.drawLinearGradient(g, start: CGPoint(x: C.x, y: C.y-R), end: CGPoint(x: C.x, y: C.y+R), options: [])
        } else {
            let g = CGGradient(colorsSpace: cs, colors: [col(0xFFFFFF), col(0xF1EDFF)] as CFArray, locations: [0, 1])!
            c.drawLinearGradient(g, start: CGPoint(x: C.x, y: C.y-R), end: CGPoint(x: C.x, y: C.y+R), options: [])
        }
        c.restoreGState()
    }
    // cut the gaps and the opening
    c.setBlendMode(.clear)
    c.setLineWidth(gap); c.setLineCap(.butt)
    for i in 0..<6 {
        let (a, b) = gapLine(i)
        c.move(to: a); c.addLine(to: b)
        // push slightly past the rim
        let d = norm(CGPoint(x: b.x-a.x, y: b.y-a.y))
        c.addLine(to: CGPoint(x: b.x + d.x*20, y: b.y + d.y*20))
        c.strokePath()
    }
    let hex = CGMutablePath()
    for i in 0..<6 { i == 0 ? hex.move(to: hexV(i)) : hex.addLine(to: hexV(i)) }
    hex.closeSubpath()
    c.addPath(hex); c.fillPath()
    // keep the opening's corners clean
    c.addPath(hex); c.setLineWidth(gap*0.5); c.setLineJoin(.round); c.strokePath()
    c.endTransparencyLayer()
    c.restoreGState()
}
func sparkPath(_ s: CGFloat, _ k: CGFloat = 0.5) -> CGPath {
    let p = CGMutablePath()
    let tips = [CGPoint(x: C.x, y: C.y-s), CGPoint(x: C.x+s*0.86, y: C.y), CGPoint(x: C.x, y: C.y+s), CGPoint(x: C.x-s*0.86, y: C.y)]
    p.move(to: tips[0])
    for i in 0..<4 {
        let a = tips[i], b = tips[(i+1)%4]
        let mx = (a.x + b.x)/2, my = (a.y + b.y)/2
        let ctrl = CGPoint(x: C.x + (mx-C.x)*k, y: C.y + (my-C.y)*k)
        p.addQuadCurve(to: b, control: ctrl)
    }
    p.closeSubpath()
    return p
}
func drawSpark(_ c: CGContext, flat: Bool) {
    c.saveGState()
    if flat {
        c.setShadow(offset: .zero, blur: 60, color: col(0xFFB347, 0.85))
    }
    c.addPath(sparkPath(sparkR)); c.clip()
    let g = CGGradient(colorsSpace: cs, colors: [col(0xFFFDF4), col(0xFFE08A), col(0xFFA53D)] as CFArray, locations: [0, 0.35, 1])!
    c.drawRadialGradient(g, startCenter: C, startRadius: 0, endCenter: C, endRadius: sparkR, options: [])
    c.restoreGState()
    if flat {
        // re-fill once more with glow underneath (clip kills shadow)
    }
}
func drawSparkGlowFlat(_ c: CGContext) {
    c.saveGState()
    c.setShadow(offset: .zero, blur: 56, color: col(0xFFB050, 0.75))
    c.addPath(sparkPath(sparkR)); c.setFillColor(col(0xFFE7A8)); c.fillPath()
    c.restoreGState()
}
func drawBackground(_ c: CGContext) {
    let g = CGGradient(colorsSpace: cs, colors: [col(0xFF7A3D), col(0xD9266E), col(0x5A1496), col(0x150A33)] as CFArray, locations: [0, 0.32, 0.68, 1])!
    c.drawLinearGradient(g, start: CGPoint(x: 120, y: -40), end: CGPoint(x: 900, y: 1080), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    // soft vignette
    let v = CGGradient(colorsSpace: cs, colors: [col(0x000000, 0), col(0x000000, 0.28)] as CFArray, locations: [0.55, 1])!
    c.drawRadialGradient(v, startCenter: C, startRadius: 0, endCenter: C, endRadius: 760, options: [])
}
func drawFlat(_ c: CGContext) {
    drawBackground(c)
    // aperture drop shadow
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: 18), blur: 40, color: col(0x12052E, 0.55))
    c.beginTransparencyLayer(auxiliaryInfo: nil); drawAperture(c, flat: true); c.endTransparencyLayer()
    c.restoreGState()
    drawSparkGlowFlat(c)
    drawSpark(c, flat: true)
}

let out = CommandLine.arguments[1]
// Layer PNGs for Icon Composer
do { let c = ctx(1024); drawAperture(c, flat: false); save(c, "\(out)/aperture.png") }
do { let c = ctx(1024); drawSpark(c, flat: false); save(c, "\(out)/spark.png") }
// Flat iOS (opaque full bleed)
do {
    let c = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8, bytesPerRow: 0, space: cs,
                      bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    c.translateBy(x: 0, y: 1024); c.scaleBy(x: 1, y: -1)
    drawFlat(c); save(c, "\(out)/icon-ios-1024.png")
}
// Mac: rounded-rect body inset per macOS grid (824 on 1024) with shadow
for w in [16, 32, 64, 128, 256, 512, 1024] {
    let c = ctx(w)
    let inset: CGFloat = 100, body = CGRect(x: inset, y: inset, width: S-2*inset, height: S-2*inset)
    let rr = CGPath(roundedRect: body, cornerWidth: 185, cornerHeight: 185, transform: nil)
    c.saveGState()
    c.setShadow(offset: CGSize(width: 0, height: 10), blur: 24, color: col(0x000000, 0.35))
    c.addPath(rr); c.setFillColor(col(0x150A33)); c.fillPath()
    c.restoreGState()
    c.saveGState(); c.addPath(rr); c.clip()
    c.translateBy(x: C.x, y: C.y); c.scaleBy(x: 824/S, y: 824/S); c.translateBy(x: -C.x, y: -C.y)
    drawFlat(c)
    c.restoreGState()
    save(c, "\(out)/icon-mac-\(w).png")
}
print("ok")
