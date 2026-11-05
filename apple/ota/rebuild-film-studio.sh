#!/bin/zsh
# Rebuild Film Studio (iPhone/iPad + Mac) and publish to ~/OTA/dist:
#   https://ota.heil.haus:8443/film-studio.html  (iOS install link + Mac download)
# Installed as ~/OTA/rebuild-film-studio.sh by apple/ota/install.sh.
# Source: ~/Developer/Open-Higgsfield-AI/apple (override with FILMSTUDIO_SRC=/path/to/apple).
# Builds from the working tree as-is; never touches git.
# If run over SSH and codesign fails with errSecInternalComponent: security unlock-keychain ~/Library/Keychains/login.keychain-db
set -euo pipefail
OTA=~/OTA
SRC=${FILMSTUDIO_SRC:-$HOME/Developer/Open-Higgsfield-AI/apple}
B=$OTA/build/filmstudio
cd "$SRC"
xcodegen -q
rm -rf $B && mkdir -p $B

# iOS / iPadOS → development-signed IPA + OTA manifest
xcodebuild archive -project FilmStudio.xcodeproj -scheme FilmStudio -configuration Release \
  -destination 'generic/platform=iOS' -archivePath $B/FilmStudio.xcarchive \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=F2M8XJL997 > $B/ios-archive.log 2>&1 \
  || { tail -40 $B/ios-archive.log; exit 1; }
xcodebuild -exportArchive -archivePath $B/FilmStudio.xcarchive \
  -exportOptionsPlist $OTA/ExportOptions-FilmStudio.plist -exportPath $B/export-ios \
  -allowProvisioningUpdates > $B/ios-export.log 2>&1 \
  || { tail -40 $B/ios-export.log; exit 1; }
IPA=$(ls $B/export-ios/*.ipa | head -1)
cp "$IPA" $OTA/dist/FilmStudio.ipa.tmp && mv $OTA/dist/FilmStudio.ipa.tmp $OTA/dist/FilmStudio.ipa
cp $B/export-ios/manifest.plist $OTA/dist/film-studio-manifest.plist
ICON=FilmStudio/Resources/Assets.xcassets/AppIcon.appiconset/icon-ios-1024.png
sips -s format png -z 57 57 "$ICON" --out $OTA/dist/film-studio-icon57.png >/dev/null
sips -s format png -z 512 512 "$ICON" --out $OTA/dist/film-studio-icon512.png >/dev/null

# macOS → Apple Development-signed app, zipped
xcodebuild archive -project FilmStudio.xcodeproj -scheme FilmStudioMac -configuration Release \
  -destination 'generic/platform=macOS' -archivePath $B/FilmStudioMac.xcarchive \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=F2M8XJL997 > $B/mac-archive.log 2>&1 \
  || { tail -40 $B/mac-archive.log; exit 1; }
APP="$B/FilmStudioMac.xcarchive/Products/Applications/Film Studio.app"
codesign --verify --deep --strict "$APP"
rm -f $OTA/dist/FilmStudio-mac.zip.tmp
ditto -c -k --sequesterRsrc --keepParent "$APP" $OTA/dist/FilmStudio-mac.zip.tmp && mv $OTA/dist/FilmStudio-mac.zip.tmp $OTA/dist/FilmStudio-mac.zip

V=$(/usr/libexec/PlistBuddy -c 'Print :items:0:metadata:bundle-version' $OTA/dist/film-studio-manifest.plist)
echo "Built Film Studio $V -> https://ota.heil.haus:8443/film-studio.html (iOS) + FilmStudio-mac.zip (Mac)"
