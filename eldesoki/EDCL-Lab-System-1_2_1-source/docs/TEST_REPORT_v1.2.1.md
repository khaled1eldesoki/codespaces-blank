# Test report v1.2.1 (merged production app + central server) - run 2026-11-16/17, Linux, Electron 35.7.5, Node 22.23.4
Base = lab's production app.asar (1.0.15 + add-ons) with the 1.2.0 client-server layer ported on top. Synthetic test data only.

| Area | Result |
|---|---|
| Server suite `npm run test:server` (auth, sync, merge, conflicts, files, backup/restore, import, HTTPS, 25-PC stress) | 31/31 |
| `npm run test:e2e`: two real app instances -> HTTPS server (login, edit visibility, file transfer, outage + recovery) | 22/22 (also on code extracted from the built app.asar) |
| `tests/electron/parity.js`: bridges (edclAI, edclWF, central), add-on/story/training files served, story section on Dashboard, 39 screens without script errors, no console errors | 20/20 (also on the built asar) |

## Not verified - must be done on site
1. Both .exe installers have been compiled (NSIS) but never executed on Windows (wizard, scheduled task, firewall, icacls, shortcuts, uninstall, silent switches, antivirus). Unsigned.
2. Real LAN, real reboot, clock differences, Wi-Fi.
3. Manual pass of every module (Competency, Training Records, Forms, Quality, Documents, AI Assistant, WADA Fix, WADA Links). The automated screen loop only proves screens open without script errors; navigating to the Dashboard by URL hash did not render in the harness (cause not found) while a direct call did.
4. Migration of the REAL data backup: test on a copy and compare counts.
5. Existing suites test:ui and test:persistence were not run (they crash on the 1.1.0 source already).

## Changes against the production app (read before deploying)
- preload.js: second `edclAI` exposure wrapped in try/catch; this lets the WADA Fix bridge (`edclWF`) load for the first time.
- The production app's own renderer sync (edcl_net / "Connect to a central server") is replaced by the 1.2.0 CA-pinned sync.
- Two-step verification is no longer blocked in server mode (secret stored in the synced user record).
- wada-monitor.js kept as in production (contains encoding damage in two dash patterns; behaviour unchanged).
- Story images: london_visit_dec2025_2.jpg truncated, london_visit_dec2025_3.jpg missing in the supplied zip.
- Known limitations unchanged from the 1.2.0 report (role matrix not enforced by server, unsent edits lost if the app is closed while the server is unreachable, WADA monitor per workstation, same-number concurrent creation).

# Client installer: electron-builder in-place upgrade test (run 2026-11-17, Wine 9.0 on Linux, REAL 1.0.4 installer.exe from the lab)
Baseline: the lab's own 1.0.4 installer.exe installed silently (per-user, HKCU, key 348febd4-..., %LOCALAPPDATA%\Programs\EDCL Lab System). Sentinel files placed in %APPDATA%\EDCL Lab System (hashed).

| Step | Result |
|---|---|
| Silent upgrade without server config and without /STANDALONE | refused, exit 2, 1.0.4 untouched (x2) |
| Silent upgrade 1.0.4 -> 1.2.1 with /SERVER /CA | exit 0; ONE uninstall entry, same GUID, DisplayVersion 1.2.1; same folder; shortcuts recreated; server.json + ca.crt written (ca identical); user data byte-identical; safety copy identical |
| Update 1.2.1 over 1.2.1, no arguments | exit 0, config kept, data identical |
| Rollback: real 1.0.4 installer over 1.2.1 | exit 0, version 1.0.4, one entry, data identical, server config kept |
| Upgrade again 1.0.4 -> 1.2.1, no arguments | exit 0, safety copy unchanged |
Defects found and fixed during this test: (1) NSIS ${GetOptions} cuts values at "//", so /SERVER=https://... arrived as "https:" - replaced by an own parser; (2) validation errors showed a dialog in silent mode and blocked the installer - silent mode now writes %TEMP%\edcl-client-setup-error.log and exits with a code.

## Still NOT verified (Wine cannot do it) - do on real Windows
1. Silent UNINSTALL: under Wine neither the lab's own 1.0.4 uninstaller nor the new one removed anything (control run), so uninstall (keeps data + server config by design) is untested.
2. All-users (per-machine, elevated) install/upgrade, interactive wizard pages, certificate fingerprint prompt (PowerShell), "trust in Windows".
3. Running the installed app on Windows; the server installer; real LAN. The exe icon/version properties of EDCL Lab System.exe are not edited (default Electron icon).
4. Wine used SHA/ordinary files only; antivirus/SmartScreen behaviour untested; installers unsigned.

# Server installer test (2026-11-17, Wine 9.0 + the bundled Windows node.exe 22)
| Step | Result |
|---|---|
| Silent install with /NAME /IP /PORT /DATA=C:\EDCL\data /BACKUP=C:\EDCL\backups /OWNER | exit 0; Program Files\EDCL Server (node.exe, server, node_modules), ProgramData\EDCL Server (server.json, certs, client-config), database created in the chosen data folder |
| Defect found and fixed | the first run IGNORED /DATA and /BACKUP (backslashes lost by ${GetOptions}: data went to Program Files, backup path "C:EDCLbackups"); own parser added; silent failures no longer open a dialog (log + exit 3) |
| Server start with the installed node.exe | listens on 0.0.0.0:8443 HTTPS, /api/health and /api/info answer version 1.2.1 |
| Certificate | trusted with the generated ca.crt for BOTH name edcl-server and IP 192.168.1.20; a different CA is refused |
| Auth | one-time owner password (edcl-server-ctl reset-password) signs in with mustChange=true; wrong password refused; /api/sync without token = 401 |
| Backup | `cli.js backup` wrote a consistent .sqlite (records counted) into the chosen backup folder |
Not verifiable under Wine (do on a real Windows server PC): scheduled task "EDCL Server" at boot as SYSTEM, firewall rule, icacls restrictions, shortcuts, run-server.cmd restart loop (uses PowerShell), reboot survival, uninstall, antivirus. The installer is unsigned.

# Backup tab / password prompt fix (2026-11-18)
Cause: the production Security module protects some tabs (including Backup) with a "Confirm your password" prompt that compared the typed password with U.hash from the LOCAL user record. In server mode passwords/hashes are never stored in shared records, so every password was refused (5 failures = forced sign-out). Fix: new server endpoint POST /api/reauth (scrypt verify, same lockout as login, audited, no new session); the prompt calls it in server mode. The Backup button now calls POST /api/admin/backup (server-side verified backup + documents mirror) and then offers the .json copy.
Verified in the REAL app against a real HTTPS server (tests/electron/backup-repro.js): protected tab shows the prompt, a wrong password is refused, the correct password opens the tab, "Backup everything" saved edcl-....sqlite on the server (1827 records, 41 documents mirrored) and downloaded a 42 MB .json (18 employees, 86 files). Server suite 33/33 (2 new reauth/backup tests), e2e 22/22, parity 20/20. Rebuilt client upgrades 1.0.4 -> 1.2.1 under Wine; rebuilt server installed clean under Wine: first-run password change, /api/reauth ok/refused, /api/admin/backup wrote a file to the chosen backup folder.
Note for operators: the two training add-ons (training-import.js, trq-register.js) import 6 packages/34 files and 28 training records/51 files automatically right after the first sign-in on an empty server database and then jump to Training Records; if several PCs sign in at the same moment on an EMPTY server, check for duplicate training records.
