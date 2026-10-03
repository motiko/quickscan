# AGENTS.md — QuickScan

Guidelines for AI agents working on this codebase.

## ⚠️ STRICT RULE: Never Push Directly to `main`

> **CRITICAL:** AI agents must **NEVER** push commits directly to `main` unless directly and explicitly instructed by the user. Branch protection is enforced on `main` in GitHub.

### Required Flow for All Changes
All changes must go through the Pull Request flow:
1. **Create a feature branch:**
   ```bash
   git checkout -b <type>/<short-description>
   ```
2. **Make changes and commit** adhering to [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "<type>: <description>"
   ```
3. **Push to remote:**
   ```bash
   git push -u origin <branch-name>
   ```
4. **Create a Pull Request using `gh` CLI:**
   ```bash
   gh pr create --title "<type>: <description>" --body "<summary of changes>"
   ```
5. **Watch and verify build & CI jobs pass:**
   ```bash
   gh pr checks --watch
   ```
   Do not merge if any CI/build checks fail; resolve errors on the branch, commit, and push until checks pass.
6. **Merge the Pull Request via `gh` CLI:**
   ```bash
   gh pr merge --squash --delete-branch
   ```
7. **Switch back and pull latest `main`:**
   ```bash
   git checkout main
   git pull origin main
   ```
   In a git worktree `main` is checked out in the main checkout, so run both there instead:
   ```bash
   MAIN_DIR="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"
   git -C "$MAIN_DIR" checkout main
   git -C "$MAIN_DIR" pull origin main
   ```


## Project Overview

QuickScan is a **mobile-first PWA** for scanning documents using the phone camera. It is built with **Next.js 16 (App Router)** and is **local-first** — all document storage uses **IndexedDB** via Dexie.js and the app is fully usable without an account or network. The only backend is **Supabase** (Auth now; Postgres + Storage for sync later), and it is optional: builds without Supabase env vars hide every account feature.

## Architecture Principles

### Client-Side First
- **No server-side state in Next.js.** Everything runs in the browser. Pages are static or client-rendered. The only route handler is the stateless `/api/llm` proxy; don't add Next.js API routes for app data — talk to Supabase from the client instead.
- **IndexedDB is the database.** Use Dexie.js for all persistent storage. Store binary data as `Blob` objects, never as Base64 strings. Supabase (when it arrives for sync) is a replica, never the source the UI reads from.

### Accounts & Supabase
- **Optional, always.** Check `isSupabaseConfigured()` / `useAuth().status === 'disabled'` and render nothing account-related when it's off. Scanning, OCR, export and everything local must never require signing in.
- **One client:** get it from `getSupabase()` in `src/lib/supabase.ts` (lazy-loaded, never imported statically). Auth state lives in `src/lib/auth.ts` and is read via `useAuth()`.
- **Sign-in is an emailed one-time code**, not a magic link: an installed iOS PWA has its own storage, separate from Safari, so links sign in the wrong place. Keep `detectSessionInUrl: false`.
- **Keys:** only the publishable key (`sb_publishable_…`) goes in `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; don't use the legacy `anon` JWT. Secret keys (`sb_secret_…`) and the legacy `service_role` key must never appear in this repo, the client bundle or Vercel env. Authorization is enforced by row-level security — every table and storage bucket gets RLS policies scoped to `auth.uid()` in the same change that creates it.
- **Schema changes are migrations** in `supabase/migrations/`, applied by the Supabase GitHub integration on merge to `main`. The project doesn't auto-expose new tables, so each `create table` migration also grants the `authenticated` role exactly the operations it needs (`grant select, insert, update, delete on public.<table> to authenticated;`) — never grant to `anon`. Automatic RLS is on, but still write `alter table … enable row level security` explicitly.
- **Database functions** use `set search_path = ''` (schema-qualify everything) and are `security invoker` so RLS applies; `security definer` only when unavoidable (e.g. the trigger that draws `records.seq` from a sequence no API role may touch), never with input-driven queries, and only touching `auth.uid()`'s rows. Postgres grants EXECUTE to PUBLIC by default, so every function gets `revoke execute … from public, anon` and, if callable, `grant execute … to authenticated`.
- **Every migration gets pgTAP tests** in `supabase/tests/` (two users, `anon`, each policy and constraint): `npx supabase start` (Docker, local only) then `npx supabase test db`. Never `supabase link`/`db push` — merging is what deploys.
- **End-to-end encrypted:** all synced payloads and files are encrypted on the device with `src/lib/crypto` before they leave it. Never send plaintext user content, keys or the recovery key to Supabase (or log them), never derive keys from the emailed sign-in code, and never roll your own primitives beyond WebCrypto.
- **Vault state:** read it with `useVault()` / `getVaultStatus()` from `src/lib/vault-session.ts`, and listen for the `quickscan:vault-changed` window event (dispatched on every unlock, creation and clear) rather than polling. The recovery key lives only in component state while its dialog is open. Sign-out (`signOut` in `auth.ts`) forgets the vault key on the device; documents stay.
- **`bytea` via PostgREST** is `'\x' + hex` both ways — use `toBytea`/`fromBytea` from `src/lib/bytea.ts`. Plain hex or a `Uint8Array` is silently stored as the wrong bytes.
- **Sync-friendly data:** new Dexie records use client-generated string IDs and `createdAt`/`updatedAt`, so they can be replicated later without migrations. Local changes to synced tables are recorded in the `outbox` automatically (see Data Model); a new synced table or local-only field goes in `TRACKED_TABLES` in `lib/sync-tracking.ts`.
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

### Dialogs & Overlays
- **Never use `window.alert`, `window.confirm` or `window.prompt`.** Use `confirmDialog()` / `alertDialog()` / `promptDialog()` from `src/lib/dialogs.ts` (rendered by `<DialogHost>` in the root layout). Give the dialog a question as `title`, the consequence as `message`, a verb as `confirmLabel` ("Delete", "Re-run", not "OK"), and `destructive: true` for deleting/discarding.
- **Escape closes every layer.** Any overlay, sheet, modal, full-screen viewer or mode (camera, crop, annotation editor, …) must close on Escape via `useEscape(onClose)` from `src/hooks/useEscape.ts`, calling the same handler as its close/cancel button (including any discard confirmation). Layers stack, so Escape only closes the topmost one; call the hook in the component that renders the layer.
- **Inputs that handle Escape themselves** (cancelling an inline edit) must call `e.preventDefault()` so the layer underneath stays open.

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
  folderId?: string;   // FK → Folder.id; absent (or a deleted folder) = unfiled
  tags?: string[];     // free-form, normalized, sorted; see lib/tags.ts
}
```

### Folder
```typescript
{
  id: string;          // nanoid
  name: string;        // unique (case-insensitive)
  createdAt: Date;
  updatedAt: Date;
}
```
Folders are flat. Deleting a folder keeps its documents and unfiles them.

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
  updatedAt: Date;     // stamped automatically by the sync tracking on every synced change
}
```

### Sync bookkeeping (no network yet)
- `outbox` — one pending change per synced record, keyed `[kind+id]` (`kind`: document, page, folder, signature, settings): `op` `'upsert' | 'delete'`, `updatedAt` (epoch ms of the latest local write — the last-write-wins clock), `fileChanged`, `rev`. A `'delete'` entry is the tombstone. Filled by the `syncTrackingMiddleware` in `lib/sync-tracking.ts` for **every** write in any read-write transaction — don't enqueue by hand. Writes that only touch local-only fields (thumbnails, `originalBlob`, `ocrStatus`) and settings other than `ocrLanguages` aren't recorded.
- `syncMeta` — device-local sync state (device id); never syncs.
- `lib/outbox.ts` is the API for the sync engine: `readOutbox`, `getOutboxEntry`, `ackOutbox`, `applyUntracked` (writes pulled remote changes without re-queueing them), `getDeviceId`.

> **Important:** Always store images as `Blob` objects in IndexedDB, never as Base64 strings. Base64 adds 33% size overhead and causes GC spikes on mobile.

## Key Libraries

| Library | Purpose | Import Pattern |
|:---|:---|:---|
| `dexie` + `dexie-react-hooks` | IndexedDB storage | Static import in `lib/db.ts` |
| `pdf-lib` | PDF generation | **Dynamic import** — only load when exporting |
| `jscanify` / OpenCV.js | Edge detection | **Web Worker** — never import on main thread |
| `@serwist/next` | Service worker / PWA | Build-time config in `next.config.ts` |
| `nanoid` | Generate unique IDs | Static import where needed |
| `@supabase/supabase-js` | Auth (and later sync) | **Dynamic import** — only via `getSupabase()` in `lib/supabase.ts`; type-only imports elsewhere |

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
- **Environment:** None required. Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (Production + Preview) to enable accounts; see "Accounts (Supabase, optional)" in the README for project setup. CI builds without them.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
