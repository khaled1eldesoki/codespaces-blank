# EDCL central LAN server (checkpoint 3) - setup, design, limits
**Status: server core built and tested on Linux only (13/13 automated tests). The desktop app does NOT use it yet (next checkpoint). Not tested on Windows, not tested on a real LAN.**

## Purpose
100+ employees on many devices, individual accounts and permissions, ONE central database, no lost or overwritten changes.

## Design
- One Node process + one SQLite file (`edcl-central.sqlite`, WAL, synchronous=FULL). All writes are serialised by the server, so two users can never corrupt each other's data.
- Records: every row of every table (Employees, Training, ...) is a record `{tbl, id, rev, data}`. Ids come from the existing key fields (composite keys joined with `|`, e.g. `M1|E2`); rows without a key get `Table#000001`.
- **Safe writes (no lost updates):** every save states the revision it was edited from (`baseRev`). `baseRev` is mandatory - blind overwrites are refused.
  - same revision -> saved as rev+1.
  - older revision -> three-way field merge against the stored base version. Different fields -> merged automatically. Same field changed differently -> **conflict returned with the server copy; nothing is overwritten**.
  - delete/restore/create-duplicate also conflict instead of silently winning.
- Every revision is kept (`versions` table) + audit log: who, what, when. Rollback of a record is possible from history (UI not built yet).
- Sync: `GET /api/sync?since=<seq>` (paged), `POST /api/push` (batches of up to 200), live notifications `GET /api/events` (server-sent events).
- Accounts: one per person, scrypt-salted passwords (the old unsalted SHA-256 hashes are accepted once at first sign-in and replaced), forced password change, lockout after 5 failures (5 min), session tokens (only their hash stored), 30 min idle / 12 h maximum, disabled users are signed out at once, last administrator cannot be removed.
- Permissions (same roles as the desktop app): writing needs `edit` (Evaluation also `assess`, Settings `users`); users without edit/audit/assess/users see only rows whose `StaffID` is their own, plus reference data. Enforced **on the server**.
- Backups: verified `VACUUM INTO` copies (integrity_check + record count), automatic every 30 min and at shutdown, newest 30 kept, manual `POST /api/admin/backup`.

## Server PC setup (Windows)
1. Install **Node.js 22 LTS** (22.13 or newer) on the server PC. Copy the `server` folder (+ `package.json`) there.
2. First time: `node server\cli.js init-owner <your-username> --data D:\EDCL-Server-Data` -> prints a random one-time password (change it at first sign-in).
3. Migrate existing data ONCE: `node server\import-backup.js D:\EDCL-Server-Data <JSON backup file>` (refuses a non-empty database; take and verify a backup of the real data folder first).
4. HTTPS (recommended, required before real use - without it passwords cross the network readable): create a certificate for the server name, then `node server\cli.js start --data D:\EDCL-Server-Data --port 8443 --tls-key key.pem --tls-cert cert.pem`.
5. Windows Firewall: allow inbound TCP 8443 on the private network only. Use a fixed IP or DNS name. Run as a service (e.g. NSSM / Task Scheduler) so it restarts after a reboot.
6. Keep `D:\EDCL-Server-Data\backups` copied to a second disk/PC.

## Known limits / not done yet
- **Desktop app still local-only.** Screens, attachments (photos, PDFs, forms files) and WADA monitor data are not yet moved to the server.
- Merge is per top-level field (not inside arrays/nested objects): two people changing the same array/field get a conflict, never a silent overwrite.
- Plain HTTP unless TLS files are given. No 2-step verification on the server yet (the desktop TOTP is local).
- Not load-tested beyond 100 concurrent editors on one Linux machine; no Windows run; `node:sqlite` fallback is "experimental" in Node 22 (better-sqlite3 preferred when installed).
- Offline editing (work without the server, sync later) is NOT part of this checkpoint.

## Phone viewer (read-only) - added after checkpoint3
- Open `https://<server-ip>:8443/m/` on a phone on the same network. Sign in with a normal account (same permissions as on the PC; staff only see their own records).
- Tabs: Dashboard, Employees, Authorizations, Alerts. The page only reads (`/api/sync`); it contains no code that calls `/api/push`.
- WADA updates: the SERVER checks the public WADA news page every 6 h (`--wada-hours N`, `0` = off) and stores new items; phones show them in Alerts. Needs internet on the server PC. Sources (all public wada-ama.org pages): news; Technical Documents Index; Technical Letters Index (`/en/resources/technical-letters-index`, taken from the TD page's own Related resources); the Prohibited List page; and NEXT year's list page `/en/resources/<year+1>-prohibited-list` (WADA publishes the new List there in September, while the normal Prohibited List page keeps showing the old list until 1 January - a missing page just means 'not published yet'). The old-version archive is not listed as updates. Items found on the first check are marked baseline (shown, never NEW). The Dashboard shows the latest 5, when the last check ran, and any source WADA blocked (challenge page).
- Notifications are shown while the page is open/installed. Background push with the page closed is NOT built.
- The phone must trust `cert.pem`: Android - Settings > Security > Install a certificate (CA certificate); iPhone - open cert.pem, install the profile, then Settings > General > About > Certificate Trust Settings. Status: written and server-side tested; never run on a real phone.
- IMPORTANT: the desktop app does not yet sync to this server, so the server database is empty until you load the desktop data once: `node server\import-backup.js <data-dir> <backup.json>` (stop the server first). Until then the phone shows no employees/authorizations.
