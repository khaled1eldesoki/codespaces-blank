#!/usr/bin/env bash
# v1.2.1: the CLIENT is built with electron-builder (same identity as the 1.0.x installer => in-place upgrade); the SERVER with NSIS.
# (installer/client-setup.nsi is the superseded hand-written client installer, kept for reference only - it has a different identity and must not be used for upgrades.)
set -euo pipefail
cd "$(dirname "$0")/.."
bash tools/build-client-eb.sh
bash tools/build-server.sh
( cd dist && sha256sum EDCL-Client-Setup.exe EDCL-Server-Setup.exe > SHA256SUMS.txt && cat SHA256SUMS.txt )
