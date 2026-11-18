# EDCL Lab System v1.0.14 - Test Report

Date of runs: 2026-10-21. Every PASS below was produced by an executed test in this session; the lists in sections 4-7 are generated from the test runner output. Nothing is marked passed that was not executed.

## 1. Environments

| ID | Environment | What it can and cannot show |
|---|---|---|
| E1 | Node 22 (Linux sandbox), `node --test`, real local HTTP server serving saved WADA fixtures, real SQLite (better-sqlite3) | Parsers, change detection, retry, error handling, persistence. Not the Electron network stack. |
| E2 | Real `app/index.html` in jsdom 24 with fake-indexeddb | Page logic, UI flows, data persistence across simulated restarts. Not a real browser engine (no real canvas/printing/layout). |
| E3 | Real Electron 44.9.2 (Chromium 152) headless on Linux, dev source and the packaged `app.asar` | Real `net.fetch`, IPC, preload bridge, `printToPDF`, fonts, SQLite. Linux, not Windows. |
| E4 | The assistant's `web_fetch` tool reading live wada-ama.org pages on 2026-10-21 | Evidence of what the official pages contain. It is NOT the application's own network access. |

**Not available in this environment (so not tested):** the Windows EXE itself, the Windows print dialog/spooler, Microsoft Access/ACE, Windows proxy/certificate store, Windows desktop notifications, and the application's own connection to wada-ama.org (the sandbox cannot resolve it: `net::ERR_NAME_NOT_RESOLVED`).

## 2. Official WADA sources (item 1) - live-site evidence reported separately

All four addresses were read from wada-ama.org itself (fetched via E4); none are guesses. The Prohibited List address from v1.0.13 (`/en/prohibited-list`) and `/en/resources` were retired (hidden, not deleted).

| Source id | Official URL | Observed on the live page (E4) |
|---|---|---|
| news | https://www.wada-ama.org/en/media/news | Article cards: date `20 Oct 2026`, short title, type, `Read more on : <full title>`; article URLs `/en/news/<slug>` |
| prohibited-list-resource | https://www.wada-ama.org/en/resources/world-anti-doping-code-and-international-standards/prohibited-list | `In force`, `Publication date 01 Jan 26`, current Download link, related documents, `og:updated_time` 2026-01-19T09:38:43-05:00 |
| international-standards | https://www.wada-ama.org/en/what-we-do/international-standards | Technical Documents (TD...), Technical Letters (TL..), Guidelines, International Standards links with descriptions |
| td-index | https://www.wada-ama.org/en/resources/lab-documents/technical-documents-index | `In force`, `Publication date 11 Sep 26`, current Download (td2026_index_v4.0...), archives, `og:updated_time` 2026-09-16T11:11:29-04:00 |

**Live-site test status:** the application's own live synchronisation against these pages was NOT possible here (E3 result: `check()` -> failed, 4 failed sources, `dns` / `net::ERR_NAME_NOT_RESOLVED`, 11 s, recorded accurately). Parsers were therefore tested only against fixtures built from the E4 observations. Fixtures are a text/markdown extraction re-expressed as HTML (see `tests/fixtures/README.md`); the real pages' tag structure was not observed. A first run on a normal Windows PC with internet is still required.

## 3. Summary

| Suite | Environment | Result |
|---|---|---|
| WADA monitor (parsers, errors, change detection, persistence, migration) | E1 | 29/29 PASS |
| Competency/evidence/WADA screens | E2 | 51/51 PASS |
| Competency persistence, validation, associations, backup/restore | E2 + E1 | 28/28 PASS |
| Monitor inside real Electron (net.fetch) | E3 | 8/8 PASS |
| Training Form, printing to PDF, packaged app checks | E3 | see section 8 |

## 4. Item 5 and item 6 - WADA parsers, error handling, change detection (E1)

| Test | Environment | Result |
|---|---|---|
| A1 news parser: real listing structure -> clean titles, dates, types, canonical URLs, no duplicates | Node 22 + real HTTP server serving saved fixtures | PASS |
| A2 resource-page parser (Prohibited List): publication date, status, current download, og:updated_time, documents | Node 22 + real HTTP server serving saved fixtures | PASS |
| A3 index parser (International Standards): TDs, TLs, guidelines and standards with descriptions; no duplicates; fragments removed | Node 22 + real HTTP server serving saved fixtures | PASS |
| A4 resource-page parser (Technical Documents Index): current download and archive versions | Node 22 + real HTTP server serving saved fixtures | PASS |
| A5 all four configured source URLs are the official addresses captured from wada-ama.org (none guessed) | Node 22 + real HTTP server serving saved fixtures | PASS |
| A6 URL canonicalisation: tracking parameters, fragments, trailing slashes, http and foreign hosts | Node 22 + real HTTP server serving saved fixtures | PASS |
| B1 baseline run over all four sources: ok, items recorded, nothing announced, history accurate | Node 22 + real HTTP server serving saved fixtures | PASS |
| C1 HTTP 404 on every source: failed run, 1 attempt each, actionable error rows, no success recorded | Node 22 + real HTTP server serving saved fixtures | PASS |
| C2 network failure: classified, retried with exponential backoff, then fails fast on remaining sources; never "ok" | Node 22 + real HTTP server serving saved fixtures | PASS |
| C3 empty results: HTTP 200 with a page that has no items is a FAILED check (parse_failed), not a success | Node 22 + real HTTP server serving saved fixtures | PASS |
| C4 changed page structures are detected for each parser kind (news, index, resource) | Node 22 + real HTTP server serving saved fixtures | PASS |
| C5 duplicate news items: repeated anchors, tracking params, trailing slash and image-only anchors yield one record and one notification | Node 22 + real HTTP server serving saved fixtures | PASS |
| C6 sync history is accurate for success, partial and failed runs; lastSuccess only moves on a fully successful run | Node 22 + real HTTP server serving saved fixtures | PASS |
| C7 403 and 202 challenge are permanent, not retried, not bypassed; off-site redirect rejected | Node 22 + real HTTP server serving saved fixtures | PASS |
| C8 503 x2 then 200: retried with backoff, run ok, no duplicate records | Node 22 + real HTTP server serving saved fixtures | PASS |
| C9 timeout and cancellation; duplicate-request prevention | Node 22 + real HTTP server serving saved fixtures | PASS |
| C10 error classification covers Chromium and Node error texts | Node 22 + real HTTP server serving saved fixtures | PASS |
| D1 structured change (publication date + current download) is DETECTED, announced once, and stays UNVERIFIED | Node 22 + real HTTP server serving saved fixtures | PASS |
| D2 metadata-only change (og:updated_time) is recorded as a version but NOT announced as a change | Node 22 + real HTTP server serving saved fixtures | PASS |
| D3 text edits are graded by size: small edit below threshold = minor (silent), larger edit = "text" change announced, with the measured percentage | Node 22 + real HTTP server serving saved fixtures | PASS |
| D4 verification is a human decision: default unverified, requires a user, can be changed, and is reset by the next detected change | Node 22 + real HTTP server serving saved fixtures | PASS |
| D5 no code path produces a "verified" state automatically: after many varied changes every item is unverified | Node 22 + real HTTP server serving saved fixtures | PASS |
| D6 news item with an edited title: change detected (possible), one notification, unverified | Node 22 + real HTTP server serving saved fixtures | PASS |
| E1 new item after baseline -> exactly one notification and one desktop notification; unchanged recheck -> none | Node 22 + real HTTP server serving saved fixtures | PASS |
| E2 notifications, history, read status and preferences persist across restart | Node 22 + real HTTP server serving saved fixtures | PASS |
| E3 migration v1 -> v2 keeps existing data; retired (guessed) sources are hidden, not deleted | Node 22 + real HTTP server serving saved fixtures | PASS |
| E4 category preferences, interval validation, scheduler due() | Node 22 + real HTTP server serving saved fixtures | PASS |
| E5 document download validates host, type and content; never executes | Node 22 + real HTTP server serving saved fixtures | PASS |
| E6 a run left "running" by a crash is closed as "interrupted" at startup and is never counted as a success | Node 22 + real HTTP server serving saved fixtures | PASS |

Evidence: `tests/wada-monitor.test.js` (run: `node --test tests/wada-monitor.test.js`, output: `# tests 29 # pass 29 # fail 0`). Item 6 specifically: D1-D6 show that a changed page fingerprint is stored as a *detected* change; metadata-only and tiny edits are recorded but not announced; every change stays `unverified` until a named user marks it Substantive or Not substantive; the next detected change resets the verdict; no code path verifies automatically (D5).

Real-Electron (E3) evidence for the network layer:
```
ok   electron net.fetch: baseline check ok, 1 item
ok   electron net.fetch: new item -> 1 notification
ok   electron net.fetch: unchanged recheck -> no new notification
ok   electron net.fetch: 503,503,200 retried, run ok (hits=4)
ok   electron net.fetch: 404 -> failed run, not success
ok   electron net.fetch: in-flight request cancelled via AbortSignal (cancelled)
ok   Chromium error classified: connection refused -> network/connect :: net::ERR_CONNECTION_REFUSED | Network connection failed
ok   Chromium error classified: DNS -> dns/dns :: net::ERR_NAME_NOT_RESOLVED | DNS lookup failed - check internet/DNS settings
electron 44.9.2 chrome 152.0.7977.167 node 24.22.0
```

## 5. Item 7 - competency evaluations and role requirements

| Test | Environment | Result |
|---|---|---|
| definitions, criteria, role requirements survive a restart | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| assessment, criteria results, evidence snapshot, document metadata and history survive | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| linked document file is still present and identical after restart | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| competency without a title is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| requirement without job title is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| duplicate role requirement is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| score outside 0-100 is rejected on submit | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| "Competent" with unscored criteria is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| "Not Yet Competent" without corrective action is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| restrictions outcome without described restrictions is rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| starting a second assessment for the same employee+competency reopens the open one (no duplicate) | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| a competency that has assessments cannot be deleted | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| evidence upload: unsupported extension rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| evidence upload: PDF whose content is not a PDF rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| evidence upload: empty file rejected | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| required competencies follow the employee job title (case/space-insensitive) | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| changing another employee to a matching title associates the competency | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| employee profile lists the required competency and the assessment history for that employee only | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| another employee profile shows none of it | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| full JSON backup content contains every competency table and the evidence files | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| SQLite backup written and verified (integrity + row counts) | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| SQLite file has one table per competency table with the right row counts | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| Access table model includes the competency tables with valid names and types (Access file itself NOT tested - needs Windows) | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| restore from the SQLite backup brings back all competency data exactly | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| restored evidence document is byte-identical (SHA-256) | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| restored evidence still evaluates to the same state as before | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| restore from the JSON backup is also exact | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |
| no page errors | E2 jsdom + fake-indexeddb (+ E1 SQLite) | PASS |

## 6. Acceptance tests from the earlier specification, WADA screens, verification UI

| Test | Environment | Result |
|---|---|---|
| pure-JS SHA-256 fallback matches Node crypto on edge-case lengths | E2 jsdom + fake-indexeddb | PASS |
| competency profile card shows ID, role and required competency | E2 jsdom + fake-indexeddb | PASS |
| status is Pending Assessment before any evaluation | E2 jsdom + fake-indexeddb | PASS |
| required training gap is reported | E2 jsdom + fake-indexeddb | PASS |
| assessment created as Draft with criteria rows | E2 jsdom + fake-indexeddb | PASS |
| only this employee's documents are offered | E2 jsdom + fake-indexeddb | PASS |
| document linked by database ID without duplicating the file | E2 jsdom + fake-indexeddb | PASS |
| Evidence & Documents section lists the linked document | E2 jsdom + fake-indexeddb | PASS |
| evaluator can open the linked evidence | E2 jsdom + fake-indexeddb | PASS |
| outcome is NOT set automatically by the existence of a certificate | E2 jsdom + fake-indexeddb | PASS |
| document of another employee is rejected (ownership validated by ID) | E2 jsdom + fake-indexeddb | PASS |
| linking the same document twice is rejected | E2 jsdom + fake-indexeddb | PASS |
| SOP acknowledgement reported Missing | E2 jsdom + fake-indexeddb | PASS |
| Certificate reported Awaiting verification | E2 jsdom + fake-indexeddb | PASS |
| Certificate reported Expired when its expiry date has passed | E2 jsdom + fake-indexeddb | PASS |
| screen shows the Expired / Missing chips | E2 jsdom + fake-indexeddb | PASS |
| "Competent" is blocked while required evidence is missing/expired | E2 jsdom + fake-indexeddb | PASS |
| evidence still records the original SHA-256 and a pre-change archive copy | E2 jsdom + fake-indexeddb | PASS |
| archived version contains the OLD content | E2 jsdom + fake-indexeddb | PASS |
| live document now has the NEW content (not silently the same record) | E2 jsdom + fake-indexeddb | PASS |
| evidence state is flagged Replaced | E2 jsdom + fake-indexeddb | PASS |
| affected evaluation was told and history logged | E2 jsdom + fake-indexeddb | PASS |
| new version needs fresh verification | E2 jsdom + fake-indexeddb | PASS |
| opening evidence opens the archived (historical) version | E2 jsdom + fake-indexeddb | PASS |
| evaluator signs and submits (identity + timestamp) | E2 jsdom + fake-indexeddb | PASS |
| evaluator cannot approve own evaluation | E2 jsdom + fake-indexeddb | PASS |
| a different authorised reviewer sees Approve | E2 jsdom + fake-indexeddb | PASS |
| approved evaluation is locked with reviewer signature | E2 jsdom + fake-indexeddb | PASS |
| evidence state captured at approval | E2 jsdom + fake-indexeddb | PASS |
| history shows creation, link, signature, approval | E2 jsdom + fake-indexeddb | PASS |
| reassessment can be started from a restricted outcome | E2 jsdom + fake-indexeddb | PASS |
| print/export contains an evidence index (listing, not merged attachments) | E2 jsdom + fake-indexeddb | PASS |
| staff role cannot start an evaluation | E2 jsdom + fake-indexeddb | PASS |
| nobody can evaluate their own competency | E2 jsdom + fake-indexeddb | PASS |
| Competency Evaluations page lists the employee with filters | E2 jsdom + fake-indexeddb | PASS |
| Document traceability tab warns about the replaced evidence | E2 jsdom + fake-indexeddb | PASS |
| Competencies tab lists definitions | E2 jsdom + fake-indexeddb | PASS |
| Role requirements tab lists the job title link | E2 jsdom + fake-indexeddb | PASS |
| WADA Updates page shows last success, next check and error status | E2 jsdom + fake-indexeddb | PASS |
| New Updates inbox lists items with Open Update | E2 jsdom + fake-indexeddb | PASS |
| mark as read persists through the API | E2 jsdom + fake-indexeddb | PASS |
| "No new updates" is reported distinctly after a successful check | E2 jsdom + fake-indexeddb | PASS |
| All Updates distinguishes new / unchanged and flags unverifiable page monitoring | E2 jsdom + fake-indexeddb | PASS |
| detected change is labelled "unverified" (never "confirmed") | E2 jsdom + fake-indexeddb | PASS |
| verification is a user action recorded with the user name | E2 jsdom + fake-indexeddb | PASS |
| Sync History shows failed run and categorised error with URL, stage, HTTP | E2 jsdom + fake-indexeddb | PASS |
| Settings has frequency, desktop and category filters | E2 jsdom + fake-indexeddb | PASS |
| saved preferences reach the service (interval 12h, education off) | E2 jsdom + fake-indexeddb | PASS |
| bell and menu show unread WADA count | E2 jsdom + fake-indexeddb | PASS |
| employees, training, methods, authorizations unchanged | E2 jsdom + fake-indexeddb | PASS |
| no page errors | E2 jsdom + fake-indexeddb | PASS |

## 7. Item 8 - forms, templates, headers, printing (what exists, what was tested)

**Finding: this application has no "General Form Editor", no template editor and no page footer.** Searched the source for "General Form", "form editor", "saved template" and "template editor": no matches. What exists is the Training Forms editor (FO127 Training Evaluation, FO313 Training Program) with a fixed lab header, saved forms, "Print / Save as PDF", the Document Templates page (list of controlled documents with attached files) and the Print Center. Those were tested as follows (E3 real Electron, Linux):

| Test | Environment | Result |
|---|---|---|
| Create an FO127 Training Evaluation form in the real app, fill fields, Save -> record stored (`TF-0001`, type FO127) | E3 | PASS |
| Saved form persists after closing and reopening the app (list shows TF-0001) | E3 | PASS |
| Clicking the saved form reloads its fields (Form no., Subject, Score 88, Comments, Evaluator) | E3 | PASS |
| Printing the real window to PDF (`printToPDF`): valid PDF, 1 page; text contains "Egyptian Doping Control Laboratory", "Training Evaluation (FO127)", "Form no. TF-0001", field values | E3 | PASS |
| Printout does not contain the new sidebar/top-bar text (WADA Updates, Competency Evaluations, Sign out, Dashboard): 0 matches | E3 | PASS |
| Competency evaluation printed through the app's real `print:pdf` handler: valid PDF, A4, lab header, outcome, criteria, evidence index, evaluator/reviewer signatures | E3 | PASS |
| Document Templates page renders (15 rows) | E3 | PASS (render only; adding/attaching templates NOT tested) |
| Footer on printed forms | - | NOT PRESENT (no footer is implemented) |
| General Form Editor, saved *templates* with custom headers/footers | - | NOT PRESENT - cannot be tested |
| Windows printing (print dialog `print:print`, physical/PDF printer, paper size on Windows) | - | NOT TESTED (needs Windows) |
| Print Center | - | NOT TESTED |

## 8. Defects found and fixed during this test cycle
1. News parser produced garbage titles from the real card structure (thumbnail name + date + type + "Read more on : ..."). Fixed; tests A1, C5.
2. Neighbouring news items looked "changed" when one article was added (overlapping text window). Fixed earlier (v1.0.13); still covered.
3. A URL that is both a monitored page and a link on another monitored page caused two sources to fight over one record and a false "changed" on every run. Fixed (each URL belongs to one source); found by B1.
4. Runs cut off by an application exit stayed "running" forever in Sync History. Fixed (marked "interrupted" at startup); test E6, observed in E3.
5. Employees with competency assessments could be deleted through the generic delete (orphaned history). Guard added. **The guard was implemented but no executed test exercises the delete button - treat as untested.**
6. Competency scores were not range-checked. Fixed (0-100); test in section 5.
7. Guessed WADA URLs from v1.0.13 replaced by the four official addresses; retired sources hidden, data preserved (test E3 migration).

## 9. Known limitations and unresolved items
- Windows EXE not launched; Windows printing, Windows proxy/certificate behaviour, desktop notification display and the Access (.accdb) file creation/reading were not tested (Access table model and the PowerShell scripts were only syntax-checked/mock-run earlier).
- Live WADA parsing is unverified against the raw HTML of the real pages (fixtures derived from a text extraction). Only the first page of the news listing is read. Technical Documents are tracked per link; a new version of an existing TD page under the same address is detected only through the TD Index page's publication date/download link. Categories are assigned by keywords. Only the 40 newest files per resource page are tracked; the first run of a source is a baseline and is not announced.
- Page-level change detection is heuristic: a 'structured' signal (publication date, status, download link) or a text change above the configured percentage is announced as *detected - unverified*. Deciding whether a change is regulatory-substantive remains a human decision.
- The Training Form prints on the default paper size (Letter in the Linux test); no `@page` size is defined for it (the competency report is A4). On Windows the printer default applies - to be checked.
- The evidence-index table in the printed evaluation wraps the ID column ("EV-" / "0001") - cosmetic.
- The application has no Arabic user interface, so no Arabic testing was possible.
