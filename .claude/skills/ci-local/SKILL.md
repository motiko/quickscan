---
name: ci-local
description: Run QuickScan's CI checks locally, the same way GitHub Actions does, before pushing or opening a PR — audit, lint, typecheck, Vitest, production build, Playwright against the prod server, and pgTAP when supabase/ changed. Use before /submit or when asked to "verify", "run the checks" or "make sure CI passes".
---

# Run CI locally (QuickScan)

Mirrors `.github/workflows/ci.yml` and `supabase.yml`. Run the steps in order and stop at the first failure — fix it, then continue.

```bash
npm audit --omit=dev --audit-level=high
npm run lint
npm run typecheck
npm run test -- --passWithNoTests
npm run build
E2E_SERVER=prod npx playwright test --project="iPhone Camera (Chromium)" --project="Desktop Chrome"
```

Notes:
- CI builds **without** Supabase env vars. If `.env.local` sets `NEXT_PUBLIC_SUPABASE_*`, account UI appears and the results can differ; note it in the report.
- Port 3000 busy (e.g. a running `npm run dev`)? Add `E2E_BASE_URL=http://localhost:3100`.
- `tests/visual-crop.test.ts` needs `ffmpeg` on the PATH.
- To save time when only some areas changed, run the unit tests for the touched modules and the relevant specs first (`git diff main...HEAD --name-only`), then the full set before the PR.

When the diff touches `supabase/`:

```bash
npx supabase start
npx supabase db reset
npx supabase test db
```

When it touches `src/lib/db.ts`, also run WebKit for `e2e/upgrade.spec.ts` (see the `dexie-version` skill).

## Report

List each step with pass/fail. For failures give the first real error (not the whole log), and whether you fixed it. Don't claim green for steps you skipped — say which and why.
