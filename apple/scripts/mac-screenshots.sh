#!/bin/zsh
# Captures each main section of the Mac app (Debug build) via its -snapshotAfter hook — no screen-recording
# permission needed. Writes apple/screenshots/mac-<tab>.png.
#   apple/scripts/mac-screenshots.sh [server] [tabs...]
set -euo pipefail
cd "$(dirname "$0")/.."
SERVER=${1:-http://127.0.0.1:4961}
shift || true
TABS=(${@:-explore characters library films settings})
APP="build/dd-mac/Build/Products/Debug/Film Studio.app"
SNAP=~/Library/Containers/com.borgwardt.filmstudio/Data/Documents/snapshot.png
mkdir -p screenshots
for t in $TABS; do
  rm -f $SNAP
  open -W "$APP" --args -serverURL "$SERVER" -startTab "$t" -snapshotAfter 7
  if [ -f $SNAP ]; then cp $SNAP "screenshots/mac-$t.png"; echo "mac-$t.png"; else echo "no snapshot for $t"; fi
done
