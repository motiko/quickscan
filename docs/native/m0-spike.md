# Native app — M0 feasibility spike

Milestone M0 of the Capacitor migration plan: can the existing PWA run inside a Capacitor iOS shell, and does each risky dependency hold? Run on 2026-10-04: Capacitor 8.5.2 (Swift Package Manager, no CocoaPods), Xcode 27.0, iPhone 17 Pro Simulator (iOS 26.2), Next.js 16.3.8.

**Verdict: go, with one condition.** The web app runs in the shell without changes to its logic. Storage, encryption, OCR and the scanner plugin work. Passkeys need a native plugin, as expected, and the one open question (whether PRF output matches between web and native) needs a real domain and a device. It must be settled before M6 starts, but nothing before M6 depends on it.

## Results

| # | Check | Result | Evidence |
|---|-------|--------|----------|
| 1 | Static export builds | **Pass** | `npm run build:export` → `out/` with `/`, `/scan`, `/settings`, `/doc`, `/manifest.webmanifest`. The web build is unchanged (all pages still rendered per request, proxy present; lint, typecheck, 519 unit tests, 118 e2e tests pass). |
| 2 | iOS shell runs gallery → scan → document | **Pass** | Client-side navigation `/` → `/scan` → `/` → `/doc?id=…` works, and the document page shows the imported page. A full page load of `/scan` needed a custom router (below). |
| 3 | VisionKit scanner plugin returns pages | **Pass on Simulator; device check open** | `@capgo/capacitor-document-scanner` 8.4.6 (SPM, MPL-2.0) compiled. On the Simulator it shows its own sample-scan screen in place of VisionKit, whose camera needs hardware. Accepting it returned 2 pages as files, which were read with `Capacitor.convertFileSrc` and went through `importFiles` into the gallery. The real VisionKit camera is still to be tried on an iPhone (5 minutes, steps below). |
| 4 | Passkey with PRF | **Fails in the WebView (expected); native path not yet verified** | `navigator.credentials.create` in the WebView → `NotAllowedError`, for rpId `localhost` and for a real domain. The WebView origin is `capacitor://localhost`, so our domain can never be the rpId there. The native route (ASAuthorization, PRF on iOS 18+) needs a `webcredentials:` associated domain with an AASA file on the production domain plus the Team ID. No existing Capacitor passkey plugin supports PRF, so it is a small custom plugin or a fork of `@capgo/capacitor-passkey`. |
| 5 | IndexedDB and the non-extractable vault key survive restarts | **Pass** | After terminating and relaunching the app, the document and page were still in Dexie, and the non-extractable AES-GCM `CryptoKey` stored in IndexedDB was read back, decrypted its ciphertext, and still refused `exportKey`. `isSecureContext` is true and `crypto.subtle` is available at `capacitor://localhost`. Storage quota reported ≈10 GB; `navigator.storage.persisted()` is false. |

Also observed:
- **Tesseract OCR runs inside the app.** Its worker and WASM cores load from `capacitor://`, and the imported page finished OCR with 3024 characters.
- **The camera page opens.** On the Simulator it shows "Camera Unavailable", as expected without hardware. `NSCameraUsageDescription` is in `Info.plist` for `getUserMedia` on a device.

## What the spike changed in the repo

- **`scripts/build-export.mjs` / `npm run build:export`.** Sets `NEXT_PUBLIC_BUILD_TARGET=export` and moves the server-only files aside during the build, always restoring them: `src/proxy.ts`, `src/app/api/`, `src/app/doc/[id]/`. Types are not checked in this build because tests import the parked files; the web build and CI check them.
- **`next.config.ts`.** The web config is unchanged. The export config has `output: 'export'` and no response headers.
- **`src/app/layout.tsx`.** `force-dynamic` became `await connection()`, skipped in the export. Route segment config can't be conditional, and the export refuses `force-dynamic`.
- **Document URLs.** The viewer moved to `components/documents/DocumentViewer.tsx`. `/doc/[id]` (web) and `/doc?id=` (export) are thin wrappers, and links go through `docHref()` in `lib/routes.ts`.
- **`ios/` (Capacitor 8, SPM).**
  - `MainViewController` replaces Capacitor's router. The default sends every path without an extension to the root `index.html`, so a full load of `/scan` showed the gallery. Ours serves `scan.html`, then `scan/index.html`, then `index.html`.
  - Capacitor 8 sets the root view controller in `SceneDelegate`, not the storyboard.
- **Lint and typecheck** ignore `out/`, `ios/` and `android/`.

The probe page, sample image and scanner plugin used for the checks were removed. The plugin returns in M3.

## Findings for later milestones

- **M1 — CSP.** The static export has no CSP yet, because there's no proxy. Before anything ships, a post-build step must:
  - Put a `<meta http-equiv="Content-Security-Policy">` first in each exported page's `<head>`, with a `sha256` hash for every inline Next script and the web policy's other directives.
  - Check a test that every inline script's hash is in its page's policy.
  - Meta can't set `frame-ancestors`, reporting, nosniff or COOP; `SECURITY.md` should say so.
  - The workers lose their `'wasm-unsafe-eval'` header policy, so check in the Simulator that WASM still compiles and `eval` doesn't.
  - No remote scripts or `server.url` in release configs. `webContentsDebuggingEnabled` stays unset, so release builds aren't inspectable.
- **M1 — no file moving.** `build-export.mjs` moves the server-only files aside, and `next.config.ts` refuses a web build while they're parked. Excluding them with a build-target-specific `pageExtensions` would leave the web tree untouched.
- **M1 — LLM proxy.** The app has no `/api/llm`, so providers that need the proxy don't work there. Options: Capacitor's native HTTP, or CORS for `capacitor://localhost` on the hosted proxy. The latter needs a fresh look at the proxy's abuse surface.
- **M1 — full page loads.** `DatabaseGate` uses `location.reload()`; with the custom router that now reloads the right page.
- **M3 — import shape.** The scanner returns one file per page (≈1.5 MB JPEG each on the Simulator sample). The app should import a scan as one document with several pages (`importPagesToDocument`) and re-encode to the 150–400 KB target (M9).
- **M6 — PRF parity test.** Wrap a test value with a passkey's PRF output on the web, then unwrap it with the native API for the same credential and salt. If the native API doesn't apply WebAuthn's salt hashing (SHA-256("WebAuthn PRF" ‖ 0x00 ‖ salt)), the plugin has to hash the salt itself. This needs the AASA file deployed on the production domain, the Team ID, and a device. It is the owner's call, because the AASA file is a public change to the site.

## Native OCR

M4's native OCR is a separate open-source plugin, `capacitor-native-ocr`; no existing plugin combines Apple Vision, word boxes and SPM. Design, API and plan: [ocr-plugin.md](ocr-plugin.md).

## How to repeat it

```bash
npm run cap:sync                       # static export + copy into ios/
xcrun simctl boot "iPhone 17 Pro"
xcodebuild -project ios/App/App.xcodeproj -scheme App -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath ios/DerivedData build
xcrun simctl install booted ios/DerivedData/Build/Products/Debug-iphonesimulator/App.app
xcrun simctl launch --console-pty booted app.quickscan   # console.log lines appear as "⚡️  [log] - …"
```

Checking VisionKit on an iPhone:
1. `npm install @capgo/capacitor-document-scanner`, then `npm run ios`.
2. In Xcode, pick your team under Signing and run on the phone.
3. Call `DocumentScanner.scanDocument()` from a button, and confirm the system scanner opens and returns cropped pages.
