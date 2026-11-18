#!/usr/bin/env bash
# Build the Windows portable package from this source tree.
# The Electron runtime (EDCL Lab System.exe, DLLs, locales) is NOT built from source here: it is taken from an existing
# portable package (BASE_ZIP) and only resources/app.asar (+ app.asar.unpacked) are replaced.  Base used so far:
#   EDCL-Lab-System-windows-portable-v1_0_9.zip  (supplied by the lab; keep it, it is the only copy of the runtime)
# Usage: BASE_ZIP=/path/to/EDCL-Lab-System-windows-portable-v1_0_9.zip bash tools/make-portable.sh
# Output: dist/EDCL-Lab-System-windows-portable-v<version>.zip and dist/SHA256SUMS.txt
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
: "${BASE_ZIP:?set BASE_ZIP to the base portable zip}"
VER="$(node -p "require('./package.json').version")"
WORK="$(mktemp -d)"; STAGE="$WORK/stage"; mkdir -p "$STAGE" "$ROOT/dist"
cp -r main.js preload.js backup-service.js wada-monitor.js sqlite-service.js package.json package-lock.json app build "$STAGE/"
( cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund )   # production deps only; --ignore-scripts: better-sqlite3 ships its prebuilt binaries, never compile
find "$STAGE/node_modules" -type d -empty -delete; rm -f "$STAGE/node_modules/.package-lock.json"   # npm leaves empty placeholder folders
test -f "$STAGE/node_modules/better-sqlite3/prebuilds/win32-x64.node" || { echo 'ERROR: win32-x64 prebuild missing from better-sqlite3'; exit 1; }
node "$ROOT/node_modules/@electron/asar/bin/asar.mjs" pack "$STAGE" "$WORK/app.asar" --unpack-dir "node_modules/better-sqlite3"   # needs: npm install (devDependency @electron/asar)
unzip -q "$BASE_ZIP" -d "$WORK/pkg"
RES="$WORK/pkg/win-unpacked/resources"; rm -rf "$RES/app.asar" "$RES/app.asar.unpacked"
cp "$WORK/app.asar" "$RES/app.asar"; cp -r "$WORK/app.asar.unpacked" "$RES/app.asar.unpacked"
test -f "$WORK/pkg/win-unpacked/EDCL Lab System.exe"
OUT="$ROOT/dist/EDCL-Lab-System-windows-portable-v${VER}.zip"; rm -f "$OUT"
cp -r "$ROOT/setup" "$WORK/pkg/setup"; cp "$ROOT/setup/SETUP.md" "$WORK/pkg/README_SETUP.md"   # setup scripts + guide at the package root
( cd "$WORK/pkg" && zip -qr -6 "$OUT" win-unpacked setup README_SETUP.md )
( cd "$ROOT/dist" && sha256sum "$(basename "$OUT")" > SHA256SUMS.txt && echo "app.asar sha256: $(sha256sum "$WORK/app.asar" | cut -d' ' -f1)" >> SHA256SUMS.txt )
echo "Built $OUT"; cat "$ROOT/dist/SHA256SUMS.txt"; rm -rf "$WORK"
