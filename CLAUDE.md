# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
- Build: `npm run build`
- Dev Server: `npm run dev`
- Start Prod Server: `npm run start`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`
- Lint Fix: `npm run lint:fix`
- Static export for the native app: `npm run build:export` (→ `out/`); `npm run cap:sync` also copies it into `ios/` and `android/`; `npm run ios` opens Xcode, `npm run android` Android Studio

### Testing
- Unit Tests (Vitest): `npm run test`
- Run single test: `npx vitest run path/to/test.ts`
- Live LLM Tests: `npm run test:live` — `*.live.test.ts` files against real providers; keys from gitignored `.env.test.local` (template: `.env.example`) or the `CUSTOM_LLM_KEY` CI secret; never put keys in `NEXT_PUBLIC_*` vars
- E2E Tests (Playwright): `npm run e2e` (`next dev`); against the production build: `npm run build && E2E_SERVER=prod npm run e2e`; another port: `E2E_BASE_URL=http://localhost:3100`
- DB Tests (pgTAP, Docker): `npx supabase start` then `npx supabase test db`
- E2E Tests UI: `npm run e2e:ui`
- E2E Tests Headed: `npm run e2e:headed`
- iOS Simulator Helper: `npm run sim`

### Claude Code Commands
- `/submit`: Automated process to branch, commit, push, create PR, monitor CI, and merge.

## Architecture

QuickScan is a mobile-first Progressive Web App (PWA) built with Next.js 16 (App Router) that performs all document scanning and processing entirely client-side.

### High-Level Structure
- `src/app/`: Next.js App Router pages.
    - `/scan`: Camera capture and scanning interface.
    - `/doc/[id]`: Document viewing, OCR text, annotation, and PDF export.
    - `/settings`: OCR languages and document naming / LLM configuration.
    - `/`: Home page showing the document gallery.
- `src/components/`: UI components categorized by feature (camera, documents, ui).
- `src/lib/`: Core business logic and utilities.
    - `db.ts`: IndexedDB schema management via Dexie.js.
    - `sync-tracking.ts` / `outbox.ts`: Change tracking for cloud sync. A Dexie middleware records every create/update/delete of a synced record (documents, pages, folders, signatures, the `ocrLanguages` setting) in the `outbox` table, one coalesced entry per record, with deletes as tombstones; it also bumps `page.updatedAt`. Writes that touch only local-only fields (`TRACKED_TABLES[...].localOnly`: document `thumbnailBlob` and the derived `searchText`/`pageCount`; page `originalBlob`, `ocrStatus`, `keepOrientation`) queue nothing and bump no clock. `outbox.ts` has the sync engine's API (`readOutbox`, `ackOutbox`, `applyUntracked` for pulled writes, `getDeviceId`).
    - `sync/`: The sync engine. `engine.ts` is one run (account check → upload changed files → push the outbox via `upsert_records` → ack → pull by `seq` cursor, applied with `applyUntracked` → renumber pages / recompute `pageCount` and `searchText` → download missing images); `runner.ts` gates it (Supabase configured, signed in, vault key owned by this user), runs it under the `quickscan-sync` Web Lock and wires the triggers (start, focus, online, 5 s after a local change, every 5 min, `quickscan:vault-changed`); `requestSync()` asks for a run; `status.ts` is the store behind `useSyncStatus` (`disabled | idle | syncing | offline | locked | error`), shown by `SyncIndicator` in the gallery header. `payload.ts` defines what each kind syncs; `state.ts` keeps cursors and record → remote file mappings in `syncMeta`. `SyncRunner` in the root layout starts it.
    - `page-image.ts`: A page's image (`processedBlob`, else `originalBlob`); pages pulled from another device have no original and no image until it downloads.
    - `crypto/`: End-to-end encryption for sync, WebCrypto only, no network. One AES-256-GCM vault key per user, stored on the device as a non-extractable `CryptoKey` (`vault.ts`); `encryptRecord`/`encryptFile` bind each ciphertext to user + record/file id via AAD; `wrap.ts` wraps the vault key with a high-entropy secret (HKDF) for the server, the recovery key (`recovery-key.ts`, 28 Crockford base32 chars with a checksum) being one; `pairing.ts` seals it to a new device (ECDH P-256). Byte layouts are documented in each file.
    - `camera.ts`: Media device access (`getUserMedia`).
    - `pdf.ts`: PDF generation using `pdf-lib`.
    - `image-processing.ts`: Canvas-based image filters and transformations.
    - `scanner.worker.ts`: Web Worker for computationally expensive edge detection (jscanify/OpenCV.js).
    - `ocr.ts` / `ocr-queue.ts`: Tesseract.js OCR; `platform/ocr.ts` picks the engine per page (`OcrProvider`): Apple Vision through the `capacitor-native-ocr` plugin inside the iOS app (`platform/native/ocr.ts`) when it reads every OCR language, otherwise Tesseract, which is also the fallback when Vision fails; pages with `ocrStatus: 'pending'` are processed in the background (`OcrRunner` in the root layout); Tesseract and the orientation probes get a copy no larger than 2500 px on its long side (`OCR_MAX_DIMENSION`; word boxes are mapped back to the page image), since full-size images in the OCR worker ran iOS Safari out of memory; pages whose first pass is under 60 % confidence are retried at 180/90/270° and stored upright (`ocr-orientation.ts`), only on the first recognition of this device's own capture — never on a page with `keepOrientation` (turned by hand, re-queued, or its image downloaded from another device). Vision reports the page's rotation itself (`uprightRotation`, no extra passes), so on Vision pages the probe isn't run and the page is turned when it has at least 20 letters or digits.
    - `import.ts`: Image upload from the gallery (JPEG/PNG/WebP/HEIC) — one document per file, queued for OCR; progress is a module-level store read via `useImportState`.
    - `llm/`: Shared LLM client (`client.ts`: OpenAI, Anthropic, Google, or custom Chat Completions / Anthropic Messages endpoints; text and image input), endpoint detection, image downscaling for vision input, and the naming prompt.
    - `naming/`: Document naming from OCR text — on-device heuristics, or the configured LLM via `llm/naming.ts`.
    - `annotations/`: Annotation geometry, canvas rendering and flattening onto page images.
    - `db-status.ts`: Whether IndexedDB opened (blocked upgrade, newer version in another tab, error), shown full screen by `DatabaseGate` in the root layout instead of an endless "Loading...".
    - `settings.ts`: App settings stored in the Dexie `settings` table.
    - `folders.ts` / `tags.ts`: Flat folders (Dexie `folders` table, referenced by `document.folderId`) and free-form tags stored on each document (`document.tags`); deleting a folder unfiles its documents, renaming/deleting a tag rewrites every document carrying it.
    - `document-filter.ts`: Pure gallery filtering by folder, tags (all must match) and search text.
    - `dialogs.ts`: `confirmDialog` / `alertDialog` / `promptDialog`, rendered by `DialogHost` in the root layout.
    - `supabase.ts` / `auth.ts`: Optional Supabase client (lazy, only when `NEXT_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY` are set) and the auth store read via `useAuth` — passwordless sign-in with an emailed one-time code; the Account section in `/settings`.
    - `vault-session.ts`: Whether this device holds the sync vault key (`useVault`: `disabled | signed-out | checking | no-vault | locked | unlocked | error`) and the vault flows behind the Sync area in `/settings` — turn on sync (recovery key shown once, `vault_keys` row 'recovery'), unlock with the recovery key, replace the recovery key, and `unlockWithPairedKey` for QR pairing and passkeys. Every unlock/creation/clear dispatches `quickscan:vault-changed` on `window`; sign-out forgets the key. `bytea.ts`: `\x`-hex encoding for `bytea` columns via PostgREST.
    - `passkeys.ts`: passkeys as an extra unlock method via the WebAuthn PRF extension. `addPasskey` creates with `prf.eval` and, when iOS/Safari return no PRF results at create, follows up with a `get`; nothing is saved without PRF. `unlockWithPasskey` uses `evalByCredential` with each row's own salt. Also list, rename and remove. The `vault_keys` row id is the credential id, and `params` holds the wrap params plus `prfSalt`, `credentialId` and `rpId`. UI in `components/settings/PasskeySettings.tsx`.
    - `pairing-code.ts` / `pairing-session.ts` / `qr.ts`: QR pairing ("Scan from another device" on a locked device, "Add a device" on an unlocked one). QR text `qs1:<requestId>:<P-256 public key, base64url>` parsed strictly; `PairingRequest` (new device: key pair in memory, `pairing_requests` row, polls every 2 s for 5 min) and `sendVaultKeyToDevice` (unlocked device: seals the vault key; the update must hit exactly one row of the caller's account, which defeats someone else's QR code). QR drawn with `uqr`, read with `BarcodeDetector` or `jsqr` (iOS Safari), both lazy-loaded. UI in `components/settings/ShowPairingCode.tsx` / `ScanPairingCode.tsx`.
- `src/hooks/`: Shared React hooks for camera, database, and document state.
- `bench/`: The scanner benchmark corpus and its tools (`docs/scanner-data-plan.md`, `.claude/skills/scanner-bench/SKILL.md`). `corpus/manifest.json` lists every case; `npm run bench:pages` prints test pages with exact OCR text, `npm run bench:synth` regenerates the synthetic cases from a seed, `npm run bench:fetch -- --sample <set>` samples the public datasets, `npm run bench:validate` checks the manifest. Owner clips stay in `tests/fixtures/camera/private/` (ignored by version control) and enter the corpus as private cases.
- `ios/`: Capacitor 8 iOS shell (Swift Package Manager) around the static export, M0 spike of the native migration (`docs/native/m0-spike.md`). `scripts/build-export.mjs` builds with `NEXT_PUBLIC_BUILD_TARGET=export`, parking the server-only files (`proxy.ts`, `app/api`, `app/doc/[id]`); documents use `/doc?id=` there, so link with `docHref()` from `lib/routes.ts`. `MainViewController.swift` routes `/scan` to `scan.html` (Capacitor's default router serves `index.html` for every extensionless path). The export can't use the proxy's nonce CSP, so `scripts/export-csp.mjs` puts a `<meta>` CSP with the hashes of each page's inline scripts into every exported page (`buildExportCsp` in `lib/csp.ts`). The build fails if an inline script is missing its hash.
- `supabase/`: CLI config, `migrations/` (applied to production on merge to `main`) and pgTAP tests in `tests/` (`npx supabase start`, then `npx supabase test db`; CI workflow `supabase.yml`). Sync schema: `records` (encrypted, LWW via `upsert_records`, pulled by `seq`), `vault_keys`, `pairing_requests`, private Storage bucket `vault`.

### Key Technical Decisions
- **Local-First**: All data is stored in IndexedDB via Dexie.js and the app works fully without an account. The only server code is `/api/llm`, a stateless pass-through for LLM providers without CORS support (allowlisted in `PROXIED_HOSTS`), and `src/proxy.ts`, which sets the per-request nonce CSP. Supabase (Auth and end-to-end-encrypted sync) is optional and talked to directly from the client; authorization lives in row-level security, and only the publishable key may ship to the client.
- **Edge Detection**: Uses a Web Worker to prevent UI blocking during OpenCV.js processing.
- **PWA**: Installable via the web app manifest ("Add to Home Screen"). There is no service worker yet (`@serwist/next` is not installed), so pages need the network to load; all data still lives in IndexedDB.
- **PDF Export**: Multi-page PDFs are generated on the client using `pdf-lib`, with annotations flattened into the page images and an invisible OCR text layer.
- **Folders & Tags**: Local only for now, but sync-ready: string (nanoid) ids, `createdAt`/`updatedAt` on folders, every change bumps the document's `updatedAt`, and the tag list is never stored separately (it's derived from documents). A `folderId` pointing at a missing folder counts as unfiled.
- **Security headers / CSP**: Built in `lib/csp.ts`. Documents get a nonce CSP from `src/proxy.ts`, so pages render per request (root layout is `force-dynamic`). Workers get a static policy with `'wasm-unsafe-eval'` from `next.config.ts`. The static export gets a hash-based `<meta>` policy instead (`scripts/export-csp.mjs`), and its workers get none. Tesseract's worker and cores are self-hosted in `public/tesseract/` (copied by `scripts/copy-tesseract.mjs` before dev/build). Rationale in `SECURITY.md`.
- **Annotations**: Stored as vector data on each page (coordinates normalized 0..1), separate from the image, so they stay editable.
