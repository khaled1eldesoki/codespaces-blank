# Changelog (newest first). Dates are the assistant's sandbox dates.
Builds 1.0.10 to 1.0.13 were delivered as downloads and then **replaced** (not retained). The only older package that still exists is the lab's own v1.0.9 portable zip (the Electron runtime base). Sources of 1.0.10-1.0.13 are contained in the history below only as described, not as separate archives.

## Checkpoint 3 - central LAN server (no change to the desktop app) - 2026-11-03
- New `server/` (db, store, auth, server, import-backup, cli) and `docs/LAN_SERVER.md`: one central SQLite database, individual accounts (scrypt), per-record optimistic concurrency with field-level merge and conflict reporting, version history, audit log, live events, verified backups, optional HTTPS.
- Tests `tests/server/central.test.js` (13/13, Linux, Node 22.22): 100 concurrent editors on one record (disjoint fields all merged; same field - exactly one wins per revision, none lost), 120 accounts x 5 rounds over 30 records with zero lost updates, permissions, lockout, legacy-hash upgrade, paged sync convergence, SSE, backup + restart, migration import, HTTPS.
- **Desktop app code unchanged; the Windows build from 1.1.0 is still the latest build and does not contain the server.** `npm run test` (existing 4 suites) could not be run here (no network for devDependencies).

## 1.1.0 (Employee Profile redesign, main.js fix, sign-in cleanup) - 2026-11-01
- Sign-in screen: removed the welcome line and the first-sign-in credentials hint. App version shown in the app is now 1.1.0 (package.json, lock file and screen agree).
- **Dashboard slideshow**: large auto-playing banner (5 built-in animated scenes: laboratory, testing, instruments, research, clean sport) with crossfade, previous/next arrows, slide dots, pause/play, progress bar, swipe and keyboard support. Admins can add their own photos with the "Slides" button.
- **Laboratory Director profile** section on the dashboard (photograph, name, job title, biography, qualifications, experience, expertise, optional leadership message). Administrators edit it with "Edit profile"; other users see it once it is filled in.
- **Manage Profile Tabs** (System Owner only, button on the Employee Profile screen): add, rename and retitle tabs, reorder by drag and drop (or arrows), hide/show, create custom sections, add custom fields to any tab (text, long text, date, number, dropdown, yes/no, email, phone, file attachment), required/optional fields, and restore the default layout. Custom values are stored on the employee record; attachments are stored as personnel-file evidence.
- **Director career history timeline**: EDCL positions highlighted, current position marker, overlapping positions supported, expandable responsibilities/achievements, add/edit/delete positions; dates are stored exactly as entered and the originally recorded dates are kept.
- **Fillable Forms**: Delete option for completed forms (all revisions and files) and for unused templates, also in the employee's forms list; deletions are written to the audit trail.
- **Training Record Files** tab (Competency group, after Training Records): registers the full content of a training package - memorandum, training program, quiz and answer key, attendance, per-trainee score with automatic result band, evaluator and authorization - plus the scanned PDF. Edit, delete (audited), and an example record for ISL TD2027NA.
- **Competence Sheet** replaces the old Competence tab in the Employee Profile: identity block, competence matrix (role requirements plus any other assessed competency, with Open/Assess buttons), training, registered Training Record Files (score, result band, authorization), authorizations, recorded evaluations, reviewer/approver sign-off with remarks, and Print / Save as PDF.
- **Evaluation Sheets** tab in the Employee Profile and a sidebar register: previous / current / next competence evaluation date per employee, overdue and due-soon status, and the evaluation sheet PDF attached to each record (also listed under Documents & evidence). The next date is suggested 12 months ahead and can be changed. The Competence Sheet shows the latest dates.
- Competence Sheet review / approval names are plain typed text (not tied to user accounts) and are editable by anyone who can edit the profile or assess competence.
- **Security** tab (admin): two-step verification with any authenticator app (TOTP, QR code or manual key, 8 one-time recovery codes, optional "required for all users", owner can reset a user); automatic sign-out after inactivity (5-60 min, 60 s warning); password re-entry before opening protected areas (Settings, Users & Roles, Backup & Access DB, SQLite Databases, Tab Manager, Form Designer, Audit Trail, Access Log, Security, Manage profile tabs) with a configurable list and validity; WADA online synchronization switched on at first sign-in with status, interval, last/next sync and Sync now. Security events are written to the Access Log.
- Fixed crash "Object has been destroyed" on second launch (main.js).

- **Employee Profile screen redesigned** to the approved mock-up: header card (photo, status, ID | department | job title, email, phone, joining date, manager), tab bar (Overview, Personal, Education, Training, Competence, Authorization, Documents, Compliance, History), four summary tiles, Key Information, Latest Activities and summary cards. All existing editing, saving, certificates, signature, forms and print preview kept.
- Compliance card renamed **ISO/IEC 17025 · WADA ISL 2027 · TD LDOC 2027**; tiles derived from the saved declarations (ISO/IEC 17025, WADA ISL, personnel-file checklist, COI). New optional field **Manager** in the profile form (new templates only).
- "Linked records - kept separate" now sits inside the Authorization tab. History tab shown only to users who may edit or audit.
- Checked in headless Chromium (render, all tabs, edit+save, employee switch, no script errors). The jsdom suites could not be run in this sandbox (dependencies not installable offline) - run `npm test` before release.

## 1.0.15 / Checkpoint 2 - 2026-10-25
- **Fillable PDF forms** (menu "Fillable Forms"): template import with SHA-256 and master protection; forms per employee linked to training / competency / authorization records; editor with native PDF fields and user-placed text boxes; mixed Arabic/English text engine (bidi, bracket mirroring, font fallback); OCR (English+Arabic) assistant for scanned PDFs; revisions as separate completed copies; reopen; print; export; completed copies usable as competency evidence; tables in backups.
- **Setup scripts** (`setup/`): per-user install with automatic data backup, previous-folder kept, shortcuts, uninstall (never run on Windows).
- Bugs found by the new checks and fixed before release: minified bundle broke field-type detection (class names mangled) - now `instanceof`, tested against the shipped bundle; completed copies left dangling page annotations (poppler "Invalid XRef entry") - now cleaned.
- Verified the bundled pdf.js 3.11.174 detects native fields (9/0/0 on the test forms).
- Known: print path is raster (2.1% visible difference), Windows untested, Word forms not built, default first-run credentials in source (pre-existing) documented in HANDOVER section 9.
- New dependencies: pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, bidi-js, tesseract.js (+core, eng/ara data), esbuild and pdfjs-dist 3.11.174 (dev), Noto fonts.

## Checkpoint 1 - 2026-10-23 (no application code change from 1.0.14)
- Added handover project tree: package.json scripts, package-lock.json, relative-path tests, `tools/make-portable.sh`, `tools/backup-userdata.ps1`, docs, test kit, Git repository.
- Verified 1.0.14 on **Electron 35.7.5 / Chrome 134** (the runtime inside the exe): monitor scenarios 8/8, packaged-app IPC smoke, Training Form save/print/restart (previous Electron tests ran on 44.9.2).
- Corrected an earlier statement: the app already bundles pdf.js 3.11.174 with a read-only PDF preview.
- Found/fixed in the working copy only: my own comparison script deleted source files in the handover copy; restored from source and verified identical by hash. No shipped file, no user data affected.

## 1.0.14 - 2026-10-21/22 (delivered as EDCL-Lab-System-windows-portable-v1_0_14.zip)
- WADA sources replaced by four **official wada-ama.org pages** (news; Prohibited List resource page; International Standards incl. Technical Documents/Letters/Guidelines; Technical Documents Index). Old guessed URLs retired (hidden, data kept).
- News parser rewritten for the real card structure; resource pages tracked by publication date, status, current download, og:updated_time, body text; PDF documents (newest 40) tracked.
- Change detection: detected vs verified. Metadata-only and small text changes are recorded, not announced; every change stays "unverified" until a named user marks Substantive / Not substantive; next change resets it. IPC `wada:verify`.
- SQLite migration v2 (additive columns); actionable error text in Sync History; runs cut off by an exit are marked `interrupted`; each URL owned by one source; empty/changed pages = failed check.
- Competency: score range 0-100; employees with assessments cannot be deleted (guard added, **no executed test**).
- Tests: monitor 29, UI 51, persistence/backup-restore 28 (all automated, Linux). Test report generated.

## 1.0.13
- WADA monitor on Electron `net.fetch` (root cause of "fetch failed": Node fetch ignored system proxy/cert store), SQLite history/notifications/preferences, scheduler (6 h default), desktop notifications, WADA Updates UI.
- Competency evaluations with Evidence & Documents, document versions archived on replace/delete, traceability, evaluator/reviewer workflow, print/export with evidence index, `assess` permission.
- SHA-256 pure-JS fallback.

## 1.0.12
- New sign-in screen (hidden password with eye toggle, remember me), light layout with icons, top bar and user menu, dashboard redesign, bundled Outfit font.

## 1.0.11
- Automatic backup (Access + SQLite) at sign-out, on close, every 30 minutes when changed, before import; keep newest 15 sets in `Auto`.
- Import from Access (.accdb/.mdb); role `full_control`; theme refresh.

## 1.0.10
- One-click backup to Microsoft Access (.accdb, fallback .mdb) and SQLite; restore from the SQLite backup.

## 1.0.9
- Base supplied by the lab (portable package, Electron 35.7.5).

## 1.2.0 — central client–server deployment
- Desktop app can run against the central EDCL server (HTTPS, private lab CA): server sign-in, record-level sync with conflict handling, central file store, server-side user administration, status badge, conflict dialog. Without a configured server the app behaves as in 1.1.0.
- Server: file store, private CA tool, setup helper, `restore`/`verify-backup`/`import` (with files), file mirror in backups, phone viewer and WADA feed wired in, `/api/info`, `/api/admin/status`.
- Installers: `tools/build-installers.sh` → EDCL-Server-Setup.exe, EDCL-Client-Setup.exe (NSIS). Tests: `npm run test:server`, `npm run test:e2e`.
