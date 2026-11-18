# Rollback procedures
**Principle:** nothing in a new build deletes or rewrites existing records in place; new data goes in new tables/columns. Roll back by restoring a data backup taken BEFORE the upgrade and starting the previous build.

## Before every upgrade (mandatory)
1. Close the application. 2. Run `tools/backup-userdata.ps1` (UNTESTED on Windows) or copy `%APPDATA%\EDCL Lab System` manually to a safe place. 3. In the OLD build use Backup page > "Backup both" and download the JSON backup. 4. Record SHA-256 of the copies.

## What changes on disk in 1.0.14
- `wada-monitor.sqlite` (in the data folder) migrates from user_version 1 to 2 by `ALTER TABLE ... ADD COLUMN` only (additive). Tested: a v1 database with items, notifications and preferences keeps all rows after migration (test E3 in `tests/wada-monitor.test.js`).
- The in-app data object (IndexedDB) gains arrays when missing (`ensureComp`: CompDefs, CompCriteria, CompReq, CompAssess, CompResults, CompEvidence, CompHistory, DocMeta) and the permission `assess`. Existing arrays are untouched.

## Rollback steps
1. Close the app. 2. Rename the current data folder to `EDCL Lab System.failed-<date>`. 3. Expand the pre-upgrade copy to `%APPDATA%\EDCL Lab System`. 4. Start the previous portable build (for 1.0.9: the lab's original `EDCL-Lab-System-windows-portable-v1_0_9.zip`). 5. Check employees, training, authorizations, documents, audit trail counts against the numbers noted before the upgrade.
- Alternative (data only): in the running app, Backup page > Restore from the JSON/SQLite backup (owner account only).
## Verified vs not
- VERIFIED (automated, Linux): JSON backup and `.sqlite` backup restore bring back all competency tables and uploaded files byte-identically (tests 7.4 in `tests/competency-persistence.test.js`); WADA DB v1 to v2 migration keeps data.
- NOT VERIFIED: any restore on Windows; Access (.accdb) creation/reading; downgrade of a v2 `wada-monitor.sqlite` by an older app version (the safe path is to restore the pre-upgrade copy); `tools/backup-userdata.ps1`.
