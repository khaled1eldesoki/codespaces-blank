#!/usr/bin/env bash
# Builds EDCL-Client-Setup.exe with electron-builder (NSIS, appId eg.edcl.labsystem = in-place upgrade of 1.0.x). Linux build, no Windows/Wine needed.
# Needs: node 22, npm, internet (electron-builder downloads its NSIS tools once; Electron 35.7.5 zip cached in .cache/).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
VER="$(node -p "require('./package.json').version")"; DIST="$ROOT/dist"; W="$(mktemp -d)"; mkdir -p "$DIST" "$ROOT/.cache"
ELECTRON_ZIP="${ELECTRON_ZIP:-$ROOT/.cache/electron-v35.7.5-win32-x64.zip}"
[ -f "$ELECTRON_ZIP" ] || curl -fsSL -o "$ELECTRON_ZIP" https://github.com/electron/electron/releases/download/v35.7.5/electron-v35.7.5-win32-x64.zip
APP="$W/app"; mkdir -p "$APP/server" "$APP/build"
cp -r main.js preload.js backup-service.js wada-monitor.js sqlite-service.js ai-gateway.js addons-main app "$APP/"
cp server/certs-verify.js "$APP/server/"
cp build/icon.ico build/icon.png "$APP/build/" 2>/dev/null || cp build/icon.ico "$APP/build/"
cp installer/eb-client.nsh "$APP/build/installer.nsh"
node -e "const p=require('./package.json');require('fs').writeFileSync('$APP/package.json',JSON.stringify({name:p.name,productName:p.productName,version:p.version,description:p.description,author:p.author||'Egyptian Doping Control Laboratory',main:'main.js',dependencies:p.dependencies||{}},null,1))"
cp package-lock.json "$APP/" 2>/dev/null || true
( cd "$APP" && npm install --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && rm -f package-lock.json && find node_modules -type d -empty -delete )
( cd "$APP/node_modules/better-sqlite3/prebuilds" && ls | grep -v '^win32-x64.node$' | xargs -r rm -f ); test -f "$APP/node_modules/better-sqlite3/prebuilds/win32-x64.node"
EB="${EB_DIR:-$ROOT/.cache/eb}"; if [ ! -x "$EB/node_modules/.bin/electron-builder" ]; then mkdir -p "$EB"; ( cd "$EB" && npm init -y >/dev/null && npm i electron-builder@24.13.3 --no-audit --no-fund >/dev/null ); fi
mkdir -p "$W/electron-dist" && unzip -q "$ELECTRON_ZIP" -d "$W/electron-dist"
node -e "const c=require('./tools/eb-config.json');c.electronDist='$W/electron-dist';require('fs').writeFileSync('$W/eb.json',JSON.stringify(c))"
( cd "$APP" && CSC_IDENTITY_AUTO_DISCOVERY=false "$EB/node_modules/.bin/electron-builder" --win nsis --x64 --config "$W/eb.json" --publish never )
cp "$APP/dist-eb/EDCL-Client-Setup.exe" "$DIST/EDCL-Client-Setup.exe"
( cd "$DIST" && sha256sum EDCL-Client-Setup.exe | tee SHA256SUMS-client.txt )
rm -rf "$W"
