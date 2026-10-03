# Security

## Reporting a vulnerability

Please report security issues privately to the repository owner ([@motiko](https://github.com/motiko)), not in a public issue or pull request. Use GitHub's **Report a vulnerability** button on the Security tab if it's available, or otherwise contact the owner through their GitHub profile and ask for a private channel. Include steps to reproduce and the impact you expect. Please don't test against other people's accounts or data. A local stack (`npx supabase start`) or your own deployment is enough for almost everything.

## Threat model

QuickScan is **local-first**. Documents, page images, OCR text, annotations and settings live in IndexedDB on the device, and the app works fully without an account or network.

**Cloud sync is end-to-end encrypted.** Each account has a random vault key, generated on a device and stored there in IndexedDB as a non-extractable WebCrypto `CryptoKey`. Record payloads and files are encrypted with it (`src/lib/crypto`) before they leave the device. The vault key reaches the server only wrapped, either by the recovery key or a passkey, or sealed to a pairing device. The emailed sign-in code never derives a key.

**What the server (Supabase) can see:** ciphertext, plus the metadata it needs to sync: record kind (`document`, `page`, `folder`, `signature`, `settings`), record ids, timestamps (client edit time, server sequence), ciphertext and file sizes, the writing device id, deletion flags, key versions, the Storage object names a record references, and the account's email address. It cannot read document names, text, images or tags. Authorization is row-level security scoped to `auth.uid()` (see `supabase/migrations/` and the pgTAP tests in `supabase/tests/`). Only the publishable key ships to the client.

**XSS is the main threat.** A non-extractable key can't be copied out, but any script running in our origin can *use* it: decrypt the vault, read IndexedDB, and send the plaintext anywhere. Everything below aims first at keeping foreign script out of the origin.

Other things to know:

- **LLM features send content to a third party.** When a user configures an LLM provider (OpenAI, Anthropic, Google or a custom endpoint), the OCR text or page image used for naming, transcription or summaries goes straight from the browser to that provider with the user's own API key. The `/api/llm` proxy exists only for allowlisted hosts that reject browser CORS (`PROXIED_HOSTS`). It's stateless and doesn't log request bodies or keys.
- **API keys for LLM providers are stored in IndexedDB** in plaintext on the device. They're local-only settings and are never synced.
- **Lost device:** whoever unlocks the device can use the app as its owner. Sign out on that device (or from another) to end the session.

## Content-Security-Policy and headers

Documents get a CSP with a fresh nonce on every response, set in `src/proxy.ts`. Worker scripts get a static policy, set in `next.config.ts`. Both are built by `src/lib/csp.ts`. The production document policy, with the Supabase origin derived from `NEXT_PUBLIC_SUPABASE_URL` at build time, is:

```
default-src 'self';
script-src 'self' 'nonce-<random>' 'strict-dynamic';
worker-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' blob: data:;
font-src 'self';
connect-src 'self' https://<project>.supabase.co wss://<project>.supabase.co https: http://localhost:* http://127.0.0.1:*;
manifest-src 'self';
frame-src 'none';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests
```

`upgrade-insecure-requests` is sent only over HTTPS: on plain-HTTP `localhost`, Safari would upgrade every subresource and break the page. `next dev` adds `'unsafe-eval'` (React's error overlay) and `ws:` (HMR).

Workers (`/_next/static/*`, `/tesseract/*`) get:

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src <as above>; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'
```

Every response also gets these headers:

| Header | Value |
| --- | --- |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` |
| `Referrer-Policy` | `no-referrer` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` (legacy twin of `frame-ancestors 'none'`) |
| `Permissions-Policy` | `camera=(self)`, with microphone, geolocation, payment, USB, serial, HID, Bluetooth, MIDI, display capture and Topics denied. Clipboard write and Web Share keep their default (`self`) for "Copy text" and "Share PDF". |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |

`X-Powered-By` is turned off.

### Decisions and trade-offs

- **Nonces, not `'unsafe-inline'`.** Next's App Router streams the RSC payload in inline `<script>` tags, so a `script-src` without `'unsafe-inline'` needs either nonces or per-page hashes. Next only supports nonces, and only for pages rendered per request. The root layout therefore sets `dynamic = 'force-dynamic'`, and every page renders on demand instead of being prerendered. The pages are small client shells, so the cost is a short server render per navigation and no CDN caching of HTML. Static assets are cached as before. In exchange, an injected `<script>` or inline event handler can't run, and with `'strict-dynamic'` the host allowlist doesn't matter: only scripts loaded by our nonced bootstrap execute. Next's experimental SRI mode only hashes script files, not the inline payload, so it doesn't get rid of `'unsafe-inline'`.
- **WebAssembly only in workers.** Tesseract's core and scanic's edge detection compile WebAssembly in their Web Workers. Workers take the CSP of their own script response, so only the worker policy has `'wasm-unsafe-eval'`. That allows WebAssembly compilation, not JS `eval`. The document policy has neither, and no policy has `'unsafe-eval'` in production. OpenCV.js isn't used any more (scanic replaced jscanify), and TensorFlow.js (the unused ML corner detector) doesn't need eval.
- **Tesseract is self-hosted.** By default tesseract.js loads its worker script and WASM core from `cdn.jsdelivr.net`. Allowing a public npm CDN in `script-src` would let an attacker load any package published there, which defeats the CSP. `scripts/copy-tesseract.mjs` copies the worker and cores from `node_modules` into `public/tesseract/` (gitignored) before `dev` and `build`, and `src/lib/ocr.ts` points tesseract.js at them, without the `blob:` worker wrapper. Only **language data** still comes from `https://cdn.jsdelivr.net/npm/@tesseract.js-data/…`. That's a `connect-src` fetch of data, not code, cached in IndexedDB after the first download.
- **`connect-src https:` for LLM endpoints.** Users can point the app at any OpenAI- or Anthropic-compatible endpoint (OpenRouter, a self-hosted gateway, Ollama, LM Studio), and the browser calls it directly so prompts and API keys never pass through our server. A build-time CSP can't list hosts the user types in later. Sending every custom endpoint through `/api/llm` would turn it into an open proxy (SSRF), put user content and keys through our server, and couldn't reach a model server on the user's own machine (`http://localhost`). So `connect-src` allows any `https:` origin plus `http://localhost:*` / `http://127.0.0.1:*`. The cost is that `connect-src` doesn't stop an XSS payload from `fetch`ing data out. That defence was weak anyway: navigations, `window.open` and link prefetches can carry data out and are outside `connect-src`'s reach. The protection is keeping script out (`script-src` above) and not having injection sinks (see "XSS review"). If custom endpoints are ever dropped, replace `https:` with the provider origins and `https://cdn.jsdelivr.net`.
- **`style-src 'unsafe-inline'`.** React renders `style=""` attributes into the server HTML, and nonces don't cover attributes. CSS can't execute script, and because `img-src` and `font-src` are restricted to our origin (plus `blob:`/`data:`), injected CSS can't beacon data to another host.
- **`upgrade-insecure-requests`** may make some browsers, notably Safari, upgrade a user-configured `http://localhost` LLM endpoint to `https://`. The app itself makes no plain-HTTP requests, so all the directive does is defence in depth next to HSTS. If local model servers matter more, drop it in `src/proxy.ts`.
- **No COEP.** Nothing needs cross-origin isolation (`SharedArrayBuffer`): Tesseract and scanic run single-threaded WASM. `require-corp` would only add the risk of breaking cross-origin fetches, and `credentialless` isn't supported in Safari.
- **Service worker and manifest.** `/manifest.webmanifest` and the icons are covered by `default-src`/`manifest-src 'self'`. The app currently registers no service worker (Serwist isn't installed). When one is added: `worker-src 'self'` already allows a same-origin `/sw.js`. Exclude it from the proxy matcher and serve it with the worker policy in `next.config.ts`. A service worker that caches HTML replays an old nonce with its own cached header, which is consistent but means the nonce is no longer per response.
- **Not covered by CSP:** user-entered LLM URLs, as above. Navigations and downloads, since `navigate-to` was never shipped. Browser extensions.

`e2e/security.spec.ts` checks the headers on every page, a fresh nonce per response, and that there are no `securitypolicyviolation` events while the gallery, settings, scanner (camera + edge-detection worker), upload, OCR (Tesseract worker) and PDF export run. It also checks inside each worker that WebAssembly compiles and `eval` doesn't.

**Adding a network destination** (a new provider, CDN, analytics, fonts): don't widen the policy casually. Prefer self-hosting. Add the exact origin to the right directive in `src/lib/csp.ts`, never to `script-src`, and update this file and the unit tests. Never add `'unsafe-inline'` or `'unsafe-eval'` to `script-src`, or a public CDN host.

## XSS review

Checked when the CSP was added:

- No `dangerouslySetInnerHTML`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`, `document.write`, `eval`, `new Function`, `srcdoc` or `javascript:` URLs in `src/`.
- Untrusted text (OCR output, LLM replies for names, summaries and transcriptions, document names, tags, folder names, imported file names, Supabase error messages) is rendered only as React text children. That's escaped, and there's no Markdown/HTML rendering.
- Dynamic `href`/`src` values are `blob:` URLs from `URL.createObjectURL`, constant provider links (`AiProviderSettings`), and `/doc/${id}` links built from the document id. Ids are nanoids, and a synced id could at worst point at a different in-app path, never a `javascript:` URL. Downloads set `a.download` from the document name, which is not interpreted as markup.
- Imported images are decoded and re-encoded to JPEG through a canvas. Images are only shown in `<img>`, where even an SVG can't run script, and a `blob:` document inherits the page's CSP.

## Authentication abuse

Sign-in is passwordless: Supabase emails a one-time code (`src/lib/auth.ts`). Server-side settings, configured in the Supabase dashboard and mirrored in `supabase/config.toml`:

| Setting | Value | Why |
| --- | --- | --- |
| Sign-ups | Disabled (`[auth] enable_signup = false`). Users are invited from the dashboard. | Invite-only |
| Email provider | Enabled (`[auth.email] enable_signup = true` keeps the provider on, not open sign-up) | Codes are the only sign-in method |
| OTP length / expiry | 8 digits / 1 hour | 10⁸ codes against 30 verifications per 5 min per IP |
| Email send interval | 60 s per address (`max_frequency`) | Throttles code requests and mail bombing |
| Emails per hour | 2 with the built-in mailer; raise with custom SMTP (`rate_limit.email_sent`) | Project-wide cap |
| Sign-in requests | 30 per 5 min per IP (`rate_limit.sign_in_sign_ups`) | |
| Code verifications | 30 per 5 min per IP (`rate_limit.token_verifications`) | Brute-forcing an 8-digit code is impractical |
| Token refresh | 150 per 5 min per IP; refresh-token rotation on, 10 s reuse window | |
| Anonymous sign-ins, manual linking | Off | |
| JWT expiry | 1 hour | |

Client behaviour:

- `signInWithOtp` passes `shouldCreateUser: false`, so even if sign-ups were switched on by mistake, the client never creates an account.
- **Enumeration:** in an invite-only project, Supabase answers an uninvited email with an error (`otp_disabled` / `signup_disabled`) instead of sending a code. The UI turns that into "Sign-in here is by invitation. Ask the owner of this QuickScan to invite you." and doesn't otherwise say whether an account exists. Anyone can call the Auth API directly with the public publishable key, so the UI can't hide more than the API reveals. Use CAPTCHA (`[auth.captcha]`) if enumeration or mail abuse becomes a problem.
- **Rate limits (429)** are recognised by status and code (`over_email_send_rate_limit`, `over_request_rate_limit`) before anything else. The user sees "Too many attempts", with the wait in seconds when Supabase gives one. Wrong or expired codes get "That code is wrong or has expired". The client never retries automatically.

## Dependencies

- `package-lock.json` is committed and CI installs with `npm ci`, so builds use the exact locked tree.
- Packages that are security-relevant are pinned to exact versions in `package.json`: `@supabase/supabase-js`, which handles sessions and tokens, and `tesseract.js`, whose worker and WASM core we serve from our own origin. `.npmrc` sets `save-exact=true` so new dependencies are pinned too. Older entries still use `^` ranges, which only matter when someone runs `npm install`/`npm update`. Review the lockfile diff on upgrades. The E2EE code uses only WebCrypto, with no crypto packages.
- CI runs `npm audit --omit=dev --audit-level=high`, so a high or critical advisory in anything that ships fails the build.
- Known, accepted advisories, dev-only and not shipped to users:
  - `braces` ≤ 3.0.3 (GHSA-vfj7-8cjw-p6xm, ReDoS-style stack exhaustion), via `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch`. No patched `braces` exists, and `npm audit fix --force` would downgrade `eslint-config-next` to 14. It only runs in ESLint on our own glob patterns, so there's no attacker-controlled input.
- Upgrade Next.js promptly for security releases. Since the CSP depends on its nonce handling, run `e2e/security.spec.ts` after every Next upgrade.
