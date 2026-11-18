# Backup and recovery (central server)

**Automatic.** The server takes a consistent, integrity-checked SQLite backup every 30 minutes (and on demand) into the backup folder chosen at install (`edcl-YYYY…sqlite`, last 60 kept) and mirrors every uploaded document into `<backup folder>\files\` (immutable, content-addressed, copied once). Put the backup folder on a **second disk or a network share**; also copy it off-site weekly (USB/another PC). Access to data, backup and certificate folders is limited to SYSTEM/Administrators.

**From a workstation (Backup & Access DB tab, v1.2.1):** sign in as a user with the backup permission (the administrator), open the tab and confirm your password when asked (the server checks it). "Backup everything" makes a real backup ON THE SERVER (same file and folder as the automatic ones, with the documents mirrored) and then offers a copy (.json) to download to that PC. Restore and Reset stay disabled on workstations (use `edcl-server-ctl restore` on the server PC).

**Manual backup now:** `edcl-server-ctl backup` (prints file, record count, files mirrored).
**Check a backup:** `edcl-server-ctl verify "E:\EDCL-backups\edcl-….sqlite"` (integrity + counts).

**Restore (disaster or mistake)**
1. `edcl-server-ctl stop` (restore refuses to run on a live server).
2. `edcl-server-ctl restore "E:\EDCL-backups\edcl-….sqlite"` → verifies the backup, keeps the current database in `data\pre-restore-<time>\`, installs the backup, and restores any missing document bytes from the mirror. It reports files that could not be found (exit code 3).
3. `edcl-server-ctl start`. Workstations reconnect by themselves. Data entered after the backup time is lost — tell users which time was restored.
4. **New server PC:** run EDCL-Server-Setup.exe with the same name/IP, stop it, restore as above, copy back `certs\` (so clients need no change) — or issue new certs and re-distribute `client-config`.

**Rehearse** a restore on a spare PC every quarter. Workstation "Restore" and "Reset" buttons are disabled in server mode on purpose.

**What a backup does not contain:** certificates (back up `C:\ProgramData\EDCL Server\certs` offline), the old app's local data, per-PC WADA history (non-critical, rebuilt from the internet).
