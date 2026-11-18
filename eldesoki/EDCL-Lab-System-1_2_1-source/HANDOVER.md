# HANDOVER - EDCL Lab System (checkpoint 3, app 1.1.0 + central server core)
Updated 2026-11-03. **Read this block first; sections below were written at checkpoint 2 (1.0.15) and are still accurate unless this block says otherwise.**

## Checkpoint 3 status (LAN multi-user requirement)
**Requirement (System Owner):** 100+ employees at once, many devices, internal network, individual accounts + permissions, one central database, safe synchronisation without losing or overwriting changes. Owner confirmed a verified backup of the real data exists, a Windows PC will host the server, and said: continue from the current project, do not rebuild.
| Item | State |
|---|---|
| Built | `server/` (db.js, store.js, auth.js, server.js, import-backup.js, cli.js) + `docs/LAN_SERVER.md` + `tests/server/central.test.js`. |
| Tested (Linux, Node 22.22, node:sqlite) | 13/13: auth/lockout/forced change, legacy-hash upgrade, blind-overwrite refusal, 100 concurrent editors same record (disjoint fields merged; same field one winner per revision, 0 lost), 120 accounts x 5 rounds x 30 records 0 lost updates, permissions incl. server-side row filtering, admin rules, paged-sync convergence, SSE, verified backup + restart, migration import, HTTPS (self-signed). |
| NOT done | Desktop app does not use the server yet (still IndexedDB per PC). Attachments/files, WADA monitor data, forms files not on the server. Offline mode. Server-side 2-step verification. Conflict-resolution screens. Windows run of the server. Real LAN test. Load beyond 100 editors. Existing 4 suites not re-run (devDependencies not installable offline here). |
| Windows build | Unchanged from 1.1.0 (the owner's `EDCL-Lab-System-windows-portable-v1_1_0.zip`). It does **not** include the server and is **not verified on real Windows**. No new build was produced. |
| Git | Tag `checkpoint-3` (see `git rev-parse checkpoint-3`), tag `checkpoint-3`. Note: this commit also swept in the 1.1.0 changes that were uncommitted in the working tree when this session began (CHANGELOG 1.1.0 describes them); they were not reviewed by this session. |
| Next actions | 1) Client data layer: replace `kv`/`save()` (app/index.html lines ~442-467, 866) with a sync client (pull cursor, per-record push with baseRev, conflict dialog, SSE refresh); keep a read-only local cache. 2) Move accounts/login to the server (remove local hash check, hard-coded first-run credentials). 3) Attachments store on the server (hash-addressed, permission-checked). 4) Screens review (every screen that changes users/permissions/forms/settings/backup/restore). 5) Windows test on a TEST server PC + 3-5 client PCs with a COPY of data. |
| Standing rules | No change before a verified backup of the real data folder; never replace the current database with an older copy; new verified backup before any migration or destructive change; before stopping deliver source ZIP, latest Windows build with its true verification status, this HANDOVER and a continuation prompt; never label an untested build as verified. |

# (previous) HANDOVER - checkpoint 2, version 1.0.15
Updated 2026-10-25 by the AI assistant that built versions 1.0.10-1.0.15. Everything needed to continue is in this archive; nothing depends on the assistant's account, chat history or temporary files. **Production readiness: NOT VERIFIED on real Windows hardware.** Keep this file updated at every stopping point (section 10).

## 0. Status at a glance
| Item | State |
|---|---|
| Version / build | App **1.0.15**. Build id = SHA-256 of `app.asar`: `5d1f01df6fea469d80f6533750973b419681b8459222c400e6cc456ee3c4dcc4` (rebuilds from the tagged source gave identical hashes so far). Package = the lab's Electron 35.7.5 runtime + this asar + `setup/`. |
| Automated tests (Linux) | monitor 29/29, UI+competency+WADA screens 51/51, persistence+backup/restore 28/28, forms engine (shipped bundle) 6/6; real-app forms test on the PACKAGED asar under Electron 35.7.5: 28/28; independent PDF verification: all checks pass. Details: `docs/TEST_RESULTS_checkpoint2.txt`. |
| Windows acceptance tests | **None run.** Setup scripts never executed on Windows. |
| Last completed task | PDF fillable-forms feature (v1.0.15) + Windows setup scripts + packaging + handover update. |
| Next action | Run Windows acceptance W0 on a TEST PC with a COPY of data; then decisions D1-D3 for Word forms (section 2). |
| Safe fall-back builds | The lab's own v1.0.9 package (runtime base - keep it). Checkpoint-1 (1.0.14) package and project archive remain in `outputs/checkpoint-1/`. Builds 1.0.10-1.0.13 were not retained. |

## 1. Purpose, architecture, directory structure
**Purpose:** offline Windows desktop application for the Egyptian Doping Control Laboratory (EDCL): personnel competency and authorization, training, quality records, document control, backups, WADA update monitoring, fillable PDF forms.
**Runtime:** Electron **35.7.5 / Chrome 134** (taken from the lab's portable package, not built here). Renderer = one large file `app/index.html` (+ lazily loaded `app/forms.js`). Main process `main.js`; preload bridge `preload.js` exposes `window.edclDesktop`.
| Path | Role |
|---|---|
| `main.js`, `preload.js` | window, secure `app://` protocol, IPC (backup, wada, sqlite, print, `forms:saveFile`), fixed data folder, close handshake, IPC sender check. |
| `backup-service.js` | `.sqlite` and Access backups (PowerShell/ADOX), Access reading, auto-backup prune (15). |
| `wada-monitor.js` | WADA monitor: 4 official sources, parsers, change grading, retry, SQLite store (user_version 2), scheduler, verification. |
| `sqlite-service.js` | user SQLite import/export bridge. |
| `app/index.html` | UI + data logic. `app/vendor/pdf*.js` = pdf.js 3.11.174. `app/fonts/` = Outfit, **Noto Sans, Noto Naskh Arabic** (forms). |
| `app/forms.js` | Fillable Forms UI/data: template import, instances, editor, OCR, save revisions, print/export, employee-profile card. |
| `app/forms-engine.src.mjs` | PDF engine source (pdf-lib + fontkit + bidi-js): fills fields, draws text boxes, mixed Arabic/English, never modifies the master bytes. **Built bundle `app/vendor/edcl-forms-engine.js` is committed; rebuild with `npm run build:vendor` after editing the source (the bundle is minified - never rely on class names).** |
| `app/vendor/tesseract/` | Tesseract.js 7 + 3 LSTM wasm cores + `lang/eng|ara.traineddata.gz` (~4.5 MB data, ~12 MB cores). |
| `setup/` | `Install-EDCL.cmd`, `install.ps1`, `uninstall.ps1`, `SETUP.md` (never run on Windows). |
| `tools/` | `make-portable.sh` (build), `build-vendor.sh`, `backup-userdata.ps1` (untested). |
| `tests/` | 4 npm suites + `fixtures/` (WADA page fixtures, bidi samples) + `electron/` (integration scripts, see its README). |
| `testkit/` | real test forms (fillable, static 3-page, scanned PDFs, DOCX), experiments, Windows checklist. |
| `docs/` | `FORMS_REQUIREMENTS_EVALUATION.md`, `TEST_REPORT_v1.0.14.md`, `TEST_RESULTS_*.txt`, `ROLLBACK.md`, `SETUP.md`, `evidence/`. |
**Roles:** admin (System Administrator = owner), full_control, lab_manager, quality, staff. **Permissions:** edit, audit, backup, recover, users, own, assess. Forms: import/create/edit need `edit`; viewing needs `edit`, `assess`, `audit`, or `own` for the employee's own forms.

## 2. Work status
### 2.1 Implemented and automatically tested (Linux only)
Everything listed in `CHANGELOG.md` up to 1.0.14 **plus Fillable PDF forms (1.0.15):** import PDF templates (content check, SHA-256, versions, duplicate detection; Word rejected with a clear message); master protected (hash re-verified before every create/save; tamper test); forms for an employee with optional links to training / competency assessment / authorization (ownership validated); editor over the original page with native fields (text, multiline, checkbox, radio, dropdown) and user-placed text boxes, Arabic/English/mixed (direction, brackets, digits); OCR (English+Arabic) to help locate labels on scanned PDFs; each save = a new completed copy (revision, SHA-256, flattened); reopen restores values; print and export; completed copies registered as employee documents (usable as competency evidence); tables included in backups.
### 2.2 Implemented but NOT exercised by any executed test
Everything on real Windows; `setup/*.ps1`; Windows printing (print dialog, paper size); Access `.accdb` creation/reading; desktop notifications; employee-delete guard; permissions for roles other than admin/staff in forms.
### 2.3 Evaluated / planned only (NOT built)
**Word (DOCX/DOC) forms.** Candidate: SuperDoc 1.47.x embedded (tested in Electron on Linux, see evaluation doc); fallback: Word on a managed copy. Pending decisions: **D1** SuperDoc licence (AGPL-3.0 or commercial; legal review); **D2** is Microsoft Word installed on the lab PCs; **D3** a Windows PC + printer for acceptance tests.
### 2.4 Remaining work, in execution order
1. **W0 Windows verification of 1.0.15** on a TEST PC with a COPY of data: `testkit/WINDOWS_TEST_CHECKLIST.md` (all 10), setup scripts, WADA live check, Access backup/import with real Access, printing of forms (compare printout with Adobe/Edge printout of the exported PDF), real Arabic keyboard typing in the editor, SmartScreen.
2. **F1** decisions D1-D3. 3. **F5** DOCX per D1 (import, edit, save copy, print/export; DOC conversion). 4. **F6b** associate Word forms like PDF forms. 5. **F7** Windows acceptance of both; only then claim layout preservation on Windows.
6. Backlog: print path fidelity (see 4 known limits), page rotation, diacritics (tashkeel) positioning, form retirement/delete policy, salted password hashing (section 9).

## 3. Required software
Node **22.x** (tested 22.22.2), npm 10.9.7, bash, zip/unzip. Base portable package `EDCL-Lab-System-windows-portable-v1_0_9.zip` (lab-supplied; **only copy of the Electron runtime - keep it**). Electron tests: install Electron OUTSIDE the project (`.npmrc` disables install scripts): `mkdir ../electron35 && cd ../electron35 && npm init -y && npm i electron@35.7.5`; on Linux add `xvfb` (headless ozone crashes Electron 35). PDF verification script needs poppler-utils, qpdf, Python 3 + Pillow + numpy. Optional: LibreOffice, tesseract, PowerShell 7 (syntax checks of the .ps1 files).

## 4. Commands and expected output
```
npm install            # .npmrc ignore-scripts=true is deliberate (better-sqlite3 ships prebuilt binaries; no C++ toolchain needed)
npm test               # 4 suites
npm run build:vendor   # only after editing app/forms-engine.src.mjs
BASE_ZIP=/path/to/EDCL-Lab-System-windows-portable-v1_0_9.zip npm run build:portable
```
Expected `npm test`: `# tests 29 # pass 29 # fail 0`; `51 passed, 0 failed`; `28 passed, 0 failed`; `# tests 6 # pass 6 # fail 0`. Build output: `dist/EDCL-Lab-System-windows-portable-v1.0.15.zip` (contains `win-unpacked/`, `setup/`, `README_SETUP.md`) + `dist/SHA256SUMS.txt`.
Real-app forms test (ISOLATE the data folder first; main.js uses a fixed folder): `export XDG_CONFIG_HOME=/tmp/x FORMS_OUT=/tmp/forms-out APP_ROOT=$PWD; NODE_PATH=$PWD/node_modules xvfb-run -a ../electron35/node_modules/.bin/electron --no-sandbox --disable-gpu tests/electron/forms-pdf.js` then `python3 tests/electron/forms-pdf-verify.py`. Expected: 28 `ok`, `ALL PASSED`, then `ALL PASSED`. Add `MAINJS=<unzipped>/win-unpacked/resources/app.asar/main.js NODE_PATH=<unzipped>/win-unpacked/resources/app.asar.unpacked/node_modules` to test the packaged app.
**Known limits / defects (nothing fails in the suites):**
- Print from the app is a 200 dpi raster re-render with page size rounded by Chromium (594.96 vs 595.30 pt); measured 2.1% of pixels visibly differ from the completed copy. **Export PDF is byte-exact**; for exact printouts print the exported PDF from a PDF reader. Windows printing untested.
- Completed copies are flattened (not fillable); editing happens by reopening in the app (master + stored values).
- Arabic diacritics (tashkeel) may be misplaced (pdf-lib ignores mark positioning). Rotated pages and encrypted PDFs are not supported. OCR missed labels inside grey-shaded cells in the test scan (English 17/21, Arabic 10/15 on a skewed noisy scan).
- Only PDF templates; DOCX/DOC import is rejected with a message.
- jsdom tests cannot test real canvas/printing/Word/Access.

## 5. Data, backups, restoration
**Data folder (fixed in `main.js`):** `%APPDATA%\EDCL Lab System`: Chromium profile including **IndexedDB `edcl_docs` (v2)** = system of record: store `kv` key `D` (one JSON object with all tables incl. new `FormTemplates`, `FormInstances`, `FormRevisions`, `FormLinks`, `CompDefs`... `DocMeta`) and store `f` (files: id, cat, name, code, type, size, date, blob). **File categories for forms: `ftpl` = master templates (never rewritten), `fdone:<FormID>` = completed copies (one file per revision).** Also `wada-monitor.sqlite` (+wal/shm; schema user_version 2), `WADA Documents\`, `sqlite\`, `backup-settings.json`, window state.
**Backups:** Backup page: JSON, Access (.accdb/.mdb), `.sqlite`; automatic: `Documents\EDCL Backups\Auto` (newest 15 sets). They include all `D` tables and uploaded files. `.sqlite` backups contain the complete payload including password hashes: **confidential**. Setup (`setup/install.ps1`) zips the data folder to `Documents\EDCL Backups\userdata-before-setup-*.zip` first (untested).
**Verified (automated, Linux):** JSON and `.sqlite` restore reproduce competency tables and file bytes exactly; WADA DB v1->v2 migration keeps data. Form tables are part of the backup data set (tested), but a restore test specifically with forms was **not** run. **Not verified:** any restore on Windows; Access restore. Rollback: `docs/ROLLBACK.md`.
**Schema changes since 1.0.9:** new arrays and permission `assess` (additive), new `Form*` arrays (additive), WADA SQLite v1->v2 (additive). No production data was accessed by the assistant.

## 6. Configuration
No secrets in the project; no environment variables needed by the app. Build: `BASE_ZIP`. Tests: `APP_ROOT`, `MAINJS`, `FORMS_OUT`, `PHASE`, `XDG_CONFIG_HOME`/`APPDATA`. WADA proxy: Settings > WADA Updates > Network. Offline except WADA checks (HTTPS to www.wada-ama.org).

## 7. Git
Branches: `main` (stable), `feature/forms-pdf` (merged). Tags: `checkpoint-1` (1.0.14), `checkpoint-2` (1.0.15): `git rev-parse checkpoint-2` (also in `STOPPING_POINT_REPORT.md`). No remote. Uncommitted changes at this checkpoint: none.

## 8. Files and pending patches
Changed in checkpoint 2: `app/forms.js`, `app/forms-engine.src.mjs`, `app/vendor/*` (engine bundle, tesseract), `app/fonts/Noto*`, `app/index.html` (nav entry, loader, profile card, version), `main.js`/`preload.js` (`forms:saveFile`), `setup/*`, `tools/*`, `tests/*`, `docs/*`, `package.json`, `package-lock.json`. Pending patches: none.

## 9. Security, licensing, risks, approvals
- **Default credentials are hard-coded in `app/index.html` (pre-existing since the lab's v1.0.9 package, not added by the assistant).** On first run the app creates an `admin` account, an account for every employee and a lab-manager account with fixed initial passwords (visible in the source; the admin one is also shown on the first sign-in screen) and flags every account to change its password at first sign-in. Risk: anyone with the source or an unchanged first-run profile knows them. Not changed (needs lab approval). **Recommendation:** random first-run passwords, no on-screen hint, owner-only creation of employee accounts. The passwords are deliberately not repeated here.
- Passwords are stored as unsalted SHA-256 of `username:password` (pre-existing); recommend a salted KDF with a migration plan. `.sqlite` backups include these hashes.
- `app://` is a secure scheme, permission requests denied, IPC checks the sender; WADA downloads limited to wada-ama.org PDF/Office files with content checks; imported PDFs are content-checked (magic bytes, openable by pdf.js, no encrypted files), nothing is executed. Exe is **not code-signed** (SmartScreen).
- **Licences:** pdf.js, Tesseract.js (+core), tesseract language data: Apache-2.0; pdf-lib, fontkit, bidi-js, better-sqlite3, Electron: MIT; Noto Sans / Noto Naskh Arabic / Outfit: SIL OFL 1.1. **SuperDoc (candidate for Word) AGPL-3.0 / commercial: approval needed (D1).**
- Unresolved risks: Windows behaviour unknown; WADA parsers validated only against fixtures from a text extraction of the real pages; OCR unreliable in shaded cells; raster print path.
- Approvals required: D1 licence, D3 Windows test environment, security decision on default credentials, sign-off of acceptance results by the lab quality manager.
### 9a. Personal data contained in this archive (CONFIDENTIAL - authorized EDCL team members only)
`app/index.html` embeds the built-in seed data: **18 employees (full name, department, job title, employment status, joining date), 642 training records, 87 authorizations**, methods, instruments, plans. Scan (counts only): 0 national-ID-like numbers, 0 e-mails, 0 phone numbers, 0 password hashes in the seed. The same data is inside the lab's own package. Real production data (live IndexedDB, backups, uploaded documents) is **not** in this archive and must never be added. `testkit/forms/*.pdf` and tests use synthetic content (jsdom tests create users with the test password `Pass@123`, not an app default).

## 10. How another developer resumes (own account, own machine)
1. Unzip the project archive; verify `SHA256SUMS.txt`. 2. Node 22; `npm install`; `npm test` (section 4 numbers). 3. `git status` clean; `git tag` shows checkpoint-1/2. 4. Obtain the lab's base zip; `npm run build:portable`. 5. On a TEST Windows PC with a COPY of production data (take a backup first, `tools/backup-userdata.ps1`), run W0 (2.4). 6. Read `docs/FORMS_REQUIREMENTS_EVALUATION.md`, get D1-D3, continue at F5. 7. Before ANY change: back up (section 5), keep the previous package, add a CHANGELOG entry, run `npm test`, update sections 0 and 2 here, commit and tag a new checkpoint, rebuild and re-hash. 8. Never claim a feature complete without an executed test; record Windows results separately from Linux results.
