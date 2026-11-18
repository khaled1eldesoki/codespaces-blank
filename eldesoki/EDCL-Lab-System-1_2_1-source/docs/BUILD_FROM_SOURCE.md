# Rebuilding the installers (Linux or WSL; needs node 22, npm, nsis/makensis, zip/unzip, internet once)
- `bash tools/build-client-eb.sh`  -> dist/EDCL-Client-Setup.exe   (electron-builder NSIS, appId eg.edcl.labsystem; config tools/eb-config.json, custom pages/switches installer/eb-client.nsh)
- `bash tools/build-server.sh`     -> dist/EDCL-Server-Setup.exe   (NSIS script installer/server-setup.nsi; bundles Node 22 + server + node-forge, offline)
- `bash tools/build-installers.sh` -> both, plus dist/SHA256SUMS.txt
Do not use installer/client-setup.nsi (superseded hand-written client; different identity, no in-place upgrade).
Server silent install: `EDCL-Server-Setup.exe /S /NAME=edcl-server /IP=192.168.1.20 /PORT=8443 /DATA=D:\EDCL\data /BACKUP=E:\EDCL-backups /OWNER=admin`
A silent install cannot display the one-time administrator password: afterwards run `edcl-server-ctl reset-password admin` and write down the password it prints (it must be changed at first sign-in). Errors of a silent install: `%TEMP%\edcl-server-setup-error.log` (exit code 3).
