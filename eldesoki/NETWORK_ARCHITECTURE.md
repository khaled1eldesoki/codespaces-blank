# Network architecture

```
 Workstation (EDCL app, Electron)            Central server PC
 ┌────────────────────────────┐   HTTPS/TLS   ┌────────────────────────────────────┐
 │ UI (index.html)            │   8443/TCP    │ Node 22 service "EDCL Server"      │
 │ sync engine (record-level) │──────────────▶│  /api/login /sync /push /files ... │
 │ main process: all network  │  CA-pinned    │  SQLite (WAL) edcl-central.sqlite  │
 │ calls, session token       │               │  files/<sha256> (documents)        │
 │ local WADA monitor ─ ─ ─ ─ ┼─▶ internet    │  backups\ (+ files mirror)         │
 └────────────────────────────┘  (optional)   │  optional WADA feed (needs inet)   │
                                              └────────────────────────────────────┘
```
- **One database.** All clients read/write the same records. Each record has a revision; a save carries the revision it was based on. Different fields edited at the same time are merged; the same field edited at the same time is **refused** (the other person's value is kept, the user is told and can re-apply theirs); deletes never silently remove someone else's newer edit. Every conflict is written to the server audit log.
- **Live updates.** Server-sent events nudge clients; clients also poll every 8 s. Unsent edits are retried automatically when the server is reachable again (status badge shows "Server unreachable"); closing the app flushes pending edits.
- **Authentication.** Server-side accounts, scrypt password hashes, lockout, idle/absolute session expiry, password ≥ 10 characters, forced change on first use. Passwords/hashes are never stored in shared records.
- **Ports/firewall.** Inbound TCP 8443 on the server (private/domain profiles only). Clients need outbound access to that one port. No inbound ports on clients. No internet needed for any internal function.
- **Addressing.** Use a DNS/hosts name (`edcl-server`) whenever possible; the address is configuration (`ProgramData\EDCL Lab System\client\server.json`, or the sign-in screen), never compiled into the app.
- **WADA monitor / internet.** Each workstation keeps its own monitor (history in its local SQLite). With internet it checks sources; without, it records a failed check with the reason and the app works normally. Results merged into the shared News list are stored on the server, so previously synchronized information stays available to everyone; when a PC regains internet, the monitor resumes by its schedule. The server can also check by itself (`wadaHours` in server.json) if the server PC has internet.
