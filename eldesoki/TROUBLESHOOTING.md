# Troubleshooting (v1.2.1)

Server commands (run in an administrator command prompt on the server PC): `edcl-server-ctl status | logs | stop | start | restart | backup | verify <file> | restore <file> | reset-password <user> | renew-certs <ip-or-name>`.

| Symptom | Likely cause | What to do |
|---|---|---|
| Sign-in says "Cannot reach the EDCL server" | Server stopped, wrong address, firewall, no network | On the server: `edcl-server-ctl status`; `start` if stopped. On the PC: open `https://<server>:8443/api/info` in a browser (needs "Also trust in Windows" or ignore the warning only for this test). Check the address under "Server: change" on the sign-in screen. Confirm TCP 8443 is allowed (private/domain profile). |
| Certificate refused / "other CA" | The PC has the wrong or an old `ca.crt`, or the server name/IP is not in the certificate | Compare the CA fingerprint with `client-config\README.txt`. Name or IP changed: on the server `edcl-server-ctl renew-certs <new>` then `restart`. CA replaced: reinstall the client with the new `client-config` or pick the new `ca.crt` under "Server: change". |
| Lost the one-time administrator password | Shown only once at install | `edcl-server-ctl reset-password <user>` |
| Badge shows "Server unreachable" | Network or server outage | Keep the app open: edits are kept and re-sent automatically. Do NOT close the app while unreachable (unsent edits are lost on close). |
| "Some changes were NOT saved" dialog | Someone edited the same field at the same moment | The other person's value was kept. Review and choose "keep mine" if needed. Conflicts are in the server audit log. |
| Two records with the same number (e.g. two TR0643) | Two PCs created a record at the same moment (numbering is max+1 per PC) | Renumber one manually. No data is lost. |
| Windows SmartScreen warning | Installers are unsigned | Sign with the lab code-signing certificate, or choose "More info > Run anyway" after checking SHA256SUMS.txt. |
| Server does not start after reboot | Scheduled task "EDCL Server" missing/disabled, disk or folder missing | Task Scheduler: check "EDCL Server" (runs as SYSTEM, at boot). `edcl-server-ctl logs`. Check the data and backup drives are present. |
| Restore button disabled on a workstation | By design in server mode | Restore on the server PC only (see BACKUP_AND_RECOVERY.md). |
| WADA monitor shows failed check | No internet / DNS | Expected on an isolated LAN. The app works normally; the check resumes when the PC has internet. |
| WADA Fix screen misbehaves | Its bridge was previously never loaded (preload defect fixed in 1.2.1), so this code path is new in production | Report it; the add-on can be disabled by removing its script tag line from `app\index.html` inside the asar source and rebuilding. |
| Story section shows missing pictures | Two London photographs were not delivered in a usable form | Supply `london_visit_dec2025_2.jpg` and `_3.jpg` to `app\edcl-story\images\` in the source and rebuild. |
| Backup tab asks for a password and always says "Incorrect password" (v1.2.0 / early 1.2.1 builds) | The protected-tab password check compared against a local password hash that does not exist in server mode | Fixed in the current 1.2.1: the server now checks the password (`/api/reauth`, same lockout rules as sign-in; 5 failures sign the user out, repeated failures lock the account for a while). Update the server FIRST, then the workstations. |
| Backup button does nothing / only a .json appears | Old behaviour: it exported a local file only | Current 1.2.1 creates a backup on the server first, then offers the .json copy. The user needs the backup permission (administrator by default). |
