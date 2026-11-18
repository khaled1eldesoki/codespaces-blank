# Upgrading an existing EDCL 1.0.x workstation to 1.2.1 (in place)

`EDCL-Client-Setup.exe` (v1.2.1) is an electron-builder NSIS installer with the SAME identity as the 1.0.x installer (appId `eg.edcl.labsystem`, uninstall key `348febd4-f5da-5197-bb0a-608d092f85c4`). It upgrades the installed app in place: one entry in Installed apps, same folder, same shortcuts, same uninstaller name.

## Before you start (once, for the lab)
1. Install the server (EDCL-Server-Setup.exe) and keep its `client-config` folder (server-url.txt, ca.crt, README.txt).
2. On the PC that holds the real laboratory data: open the OLD app > Backup & Recovery > Backup (EDCL_backup_YYYY-MM-DD.json). Import it ONCE on the server (see DEPLOYMENT_GUIDE section 4). Check counts. **Local 1.0.x data is NOT moved automatically; in server mode the app uses only the server database.**
3. Do not let several PCs each keep their own data: every workstation must be connected to the server (below).

## Upgrade a PC
Interactive: copy EDCL-Client-Setup.exe and the `client-config` folder side by side, run the installer, keep the install mode the PC already uses (current user or all users), confirm the certificate fingerprint against README.txt.
Silent: `EDCL-Client-Setup.exe /S /currentuser /SERVER=https://edcl-server:8443 /CA=C:\temp\client-config\ca.crt` (use `/allusers` for an all-users install, run as administrator).
Other switches: `/TRUSTWIN=1` (trust the lab CA in Windows, administrator only), `/STANDALONE=1` (leave this PC standalone - NOT recommended), `/D=<folder>`.
- A silent install on a PC with no server configuration and no /SERVER is REFUSED (exit code 3 is written to `%TEMP%\edcl-client-setup-error.log` for bad arguments; exit code 2 = no server configuration). This prevents accidental separate local databases.
- A PC that already has a server configuration is updated without any arguments and keeps its server address and CA.
- Support logs: `%TEMP%\edcl-client-setup-args.log`, `%TEMP%\edcl-client-setup-error.log`.

## What is preserved
- `%APPDATA%\EDCL Lab System` (the 1.0.x local data, settings, WADA history) is never modified. Before the first upgrade the installer also makes ONE safety copy: `%APPDATA%\EDCL Lab System-backup-before-1.2.1` (never overwritten).
- Server address / CA: `C:\ProgramData\EDCL Lab System\client\` (server.json, ca.crt) or `%APPDATA%\EDCL Lab System\central.json`. Updates and uninstall keep them.

## Rollback
Application: run the previous installer (the 1.0.4 `installer.exe`) on the PC; it installs over 1.2.1 in place (tested). Local data is untouched by both versions in server mode, so 1.0.x finds its data as it was. Data: if ever needed, copy `EDCL Lab System-backup-before-1.2.1` back over `EDCL Lab System` with the app closed. Server data: restore from a server backup (BACKUP_AND_RECOVERY.md). Keep the 1.0.4 installer.exe and the pre-upgrade JSON backup until the lab has signed off.

## Rollout order
Server first (with a verified backup), then one pilot PC, check sign-in, edits visible from a second PC and documents, then the remaining PCs the same day.
