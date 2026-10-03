# 📸 QuickScan

A mobile-first Progressive Web App for scanning documents using your phone's camera. Inspired by GeniusScan — capture, crop, enhance, and export documents as PDFs, entirely client-side.

> **Local-first, no signup required** — your documents stay on your device. An optional account (for upcoming sync between devices) is only offered when the build is configured with a Supabase project.

## ✨ Features (v1)

- **Camera capture** — Open rear camera with live preview, tap to scan
- **Manual crop** — Drag 4-corner handles to precisely crop your document
- **Image filters** — Original, grayscale, and black & white modes
- **Multi-page documents** — Combine multiple scans into a single document
- **PDF export** — Generate and download multi-page PDFs
- **Document gallery** — Browse, rename, and delete saved scans
- **Offline-first** — All data stored locally in IndexedDB, works without internet
- **Installable PWA** — Add to home screen for native app experience
- **Text recognition (OCR)** — On-device Tesseract.js; copy text, search the gallery, and export searchable PDFs
- **Smart naming** — New scans are named from their content (e.g. “Rechnung – Telekom – 2026-09-14”), optionally via any OpenAI-compatible model (OpenRouter, Ollama)
- **Annotation** — Pen, highlighter, rectangles, arrows, text boxes, and a reusable signature
- **Folders & tags** — File documents in folders, tag them freely, and filter the gallery by folder and tags
- **Optional account** — Passwordless sign-in with an emailed code (Supabase Auth), the groundwork for cloud sync

## 🛠️ Tech Stack

| Layer | Technology |
|:---|:---|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) |
| UI | React 19, [Tailwind CSS 4](https://tailwindcss.com/), [shadcn/ui](https://ui.shadcn.com/) |
| Camera | `getUserMedia` API + Canvas |
| Edge Detection | [jscanify](https://github.com/nickodev/jscanify) (OpenCV.js) |
| Local Storage | [Dexie.js](https://dexie.org/) (IndexedDB) |
| PDF Generation | [pdf-lib](https://pdf-lib.js.org/) |
| OCR | [Tesseract.js](https://tesseract.projectnaptha.com/) |
| PWA | [@serwist/next](https://serwist.pages.dev/) |
| Accounts (optional) | [Supabase Auth](https://supabase.com/docs/guides/auth) |
| Hosting | [Vercel](https://vercel.com/) |
| CI | GitHub Actions |

## 🚀 Getting Started

### Prerequisites

- Node.js 20+
- npm 10+

### Development

```bash
# Clone the repo
git clone https://github.com/motiko/quickscan.git
cd quickscan

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your mobile browser (or use Chrome DevTools mobile emulation).

> **Note:** Camera access requires HTTPS in production. The local dev server works over `localhost` without HTTPS.

### Available Scripts

| Command | Description |
|:---|:---|
| `npm run dev` | Start development server |
| `npm run build` | Production build |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run test` | Run tests |
| `npm run test:live` | Run tests against real LLM providers (keys from `.env.test.local`, see `.env.example`) |

Live tests skip when their key is missing. Locally, copy `.env.example` to `.env.test.local` (gitignored) and fill in `CUSTOM_LLM_KEY`. In CI, the key comes from the `CUSTOM_LLM_KEY` repository secret (`gh secret set CUSTOM_LLM_KEY`) and is only exposed to the live test step.

### Accounts (Supabase, optional)

Without Supabase variables the app runs fully local and shows no account UI. To enable sign-in:

1. Create a Supabase project — pick the **EU (Frankfurt)** region to keep data in the EU. Under Security, keep **Enable Data API** on, turn **Automatically expose new tables** off and **Enable automatic RLS** on: tables are then unreachable until a migration grants access and adds policies. Connect the GitHub integration with `supabase` as the Supabase directory so `supabase/migrations/` is applied on merge to `main`.
2. **Authentication → Sign In / Providers → Email:** keep Email enabled (entering the emailed code also confirms the address).
3. **Authentication → Emails → Magic Link** template: include the code, e.g. `Your QuickScan code: {{ .Token }}`. The app signs in with the code, not the link — an installed iOS PWA doesn't share storage with Safari, so a link would sign in the browser instead of the app.
4. **Invite-only (recommended while it's just friends):** turn off *Allow new users to sign up* and invite people under **Authentication → Users → Invite**. Uninvited emails get "ask the owner to invite you".
5. Set the variables in `.env.local` for development and in Vercel (Production + Preview):
   ```bash
   NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
   ```
   Both are under **Project Settings → API Keys → Publishable and secret API keys**. The publishable key is public by design and ends up in the client bundle. Never put a secret key (`sb_secret_…`) or the legacy `service_role` key in a `NEXT_PUBLIC_*` variable or anywhere in this app; the legacy `anon` key isn't used either.
6. For production, configure a custom SMTP sender under **Authentication → Emails → SMTP** — Supabase's built-in sender is rate-limited to a few emails per hour.

**Database migrations** live in `supabase/migrations/` and are applied to the production project by the GitHub integration when a PR is merged to `main` — review SQL before merging. pgTAP tests in `supabase/tests/` check the row-level security and sync functions; CI runs them on PRs touching `supabase/**`. Locally (needs Docker):

```bash
npx supabase start -x realtime,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor
npx supabase test db
npx supabase stop --no-backup
```

This only touches the local Docker stack; never `supabase link` or `db push` to the hosted project.

**Sync setup (end-to-end encrypted).** Once signed in, the Account section shows **Sync**. On the first device, *Turn on sync* creates the vault key and shows a recovery key once (copy, download or print it); only the vault key wrapped by the recovery key is stored in Supabase. Other devices unlock with *Unlock sync on this device* and the recovery key. *Create a new recovery key* replaces it (the old one stops working). Without the recovery key and without another unlocked device, synced data can't be recovered. Signing out forgets the key on that device; documents stay.

## 📁 Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── layout.tsx          # Root layout, PWA meta tags
│   ├── manifest.ts         # Web App Manifest
│   ├── page.tsx            # Home — document gallery
│   ├── scan/page.tsx       # Camera & scanning UI
│   └── doc/[id]/page.tsx   # Document viewer & export
├── components/
│   ├── camera/             # Camera, crop overlay, filters
│   ├── documents/          # Gallery cards & list
│   └── ui/                 # shadcn/ui components
├── lib/
│   ├── db.ts               # Dexie.js database schema
│   ├── camera.ts           # getUserMedia utilities
│   ├── pdf.ts              # PDF generation with pdf-lib
│   ├── image-processing.ts # Canvas filters & transforms
│   └── scanner.worker.ts   # Web Worker for edge detection
├── hooks/                  # React hooks (useCamera, useDocuments, etc.)
└── types/                  # TypeScript type definitions
```

## 🗺️ Roadmap

- [x] Project setup & CI
- [x] **Phase 1:** Camera capture, manual crop, filters, PDF export, gallery
- [x] **Phase 2:** Auto edge detection, auto-capture, image enhancement, Share API
- [ ] **Phase 3:** Organization & sync
  - [x] Folders & tags (local, on-device)
  - [x] User accounts — passwordless email-code sign-in via Supabase Auth (optional, invite-only)
  - [ ] Cloud sync — Supabase Postgres + Storage, row-level security per user, last-write-wins per record
- [x] **Phase 4:** OCR/text extraction, AI document naming, annotation
- [ ] **Phase 5:** Security & robustness
  - [ ] End-to-end encryption — documents and images encrypted on the device before upload; key recovery story
  - [ ] Data consistency & conflict resolution — offline edits on several devices, tombstones for deletes, conflict UI where last-write-wins isn't enough
  - [ ] Security hardening & pentesting — RLS/storage policy audit, CSP and headers, auth abuse (enumeration, rate limits), dependency audit, external penetration test

## 🤝 Contributing

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

Please follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages.

## 📄 License

MIT
