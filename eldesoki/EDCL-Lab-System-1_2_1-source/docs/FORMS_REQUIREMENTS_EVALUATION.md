# EDCL Lab System - Word and PDF Forms: requirements update, v1.0.14 inspection and solution evaluation
(Copy of the document produced on 2026-10-22; an online copy exists in the assistant's account but THIS file is the authoritative one.)

> **IMPLEMENTATION STATUS (2026-10-25, v1.0.15):** PDF forms (requirements R1-R4, R6-R12 for PDF) are implemented and tested on Linux; see HANDOVER.md section 2. **Word (DOCX/DOC) forms (R5) are NOT implemented** - decisions D1-D3 pending. Nothing is verified on Windows. Statement about the Arabic engine in section 4.3 is superseded: the order/bracket/alignment defect was fixed and is covered by tests/forms-engine.test.js; diacritics (tashkeel) positioning remains a limitation.

> **CORRECTION (2026-10-22).** The original text said v1.0.14 has no PDF viewer. That was wrong: the app bundles **pdf.js 3.11.174** (`app/vendor/pdf.min.js`, `pdf.worker.min.js`, Apache-2.0) and `pdfPages()` renders PDF pages to canvases in the document preview. It is **read-only** (no fields, typing, saving or OCR). There is still **no Word viewer/editor** and no General Form Editor (0 matches for mammoth, docx-preview, renderAsync). "Adopt pdf.js" means extend the bundled 3.11.174 or upgrade it; the field-detection test (9/9 widgets) used a newer pdfjs-dist, so detection on 3.11.174 itself is **not yet tested**.

**Status: evaluation complete. Implementation NOT started. No application code, data or master file was changed by the evaluation.** Environment of all experiments: Linux sandbox (Node 22, Electron 44.9.2 headless, LibreOffice, poppler). Not available, so not tested: Windows, the Windows EXE, Microsoft Word, a physical printer, Windows Arabic keyboard/IME.

## 1. Inspection of v1.0.14
| Question | Finding |
|---|---|
| General Form Editor? | **No** (0 matches for "General Form", form editor/builder, template editor in all source files). |
| Open/preview/fill Word or PDF? | PDF: read-only preview only (see correction). Word: nothing. |
| Forms features that exist | Training Forms (FO127, FO313: HTML forms, fixed lab header, saved records, printed from the page); Document Templates (controlled documents with attached files and versions, IndexedDB `tpl:<ID>`); Document Library "Forms" category; Print Center; HTML-to-PDF/print bridge (`print:pdf`, `print:print`, `print:save`). |
| Footers | None are generated on printed forms. |

## 2. Updated requirements (each testable)
| ID | Requirement |
|---|---|
| R1 Template library | Import DOCX, DOC, PDF; record file name, form code, revision, SHA-256, import date/user. **Master is read-only**, never written, a changed hash is reported; new revisions are new versions, old kept. DOC is converted to a DOCX working copy while the original DOC stays untouched. |
| R2 Preview | Preview any master or completed form with the original layout before filling. |
| R3 Completed forms | Filling creates a **separate completed copy** linked to template id + hash; reopenable and editable with a revision history (who, when, hash). |
| R4 Associations | Each completed form belongs to one **employee** and can link to **training, competency, authorization, quality** records; shown in the employee profile; attachable as competency evidence by document ID. |
| R5 DOCX editing | Type directly in the document; tables, merged cells, headers/footers, RTL paragraphs, page breaks preserved. |
| R6 PDF native fields | Detect and fill AcroForm text, multiline, checkbox, radio, dropdown. |
| R7 PDF overlays | For non-fillable and scanned PDFs the user places and sizes text boxes precisely (coordinates in PDF points). |
| R8 OCR | Optional OCR (English + Arabic) to help locate labels; never alters the master. |
| R9 Arabic / English | Correct shaping, RTL order, mixed text, digits, brackets, punctuation in editor, saved file and printout. |
| R10 Print / export | Print and export with original layout; PDF export for every kind. |
| R11 Security | Role permissions, audit trail (import/create/edit/save/print/export), file-type and content validation, nothing executed, no macros. |
| R12 Data safety | Completed forms and master references included in JSON, SQLite and Access backups and restored exactly; no existing data overwritten. |

## 3. Solution comparison
| Option | Inside the portable exe, offline? | Licence | Evidence | Verdict |
|---|---|---|---|---|
| ONLYOFFICE Docs | **No**: separate Document Server reachable by the app, POSTs callbacks, JWT; Windows installer needs 64-bit Windows Server 2016+, port 80 by default | Community AGPL v3 (usage limits); Enterprise/Developer proprietary | Documentation/repositories only; **not installed or tested** | Not suitable to embed; possible later as an IT-managed server |
| SuperDoc 1.47.2 | **Yes**: bundled with Vue by esbuild into one 13 MB script + CSS; ran in Electron | **AGPL-3.0** or commercial; **legal review needed** | **Tested** (section 4.1). SuperDoc 2.25.0 failed to start in the same simple bundle ("bundled V2 runtime unavailable") - pin the version | Best embedded candidate; fidelity vs Word NOT proven |
| Microsoft Word (managed copy opened outside the app) | Needs Word installed | Office licence | Not tested | Fallback and the reference for exact layout/printing; not embedded |
| LibreOffice (headless conversion) | Needs installation | MPL | Used to render DOCX to PDF for comparison; approximation of Word | Converter, not a reference |
| docx-preview / mammoth | Yes | MIT / BSD | Not tested; read-only approximations, mammoth drops layout | Rejected for editing |
| pdf.js | Yes (3.11.174 already bundled) | Apache-2.0 | Detected 9/9 widgets (newer pdfjs-dist) | Extend/upgrade |
| pdf-lib + fontkit | Yes | MIT | Fills fields, draws text; Arabic limits below | Adopt with an own text engine |
| Tesseract.js | Yes (Arabic data 1.6 MB, English 2.9 MB) | Apache-2.0 | Section 4.4 | Assistant, not authority |

## 4. Experiments and exact results (scripts in `testkit/experiments/`)
### 4.1 DOCX in SuperDoc 1.47.2 (Electron 44.9.2, Linux)
Test form: A4, Arabic+English, header/footer with page-number field, merged header cell, shaded cells, RTL paragraph, content control, page break, 30-row table (3 pages). Loaded and editable (276 commands). English and Arabic text typed through the editor API into four table cells, exported; original and exported rendered with LibreOffice: **3 pages both**, text in the correct cells. OOXML counts original vs exported identical: tables 2/2, rows 37/37, gridSpan 2/2, page breaks 1/1, content control 1/1, bidi 1/1, rtl 1/1, shading 14/14, header 1/1, footer 1/1, PAGE field kept, page size/margins kept. Package grew 19 to 27 parts (848 KB to 860 KB). (A first run misplaced text because my script used stale cell positions; fixed by inserting from the end backwards.) **Limits:** API insertion, not real keyboard/Arabic IME; no comparison with Word; one document; no tracked changes/comments/images; SuperDoc has no PDF export.
### 4.2 PDF native fields (pdf.js + pdf-lib)
9/9 fields detected; filled values saved to a separate file; master byte-identical. **Defect:** pdf-lib builds field appearances with one font; with an Arabic-only font, Latin letters, digits and punctuation drew as empty boxes; pure Arabic was shaped correctly. Fix: per-character font fallback.
### 4.3 PDF overlay and Arabic/English engine (`testkit/experiments/bidi_exp.mjs`)
Label-plus-offset placement was wrong for some cells: **placement must be user-driven**. Own engine (bidi reorder + font fallback + LTR digits) matched Chromium for names, "EMP001 / Staff ID", Latin+Arabic, digits, plain English. **Unresolved defect:** brackets in mixed text ("95% (Satisfactory)") and right alignment of RTL fields.
### 4.4 OCR (Tesseract.js eng+ara, skewed 0.7 degree noisy scan at 200 dpi)
2.3 s per A4 page; init 0.9 s; mean confidence 85; English labels found 17/21; Arabic 10/15; every miss was a label in a **grey-shaded cell**. OCR can suggest positions but cannot be relied on.
### 4.5 Printing
Only Chromium `printToPDF` was exercised. **Windows printing, drivers, paper sizes, exact layout: NOT tested.**

## 5. Recommended architecture (not implemented)
New tables only: FormTemplates (code, kind, version, SHA-256, file id), FormInstances (template id+hash, employee, status, values/overlays JSON, current file id), FormRevisions (hash, user, time, file id), FormLinks (instance to training/competency/authorization/quality ids). Files in the existing IndexedDB file store 'f' (covered by existing backups). PDF: pdf.js renders, HTML controls over the page, save writes onto a COPY with pdf-lib + own text engine, reopen = master + stored values. DOCX: embed SuperDoc (pin 1.47.x); master untouched, edited copies saved; "Open in Word" on a managed working copy as fallback/reference; PDF export and printing through Word/LibreOffice when installed. Size: SuperDoc 13 MB + CSS 0.1 MB; OCR data 4.5 MB + engine; PDF libs a few MB.

## 6. Open decisions and risks
1. Licence: SuperDoc AGPL-3.0 or commercial (legal question, not decided).
2. Is Microsoft Word installed on the lab PCs? (decides DOCX print/PDF path and fallback).
3. DOCX fidelity vs Word and real Arabic typing: unproven until Windows tests pass.
4. Legacy .doc needs a converter on import.
5. Open Arabic text-engine defect (brackets, alignment) must be fixed and re-tested before PDF text is saved.
6. OCR misses labels in shaded cells.

## 7. Acceptance tests - ALL NOT YET RUN on Windows
See `testkit/WINDOWS_TEST_CHECKLIST.md` (10 steps) and the test forms in `testkit/forms/`.

## 8. Needed from the lab to start implementation
1. Approve SuperDoc (after licence review) or choose Word-only external editing. 2. Confirm Word availability on lab PCs. 3. A Windows PC with a printer for the checklist (or send the results).
