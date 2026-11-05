#!/bin/zsh
# Runs the UI walkthrough (FilmStudioUITests) on a simulator against a running local engine and saves
# screenshots to apple/screenshots/<prefix>-*.png.
#   apple/scripts/ui-screenshots.sh <simulator-udid> <prefix> [server] [test]
# Start the engine first (free, offline `local` provider), e.g.:
#   ENGINE_PORT=4961 ENGINE_DATA=$(mktemp -d) LLM_BASE_URL=http://127.0.0.1:9/v1 node engine/server.js
set -euo pipefail
cd "$(dirname "$0")/.."
SIM=$1
PREFIX=$2
SERVER=${3:-http://127.0.0.1:4961}
ONLY=${4:-}
mkdir -p screenshots
[ -d FilmStudio.xcodeproj ] || xcodegen -q
export TEST_RUNNER_FS_SERVER=$SERVER TEST_RUNNER_FS_SHOTS=$PWD/screenshots TEST_RUNNER_FS_PREFIX=$PREFIX
xcrun simctl status_bar "$SIM" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularBars 4 --wifiBars 3 2>/dev/null || true
# [test] may be a comma-separated list, e.g. test1_CreateAndLibrary,test2_FilmsCharactersSettings
FILTERS=()
for t in ${(s:,:)ONLY}; do FILTERS+=(-only-testing:FilmStudioUITests/FilmStudioUITests/$t); done
xcodebuild test -project FilmStudio.xcodeproj -scheme FilmStudio -destination "id=$SIM" -derivedDataPath build/dd -collect-test-diagnostics never \
  "${FILTERS[@]}" 2>&1 | grep -E "Test Case|error:|passed|failed|TEST (SUCCEEDED|FAILED)" || true
ls screenshots | grep "^$PREFIX-" || true
