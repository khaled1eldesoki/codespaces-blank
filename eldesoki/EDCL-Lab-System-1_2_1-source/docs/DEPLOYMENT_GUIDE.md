# EDCL Client-Server Deployment Guide (v1.2.1)

Two installers: **EDCL-Server-Setup.exe** (one PC) and **EDCL-Client-Setup.exe** (every workstation). Windows 10/11 x64, no internet needed.

## 0. Before you start
- Pick the server PC: fixed IP (reserve it in the router/DHCP), always on, UPS, a second disk or share for backups. Give it a DNS/hosts name (e.g. `edcl-server`).
- **Existing lab data** lives inside each PC's current app (browser storage). It is NOT moved automatically. Use section 4 before anyone starts working on the new system. Keep the old installation untouched until the migration is verified.

## 1. Server install (administrator on the server PC)
1. Run `EDCL-Server-Setup.exe`. Enter: server name(s), fixed IP(s), port (8443), database folder, backup folder (second disk/share), first administrator name.
2. It installs Node 22 + server, creates the lab certificate authority and server certificate, opens the firewall port for private/domain networks, registers the **EDCL Server** scheduled task (starts at boot as SYSTEM, auto-restarts) and starts it.
3. **Write down the one-time administrator password** shown in the installer details (`ownerPassword`). It is shown only once; it must be changed at first sign-in. Lost it? `edcl-server-ctl reset-password <user>`.
4. Open `C:\ProgramData\EDCL Server\client-config` — this folder (ca.crt, server.json, server-url.txt, README.txt with the certificate fingerprint) is what workstations need. **Never copy anything from `certs\` except through this folder** (`ca.key`/`server.key` stay on the server).
5. Silent form: `EDCL-Server-Setup.exe /S /NAME=edcl-server /IP=192.168.1.20 /PORT=8443 /DATA=D:\EDCL\data /BACKUP=E:\EDCL-backups /OWNER=admin`

## 2. Client install (each workstation)
1. Copy `EDCL-Client-Setup.exe` and the `client-config` folder side by side (USB/share) and run it as administrator. The address and certificate are filled in; **compare the fingerprint shown with README.txt** and confirm.
2. Silent: `EDCL-Client-Setup.exe /S /SERVER=https://edcl-server:8443 /CA=C:\temp\client-config\ca.crt`
3. Start "EDCL Lab System", sign in with the account created by the administrator (Users & Roles screen).
4. The server address can be changed later on the sign-in screen ("Server: … change") — no reinstall; the IP is never compiled into the app.

## 3. Updates without data loss
- Server: run the newer `EDCL-Server-Setup.exe` over the old one with the same data/backup folders. Program files are replaced; database, files, backups and certificates are not touched (a verified backup is still taken first by `edcl-server-ctl backup` — do it before every update).
- Client: run the newer `EDCL-Client-Setup.exe`. It never touches `%APPDATA%\EDCL Lab System` or the server connection settings. All laboratory data is on the server.
- Update the server first, then the workstations in the same day.

## 4. Migrating the existing data (one time, on the server PC)
1. On the PC that holds the current data, open the OLD app → Backup & Recovery → **Backup** (creates `EDCL_backup_YYYY-MM-DD.json`). Keep this file safe; do not delete the old app.
2. Copy it to the server PC. Stop the server (`edcl-server-ctl stop`).
3. `"C:\Program Files\EDCL Server\node.exe" --no-warnings "C:\Program Files\EDCL Server\server\cli.js" import EDCL_backup.json --config "C:\ProgramData\EDCL Server\server.json"` (the import only works into an EMPTY server database).
4. Start the server. Existing users are imported with their old passwords flagged "must change"; each user sets a new password (min. 10 characters) at first sign-in.
5. Files stored inside that backup (documents, evidence, signed forms) are imported with their original numbering (the output lists `files: imported/failed`; exit code 3 and a list if any file could not be read). Spot-check a few documents from a workstation.
6. Sign in from a workstation and compare employee/training/authorization counts with the old app before retiring it.

## 5. Daily operation
- Open **EDCL Server Dashboard** (desktop or Start menu). Sign in with a server account. **Overview** shows live health alerts (stale/failed backups, low disk space, certificate expiry, HTTP test mode, failed sign-ins, server errors), request/session/response-time/memory charts for the last hour, storage, backup, security and WADA panels. Refresh every 5/10/30 s or pause.
- **Connected users**: see who is signed in on which PC and sign them out. **Stored files**: browse documents/evidence, and run *Verify file integrity* (re-hashes every stored file; reports missing or damaged ones).
- **First-time setup**: on a server with no administrator the dashboard offers to create one (server PC only). **Forgot a password**: sign-in dialog, server PC, dashboard run as administrator.
- **Configuration** changes (backup interval/retention, WADA interval, upload limit, server name, backup folder) are applied immediately while the server is running. **Restart** works without Windows elevation; Start/Stop and Restore/Import (server must be stopped) and certificate renewal remain on the server PC.
- **Monitor from another PC**: run the dashboard there, choose *Server connection...* > *Another server*, enter `https://<server>:8443` and pick `ca.crt` from the server's `client-config` folder (compare the fingerprint with README.txt). Remote mode offers everything the server API allows (monitoring, users, sessions, files, backups, settings, logs, restart).
- Roles/permissions in the app's Users & Roles screen create accounts on the server. **Role permissions are enforced by the server with its built-in role table**; changing the permission matrix screen in the app does not change what the server allows (see Known limitations in the test report).
- Staff-role users receive only their own records plus reference data (server-side filtering).
