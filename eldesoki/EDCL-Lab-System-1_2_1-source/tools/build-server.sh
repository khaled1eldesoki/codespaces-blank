#!/usr/bin/env bash
# Builds EDCL-Server-Setup.exe on Linux (NSIS cross-compile). Needs: node 22, npm, nsis (makensis), zip/unzip, internet for the two downloads (cached).
#   ELECTRON_ZIP=<electron-v35.7.5-win32-x64.zip>  NODE_WIN=<node.exe 22.x>   (both are downloaded if not given)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
VER="$(node -p "require('./package.json').version")"; DIST="$ROOT/dist"; W="$(mktemp -d)"; mkdir -p "$DIST" "$ROOT/.cache"
ELECTRON_ZIP="${ELECTRON_ZIP:-$ROOT/.cache/electron-v35.7.5-win32-x64.zip}"
NODE_WIN="${NODE_WIN:-$ROOT/.cache/node.exe}"
if [ ! -f "$NODE_WIN" ]; then ( cd "$W" && npm pack node-win-x64@22.23.4 --silent >/dev/null && tar xzf node-win-x64-22.23.4.tgz && cp package/bin/node.exe "$NODE_WIN" ); fi
if [ ! -f "$ELECTRON_ZIP" ]; then curl -fsSL -o "$ELECTRON_ZIP" https://github.com/electron/electron/releases/download/v35.7.5/electron-v35.7.5-win32-x64.zip; fi
# ---------- server ----------
SV="$W/server"; mkdir -p "$SV/server" "$SV/node_modules"
cp server/*.js "$SV/server/"; cp -r server/mobile "$SV/server/mobile"; rm -f "$SV/server/certs-verify.js.bak"
cp wada-monitor.js package.json "$SV/"; cp installer/run-server.cmd installer/edcl-server-ctl.cmd "$SV/"
cp "$NODE_WIN" "$SV/node.exe"
( cd "$W" && mkdir -p forge && cd forge && npm init -y >/dev/null && npm install node-forge@1.4.3 --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && cp -r node_modules/node-forge "$SV/node_modules/node-forge" )
mkdir -p "$SV/dashboard" "$SV/dashboard-app"
unzip -q "$ELECTRON_ZIP" -d "$SV/dashboard"
mv "$SV/dashboard/electron.exe" "$SV/dashboard/EDCL Server Dashboard.exe"
cp -r server-dashboard/. "$SV/dashboard-app/"
cp build/icon.ico "$SV/dashboard-app/icon.ico"
printf 'Node.js (MIT licence, https://github.com/nodejs/node/blob/main/LICENSE) is bundled unmodified as node.exe (v22.23.4).\r\nnode-forge: BSD-3-Clause or GPL-2.0 (BSD-3-Clause chosen).\r\n' > "$SV/LICENSE-node.txt"
makensis -V2 -DVERSION="$VER" -DSTAGE="$SV" -DICON="$ROOT/build/icon.ico" -DOUTFILE="$DIST/EDCL-Server-Setup.exe" installer/server-setup.nsi
( cd "$DIST" && sha256sum EDCL-Server-Setup.exe | tee SHA256SUMS-server.txt )
rm -rf "$DIST/server-staging"; cp -r "$SV" "$DIST/server-staging"; rm -rf "$W"
