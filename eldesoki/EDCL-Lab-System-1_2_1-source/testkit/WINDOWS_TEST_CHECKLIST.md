# Windows test kit - Word & PDF forms (NOT YET RUN on Windows)

Test forms (forms/): FO-TEST-001.docx (Arabic+English, merged cells, RTL paragraph, content control, header/footer, page break, 30-row table that flows to page 3),
FO-TEST-001.pdf (static, non-fillable), FILL-TEST.pdf (native AcroForm: text, multiline, checkbox, dropdown, radio), FO-TEST-001-scanned.pdf (image-only, skewed 0.7 deg, noisy).

For every test record: Windows version, Office/Word version (or none), printer name/driver, paper size, app version, result, photo/scan of the printout.
1. Import each form; confirm SHA-256 of the master is unchanged after fill, save, reopen, print (compare with certutil -hashfile).
2. DOCX: type English and Arabic (real keyboard + Arabic IME) in each table cell, comment box and content control; save separate copy; reopen; confirm page count (3) and layout against Word's own rendering.
3. DOCX: print on a real printer and via PDF; compare page-by-page against the same file printed from Word (overlay on a light table).
4. PDF native fields: fill EN/AR/mixed values; save; open completed copy in Adobe Reader AND Chrome AND Edge; confirm values visible and identical.
5. PDF overlay (static + scanned): place boxes, type mixed Arabic/English (digits, brackets, percent), save, reopen, edit again; print; measure box alignment vs the printed grid.
6. OCR: run on the scanned form; record labels found vs missing; confirm OCR never changes the master.
7. Association: each completed form linked to the right employee + one training, competency, authorization and quality record; visible from the employee profile.
8. Backup/restore (.json, .sqlite, Access): completed forms and their master references restored intact.
9. Permissions: staff role cannot edit others' forms; audit trail entries exist for create/edit/save/print/export.
10. Existing features (Training Forms, Document Templates, Print Center, competency, WADA updates, backups) still work.
