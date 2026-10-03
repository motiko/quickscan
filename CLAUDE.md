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

### Testing
- Unit Tests (Vitest): `npm run test`
- Run single test: `npx vitest run path/to/test.ts`
- Live LLM Tests: `npm run test:live` — `*.live.test.ts` files against real providers; keys from gitignored `.env.test.local` (template: `.env.example`) or the `CUSTOM_LLM_KEY` CI secret; never put keys in `NEXT_PUBLIC_*` vars
- E2E Tests (Playwright): `npm run e2e`
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
    - `sync-tracking.ts` / `outbox.ts`: Groundwork for cloud sync, no network yet. A Dexie middleware records every create/update/delete of a synced record (documents, pages, folders, signatures, the `ocrLanguages` setting) in the `outbox` table, one coalesced entry per record, with deletes as tombstones; it also bumps `page.updatedAt`. `outbox.ts` has the sync engine's API (`readOutbox`, `ackOutbox`, `applyUntracked` for pulled writes, `getDeviceId`).
    - `camera.ts`: Media device access (`getUserMedia`).
    - `pdf.ts`: PDF generation using `pdf-lib`.
    - `image-processing.ts`: Canvas-based image filters and transformations.
    - `scanner.worker.ts`: Web Worker for computationally expensive edge detection (jscanify/OpenCV.js).
    - `ocr.ts` / `ocr-queue.ts`: Tesseract.js OCR; pages with `ocrStatus: 'pending'` are processed in the background (`OcrRunner` in the root layout).
    - `import.ts`: Image upload from the gallery (JPEG/PNG/WebP/HEIC) — one document per file, queued for OCR; progress is a module-level store read via `useImportState`.
    - `llm/`: Shared LLM client (`client.ts`: OpenAI, Anthropic, Google, or custom Chat Completions / Anthropic Messages endpoints; text and image input), endpoint detection, image downscaling for vision input, and the naming prompt.
    - `naming/`: Document naming from OCR text — on-device heuristics, or the configured LLM via `llm/naming.ts`.
    - `annotations/`: Annotation geometry, canvas rendering and flattening onto page images.
    - `settings.ts`: App settings stored in the Dexie `settings` table.
    - `folders.ts` / `tags.ts`: Flat folders (Dexie `folders` table, referenced by `document.folderId`) and free-form tags stored on each document (`document.tags`); deleting a folder unfiles its documents, renaming/deleting a tag rewrites every document carrying it.
    - `document-filter.ts`: Pure gallery filtering by folder, tags (all must match) and search text.
    - `dialogs.ts`: `confirmDialog` / `alertDialog` / `promptDialog`, rendered by `DialogHost` in the root layout.
    - `supabase.ts` / `auth.ts`: Optional Supabase client (lazy, only when `NEXT_PUBLIC_SUPABASE_URL`/`_PUBLISHABLE_KEY` are set) and the auth store read via `useAuth` — passwordless sign-in with an emailed one-time code; the Account section in `/settings`.
- `src/hooks/`: Shared React hooks for camera, database, and document state.

### Key Technical Decisions
- **Local-First**: All data is stored in IndexedDB via Dexie.js and the app works fully without an account. The only server code is `/api/llm`, a stateless pass-through for LLM providers without CORS support (allowlisted in `PROXIED_HOSTS`). Supabase (Auth now, sync later) is optional and talked to directly from the client; authorization lives in row-level security, and only the publishable key may ship to the client.
- **Edge Detection**: Uses a Web Worker to prevent UI blocking during OpenCV.js processing.
- **PWA**: Implemented via `@serwist/next` for offline-first capabilities and "Add to Home Screen" experience.
- **PDF Export**: Multi-page PDFs are generated on the client using `pdf-lib`, with annotations flattened into the page images and an invisible OCR text layer.
- **Folders & Tags**: Local only for now, but sync-ready: string (nanoid) ids, `createdAt`/`updatedAt` on folders, every change bumps the document's `updatedAt`, and the tag list is never stored separately (it's derived from documents). A `folderId` pointing at a missing folder counts as unfiled.
- **Annotations**: Stored as vector data on each page (coordinates normalized 0..1), separate from the image, so they stay editable.
