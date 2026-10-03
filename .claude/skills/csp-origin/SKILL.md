---
name: csp-origin
description: Add a network destination to QuickScan (new LLM provider, CDN, font, image host, analytics, API) without weakening the Content Security Policy. Use whenever new code fetches, loads or embeds anything from another origin, or a CSP violation appears in the console.
---

# Adding a network destination (QuickScan)

XSS is the threat to the vault key, so the CSP in `src/lib/csp.ts` stays tight. Read `SECURITY.md` → "Content Security Policy" before changing it.

## 1. Do you need a change at all?

- **`fetch`/XHR/WebSocket to an HTTPS API** → no change. `connect-src` already allows `https:` (because users can configure any LLM endpoint) plus `http://localhost:*` / `http://127.0.0.1:*`.
- **An LLM provider without CORS** → no CSP change; add the host to `PROXIED_HOSTS` for `/api/llm` instead, exact hostname only, and extend `src/lib/__tests__/llm-proxy-route.test.ts`.
- **Scripts, WASM, workers** → self-host under `public/` (as `scripts/copy-tesseract.mjs` does for Tesseract). **Never** add a CDN host, `'unsafe-inline'` or `'unsafe-eval'` to `script-src`.
- **Images, fonts, styles, frames** → prefer self-hosting (`next/font` self-hosts Google Fonts). `img-src`/`font-src` stay on our origin so injected CSS can't beacon data out.

## 2. If an origin really must be added

1. Add the **exact origin** (`https://host.example`, no wildcards, no path tricks) to the **narrowest** directive in `buildCsp` — and in `buildWorkerCsp` only if a worker needs it.
2. Never widen `frame-ancestors`, `object-src`, `base-uri`, or `frame-src 'none'`.
3. Update `src/lib/__tests__/csp.test.ts` with an assertion for the new source.
4. Update the policy text and the rationale in `SECURITY.md`.
5. If it's a new dependency, pin the exact version (`.npmrc` has `save-exact=true`) and lazy-load it.

## 3. Verify

```bash
npx vitest run src/lib/__tests__/csp.test.ts
npm run build && E2E_SERVER=prod npx playwright test e2e/security.spec.ts --project="Desktop Chrome"
```

Then check the browser console on the affected flow (`npm run dev`) for CSP violations. Finally run the `security-reviewer` agent on the branch.
