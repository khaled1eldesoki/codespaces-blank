# Electron integration scripts (NOT part of `npm test`)
Run the real app/monitor inside Electron. **DANGER: main.js stores data in the app's fixed data folder (`%APPDATA%\EDCL Lab System` on Windows,
`$XDG_CONFIG_HOME/EDCL Lab System` on Linux). Never run these on a PC that holds real lab data.** Isolate first:
- Linux: `export XDG_CONFIG_HOME=/tmp/edcl-test-config`
- Windows (PowerShell): `$env:APPDATA = "$env:TEMP\edcl-test-appdata"`
The exe's runtime is **Electron 35.7.5 / Chrome 134**; install the same for tests OUTSIDE the project (project .npmrc disables install scripts, Electron needs them): `mkdir ../electron35 && cd ../electron35 && npm init -y && npm i electron@35.7.5`, then run `../electron35/node_modules/.bin/electron ...` from the project root with `NODE_PATH=$PWD/node_modules`.
Linux sandbox needs a virtual display (headless ozone crashed Electron 35 with SIGSEGV): `xvfb-run -a npx electron --no-sandbox --disable-gpu <script>`.
Env: `APP_ROOT` = project root (default cwd), `MAINJS` = path to a packaged `app.asar/main.js`, `PHASE=1|2` for form.js.
- h.js: WADA monitor scenarios over Electron's net.fetch against a local mock server (expects 8 `ok` lines).
- ipc-smoke.js: real app + preload; `check()` over IPC; with no internet expect `failed`, DNS error, action text (this proves failures are reported, not success).
- form.js: PHASE=1 creates/saves an FO127 form and prints the window to `/tmp/el/form.pdf` (path is hard-coded in the script); PHASE=2 after restart. The "reopen" step in PHASE 2 is not reliable in this harness.
- asm.js: prints a competency evaluation through the `pdf` bridge (writes `/tmp/el/assess.pdf`).
