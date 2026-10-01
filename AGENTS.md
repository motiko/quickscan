# AGENTS.md — QuickScan

Guidelines for AI agents working on this codebase.

## Project Overview

QuickScan is a **mobile-first PWA** for scanning documents using the phone camera. It is built with **Next.js 16 (App Router)** and runs **entirely client-side** — no backend server, no database, no API keys. All document storage uses **IndexedDB** via Dexie.js.

## Architecture Principles

### Client-Side First
- **No server-side state.** Everything runs in the browser. Pages are static or client-rendered.
- **IndexedDB is the database.** Use Dexie.js for all persistent storage. Store binary data as `Blob` objects, never as Base64 strings.
- **Web Workers for heavy computation.** All OpenCV.js / image processing runs in Web Workers to keep the UI thread responsive.

### Mobile-First
- **Design for phones first.** Touch targets ≥ 44px. Bottom-sheet patterns for actions. Thumb-zone-friendly layouts.
- **Performance budgets matter.** Every KB counts on mobile. Lazy-load heavy dependencies (OpenCV.js, pdf-lib). Use dynamic imports.
- **Test on real devices.** Chrome DevTools mobile emulation misses real camera, touch, and performance behaviors.

### Progressive Enhancement
- **Core flow works offline.** Scanning, saving, and exporting PDFs must work without network.
- **Graceful degradation on iOS Safari.** No `ImageCapture` API, no torch, no `beforeinstallprompt`. Always feature-detect before using browser APIs.

## Tech Stack & Conventions

### Framework
- **Next.js 16** with App Router (`src/app/`)
- **React 19** with hooks and Server Components where applicable
- **TypeScript** — strict mode, no `any` unless absolutely necessary

### Styling
- **Tailwind CSS 4** — utility-first, no custom CSS unless truly needed
- **shadcn/ui** — for accessible UI primitives (Dialog, Sheet, Button, etc.)
- **No CSS-in-JS** — no styled-components, Emotion, etc.

### State Management
- **React hooks + Dexie `useLiveQuery`** for reactive data from IndexedDB
- **No global state library** (no Redux, Zustand, etc.) — component state + context is sufficient for v1
- If complex state is needed later, prefer Zustand

### File Organization
```
src/
├── app/           # Route segments (pages + layouts)
├── components/    # React components grouped by feature
│   ├── camera/    # Camera-related components
│   ├── documents/ # Document gallery components
│   └── ui/        # shadcn/ui primitives
├── lib/           # Pure utilities, no React
│   ├── db.ts      # Dexie schema (single source of truth for data model)
│   ├── camera.ts  # getUserMedia wrapper
│   ├── pdf.ts     # pdf-lib helpers
│   └── *.worker.ts # Web Workers
├── hooks/         # Custom React hooks
└── types/         # Shared TypeScript types
```

### Naming Conventions
- **Files:** `kebab-case.ts` for utilities, `PascalCase.tsx` for React components
- **Components:** PascalCase (`CameraView`, `DocumentCard`)
- **Hooks:** `use` prefix, camelCase (`useCamera`, `useDocuments`)
- **Types/Interfaces:** PascalCase, no `I` prefix (`Document`, `Page`, not `IDocument`)
- **Constants:** `UPPER_SNAKE_CASE`

## Data Model

The IndexedDB schema is defined in `src/lib/db.ts`. Key entities:

### Document
```typescript
{
  id: string;          // nanoid
  name: string;        // user-editable title
  createdAt: Date;
  updatedAt: Date;
  pageCount: number;
  thumbnailBlob: Blob; // small JPEG thumbnail of first page
}
```

### Page
```typescript
{
  id: string;          // nanoid
  documentId: string;  // FK → Document.id
  pageNumber: number;  // ordering
  originalBlob: Blob;  // raw capture
  processedBlob: Blob; // after crop + filter
  corners: [Point, Point, Point, Point];
  filter: 'original' | 'grayscale' | 'bw';
  createdAt: Date;
}
```

> **Important:** Always store images as `Blob` objects in IndexedDB, never as Base64 strings. Base64 adds 33% size overhead and causes GC spikes on mobile.

## Key Libraries

| Library | Purpose | Import Pattern |
|:---|:---|:---|
| `dexie` + `dexie-react-hooks` | IndexedDB storage | Static import in `lib/db.ts` |
| `pdf-lib` | PDF generation | **Dynamic import** — only load when exporting |
| `jscanify` / OpenCV.js | Edge detection | **Web Worker** — never import on main thread |
| `@serwist/next` | Service worker / PWA | Build-time config in `next.config.ts` |
| `nanoid` | Generate unique IDs | Static import where needed |

### Dynamic Import Pattern
```typescript
// ✅ Good — lazy load heavy libs
const generatePdf = async (pages: Page[]) => {
  const { PDFDocument } = await import('pdf-lib');
  // ...
};

// ❌ Bad — bloats initial bundle
import { PDFDocument } from 'pdf-lib';
```

## Browser API Usage

### Camera (`getUserMedia`)
```typescript
// Always feature-detect
if (!navigator.mediaDevices?.getUserMedia) {
  // Fall back to <input type="file" capture="environment">
}

// Preferred constraints for document scanning
const constraints = {
  video: {
    facingMode: { ideal: 'environment' },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
  },
};
```

### iOS Safari Gotchas
- **No `ImageCapture` API** — use Canvas `drawImage()` for frame capture
- **No torch/flash** — hide the flash button via feature detection
- **No `beforeinstallprompt`** — show manual "Add to Home Screen" instructions
- **7-day IndexedDB eviction** — mitigated when installed as PWA; call `navigator.storage.persist()`
- **`<video>` must have `playsinline` attribute** — or iOS will open fullscreen player

## Testing

- **Unit tests:** Vitest for utilities in `lib/`
- **Component tests:** React Testing Library
- **No E2E tests in v1** — camera APIs are hard to mock in headless browsers

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add document gallery with thumbnails
fix: camera not releasing on page navigation
refactor: extract crop logic into useCrop hook
docs: update README with deployment instructions
chore: add GitHub Actions CI workflow
```

## CI Pipeline

GitHub Actions runs on every push/PR to `main`:
1. `npm run lint` — ESLint
2. `npm run typecheck` — TypeScript compiler
3. `npm run test -- --passWithNoTests` — Vitest
4. `npm run build` — Next.js production build

All checks must pass before merging.

## Deployment

- **Hosting:** Vercel (auto-deploys from `main`, preview URLs on PRs)
- **HTTPS:** Required for camera access — Vercel provides this automatically
- **Environment:** No env vars needed for v1 (fully client-side)
