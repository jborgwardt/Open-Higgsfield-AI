#!/bin/zsh
# Installs Film Studio's OTA files into ~/OTA (next to the existing apps; nothing of theirs is changed
# except one added card on the portal page ~/OTA/dist/index.html, inserted once).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OTA=~/OTA
cp "$HERE/ExportOptions-FilmStudio.plist" $OTA/ExportOptions-FilmStudio.plist
cp "$HERE/rebuild-film-studio.sh" $OTA/rebuild-film-studio.sh && chmod +x $OTA/rebuild-film-studio.sh
cp "$HERE/film-studio.html" $OTA/dist/film-studio.html
if ! grep -q 'film-studio.html' $OTA/dist/index.html; then
  python3 - "$OTA/dist/index.html" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
card = '''<div class="card">
  <h1>Film Studio</h1>
  <p>Native iPhone, iPad &amp; Mac app for films.heil.haus</p>
  <p><a class="btn" href="/film-studio.html">Install Film Studio</a></p>
</div>
'''
s = s.replace('<body>\n', '<body>\n' + card, 1)
open(p, 'w').write(s)
PY
fi
echo "Installed Film Studio OTA files into $OTA"
