#!/bin/zsh
# Regenerates the app icon set in FilmStudio/Resources/Assets.xcassets from scripts/make-icon.swift.
set -euo pipefail
cd "$(dirname "$0")/.."
SET=FilmStudio/Resources/Assets.xcassets/AppIcon.appiconset
TMP=$(mktemp -d)
swift scripts/make-icon.swift "$TMP" >/dev/null
mkdir -p "$SET"
cp "$TMP/icon-ios-1024.png" "$SET/icon-ios-1024.png"
for s in 16 32 64 128 256 512 1024; do
  sips -s format png -z $s $s "$TMP/icon-mac-1024.png" --out "$SET/icon-mac-$s.png" >/dev/null
done
cat > "$SET/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon-ios-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" },
    { "filename" : "icon-mac-16.png", "idiom" : "mac", "scale" : "1x", "size" : "16x16" },
    { "filename" : "icon-mac-32.png", "idiom" : "mac", "scale" : "2x", "size" : "16x16" },
    { "filename" : "icon-mac-32.png", "idiom" : "mac", "scale" : "1x", "size" : "32x32" },
    { "filename" : "icon-mac-64.png", "idiom" : "mac", "scale" : "2x", "size" : "32x32" },
    { "filename" : "icon-mac-128.png", "idiom" : "mac", "scale" : "1x", "size" : "128x128" },
    { "filename" : "icon-mac-256.png", "idiom" : "mac", "scale" : "2x", "size" : "128x128" },
    { "filename" : "icon-mac-256.png", "idiom" : "mac", "scale" : "1x", "size" : "256x256" },
    { "filename" : "icon-mac-512.png", "idiom" : "mac", "scale" : "2x", "size" : "256x256" },
    { "filename" : "icon-mac-512.png", "idiom" : "mac", "scale" : "1x", "size" : "512x512" },
    { "filename" : "icon-mac-1024.png", "idiom" : "mac", "scale" : "2x", "size" : "512x512" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON
cp "$TMP/icon-ios-1024.png" FilmStudio/Resources/Assets.xcassets/BrandMark.imageset/brand.png 2>/dev/null || true
rm -rf "$TMP"
echo "icons → $SET"
