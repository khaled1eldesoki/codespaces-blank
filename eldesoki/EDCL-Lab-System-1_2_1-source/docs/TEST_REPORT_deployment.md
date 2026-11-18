> **Superseded by TEST_REPORT_v1.2.1.md.** The 1.2.0 installers described below omitted the production add-ons, training files and story module and must not be used.

# Multi-client test report — EDCL v1.2.0 client–server build

Date of run: 2026-11-14/16. Test data only (the app's built-in seed data and synthetic users/files). No real laboratory record was read or written.
Runtimes used are the shipped ones: **Electron 35.7.5** (Chromium 134) and **Node 22.23.4** (same as the bundled `node.exe`), on Linux with a virtual display.

## A. What was tested and passed (automated, repeatable: `npm run test:server`, `npm run test:e2e`)
| # | Area | Result |
|---|---|---|
| 1 | Server API suite (existing, unchanged) — auth, sync, merge, conflicts, permissions, SSE, backup | 13/13 |
| 2 | Private-CA HTTPS: trusted client OK, **any other CA refused**; certificate valid for hostname *and* IP (cross-checked with OpenSSL) | 2 tests |
| 3 | Central file store: hash-verified upload, corrupt upload refused, identical download, per-person evidence privacy, replace/soft-delete audited | 3 tests |
| 4 | Backup: integrity-checked, documents mirrored; **restore** returns data *and* file bytes (also after the file folder was deleted); damaged backup refused, current DB untouched | 2 tests |
| 5 | Migration import of a desktop backup incl. attached files with original ids | 1 test |
| 6 | Sync engine against the real server with the app's real seed data: identical tables/order on a second PC; different fields of one record both kept; same field → conflict, other value kept, "keep mine" propagates, audited; deletes vs edits; spread-replaced rows recognised; permission objects merge | 9 tests (incl. **25 simulated PCs × 12 rounds of random edits: all PCs identical to server, zero lost writes**) |
| 7 | **Real app, two workstations** (two Electron processes, separate data folders) → HTTPS server: UI sign-in with legacy→scrypt password upgrade and forced change, data load, screens open without script errors, edit on A visible on B (and vice-versa, both fields kept), file uploaded on A downloaded bit-identical on B, **server stopped while A edits → "Server unreachable" → server back → edit delivered and visible on B** | 22/22 (also 22/22 on the code extracted from the built `app.asar`) |
| 8 | WADA monitor unit suite (unchanged): failures reported honestly, retry, resume | 29/29 |
| 9 | Forms engine suite | 6/6 |
The e2e found and I fixed four real defects before delivery (stale-overwrite of another PC's edit after a pull, every first load re-sending ~1,700 records, request-format mismatch between page and main process, no automatic retry after an outage).

## B. NOT verified — you must run these on site
1. **The two `.exe` installers were compiled (NSIS) but never executed on Windows.** Install on a dedicated test PC first. Unverified: wizard pages, scheduled task at boot, firewall rule, `icacls`, shortcuts, uninstall, silent switches, behaviour under antivirus.
2. **Unsigned** installers/exes: Windows SmartScreen will warn. Sign with the lab's code-signing certificate if available.
3. **Real separate computers / real LAN** (DNS name, DHCP, switch, firewall profile, Wi-Fi roaming), the server surviving a real reboot, and clock differences. The "two workstations" above are two real app instances on one machine.
4. **Real internet/WADA site** (resume after reconnect on the live site). Only the monitor's own tests and the offline path were exercised; the app does not fail when the internet is absent.
5. **Existing features beyond what was opened:** `test:ui` and `test:persistence` **already crash on the 1.1.0 source before my changes** (they look for the old profile card `#cprb`, replaced by the redesigned Employee Profile). So I could not use them as proof that Competency, Training Records, Forms, Quality, Documents, AI Assistant behave as before. In server mode the e2e only opened Employees, Documents, Training, Authorization, Backup and Users screens without script errors. A hands-on pass of every module is required; nothing was removed or disabled except Restore/Reset-from-workstation (by design in server mode).
6. **Runtime / version.** Your upload contained only part of the runtime (folders `resources`, `locales`, `setup` arrived empty; no `app.asar`), so the 1.0.15 asar could not be inspected. Your `EDCL_Lab_System.exe` is Electron 35.7.5 but not byte-identical to the official one (probably icon/resource edits). The installer therefore uses the **official Electron 35.7.5 win32-x64 runtime** and an `app.asar` built from the 1.2.0 source (`dist/SHA256SUMS.txt`). Exe properties still show "Electron".
7. **"Historical storytelling section".** `patch-asar.js` adds `edcl-story.js` from a `story-files` folder. Neither is in the checkpoint3f source, so **that feature is not in these installers**. Send `story-files` and it will be merged in the source (do not patch the new asar).
8. Concurrent **creation** of two records by two PCs can yield two rows with the same business number (e.g. two `TR0643`) because the app numbers by "max+1" on each PC; no data is lost, but renumber manually if it happens.

## C. Known limitations
- Role-permission matrix screen is not enforced by the server (server uses built-in roles); account create/reset/role/enable are enforced.
- Optional 2-step verification remains client-side (secret in the synced user record), as before.
- Staff-role users get only their own records plus reference data.
- Workstations need the server for work; short outages are bridged (edits kept and re-sent while the app stays open); closing the app with an unreachable server loses unsent edits.
- The WADA monitor runs per workstation; the server-side feed runs only if the server PC has internet.
- Equal-position inserts by two PCs sort deterministically but arbitrarily.
