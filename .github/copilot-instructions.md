# Validador WhatsApp GUI — Project Guidelines

Electron desktop app that validates phone numbers against WhatsApp in batch, using multiple WhatsApp Web accounts in parallel. See [README.md](../README.md) for end-user docs.

## Build and Test

```bash
npm install      # installs all deps (Electron + whatsapp-web.js + pg)
npm start        # dev mode — opens Electron app directly
npm run dist     # packages into Validador-WhatsApp-win-x64.zip via build/make-dist.js
```

> `asarUnpack` in `package.json` must include `whatsapp-web.js`, `puppeteer-core`, and `@puppeteer` — Puppeteer requires native access at runtime.

## Architecture

Three-process Electron model:

| Process | File | Role |
|---------|------|------|
| Main | `main.js` | Window management, WhatsApp clients (Map), validation loop, DB |
| Preload (main window) | `preload.js` | Exposes `window.waApp` bridge |
| Preload (connect window) | `preload-connect.js` | Exposes `window.waConnect` bridge |
| Preload (banco window) | `preload-banco.js` | Exposes `window.banco` bridge |
| Renderer | `*.html` | UI only — no Node.js access |

`contextIsolation: true` + `nodeIntegration: false` is enforced. All renderer↔main communication goes through `contextBridge`. Never bypass this.

## Conventions

**IPC channel naming:** kebab-case (`get-accounts`, `start-validation`, `validation-progress`).

**Direction matters:**
- Renderer → Main: `ipcRenderer.invoke('channel')` / `ipcMain.handle('channel')`  
- Main → Renderer: `webContents.send('channel', data)` (no reply expected)

**Multi-account round-robin:** `accounts` is a `Map<id, {client, isReady, ...}>`. Use `getNextClient()` to pick the next ready account — do not iterate the Map directly.

**Phone normalization:** All phones normalized to E.164 before lookup: `55` + DDD (2 digits) + number. Strip spaces, dashes, parentheses. Minimum 10 digits (with DDD) after stripping country code.

**Anti-block delays:** Every lookup uses `randBetween(minDelayMs, maxDelayMs)`. After `batchSize` lookups, sleep `batchPauseMs`. Defaults live in `main.js`; UI exposes them as config — do not hardcode new delays.

**DB cache:** PostgreSQL via `pg` (Supabase). Table: `phone_cache(phone PK, has_wa BOOLEAN, checked_at TIMESTAMP)`. DB errors are logged silently — they must never interrupt an active validation run.

**Output files:** Each validation run writes to `output/validados_parcial_<timestamp>/`:
- `.txt` — original lines where phone has WhatsApp (no header)
- `.csv` — full report with all lines and status

## Key Pitfalls

- **`db-config.json` contains plaintext DB credentials** — never commit this file; ensure it is in `.gitignore`.
- **`credentials.json`** — same concern; verify `.gitignore` covers both.
- **whatsapp-web.js breaks on WhatsApp Web updates** — if `getNumberId()` or QR auth stops working, check for a new library version before debugging code.
- **Large input files** are read entirely into memory with `.split(/\r?\n/)` — avoid processing files > 100 MB without streaming.
- **`rrIndex` (round-robin counter)** is a module-level global; avoid introducing parallel validation runs without making it per-run.
