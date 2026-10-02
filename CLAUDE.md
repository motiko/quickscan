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
    - `/doc/[id]`: Document viewing and PDF export.
    - `/`: Home page showing the document gallery.
- `src/components/`: UI components categorized by feature (camera, documents, ui).
- `src/lib/`: Core business logic and utilities.
    - `db.ts`: IndexedDB schema management via Dexie.js.
    - `camera.ts`: Media device access (`getUserMedia`).
    - `pdf.ts`: PDF generation using `pdf-lib`.
    - `image-processing.ts`: Canvas-based image filters and transformations.
    - `scanner.worker.ts`: Web Worker for computationally expensive edge detection (jscanify/OpenCV.js).
- `src/hooks/`: Shared React hooks for camera, database, and document state.

### Key Technical Decisions
- **Client-Side Only**: No backend; all data is stored in IndexedDB via Dexie.js.
- **Edge Detection**: Uses a Web Worker to prevent UI blocking during OpenCV.js processing.
- **PWA**: Implemented via `@serwist/next` for offline-first capabilities and "Add to Home Screen" experience.
- **PDF Export**: Multi-page PDFs are generated on the client using `pdf-lib`.
