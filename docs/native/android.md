# Native app — Android (M5)

The Capacitor Android project in `android/`. Set up and checked on 2026-10-04 with Capacitor 8.5.2, an Android 15 (API 35) arm64 emulator (`google_apis`), JDK 21 and the Android SDK at `~/Library/Android/sdk`.

## What was checked on the emulator

| Check | Result |
|---|---|
| Gallery, `/scan`, `/settings` and `/doc?id=` load on a full page load | Pass, after `MainActivity`'s page routing (below) |
| Secure context, WebCrypto, IndexedDB | Pass: `https://localhost` is a secure context |
| Data survives a force-stop and relaunch | Pass: documents still listed; a non-extractable `CryptoKey` still refuses `exportKey`. Storage isn't persisted (`navigator.storage.persisted()` false, ≈6 GB quota), as on iOS |
| Native OCR (ML Kit through `capacitor-native-ocr` 0.2.0) | Pass: an imported upside-down receipt read row by row, the page was turned upright from `rotation`, and the word boxes landed on the turned image |
| Tesseract fallback | Pass: with Hebrew among the OCR languages, a page went to Tesseract; its worker and WASM load from the app, the language data from jsDelivr |

## What's in the project

- **`MainActivity`** routes page requests. Capacitor's local server sends every path without an extension to `index.html`, so a full load of `/scan` showed the gallery. `StaticExportWebViewClient` serves `scan.html`, then `scan/index.html`, then falls back to Capacitor. It's the Android twin of iOS's `StaticExportRouter`.
- **Camera permission** in the manifest, for the scan page's `getUserMedia`; Capacitor asks for it at runtime when the page does. The camera is optional (`required="false"`).
- **OCR engine name:** pages read natively record `ocrInfo.engine: 'mlkit'` on Android (`'vision'` on iOS), and the text sheet shows "ML Kit".

## How to repeat it

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=~/Library/Android/sdk
npm run cap:sync                                   # static export + copy into ios/ and android/
(cd android && ./gradlew assembleDebug)
emulator -avd <avd> &                              # or a phone with USB debugging
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n app.quickscan/.MainActivity
```

Debug builds are inspectable: open `chrome://inspect` in Chrome on the Mac.

## Release builds

```bash
npm run cap:sync
(cd android && ./gradlew bundleRelease)       # → android/app/build/outputs/bundle/release/app-release.aab
```

- **`versionName`** is `package.json`'s `version`, read by `android/app/build.gradle`. Bump it there for a release users should see as new.
- **`versionCode`** comes from `ANDROID_VERSION_CODE`, default `1`. Google Play refuses an upload whose code isn't higher than every earlier one. CI sets it to the Android workflow's run number, which only grows. Upload only CI-built bundles. If you ever upload a local build, pass a code above the last uploaded one (`ANDROID_VERSION_CODE=1234 ./gradlew bundleRelease`); after that, CI's run numbers have to pass it before CI bundles are accepted again. The build refuses anything other than a whole number from 1 to 2100000000 (Play's maximum).
- **Signing.** The key in this repo's setup is the **upload key**. With Play App Signing, Google holds the app signing key and re-signs what you upload; a lost or leaked upload key can be reset in Play Console. The release build takes it from, in order:
  1. `android/keystore.properties` (gitignored, like `*.jks` / `*.keystore`), with `storeFile` (relative to `android/` or absolute), `storePassword`, `keyAlias` and `keyPassword`.
  2. The environment: `ANDROID_KEYSTORE_FILE`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`. CI decodes the `ANDROID_KEYSTORE_BASE64` secret into a temp file and sets `ANDROID_KEYSTORE_FILE`.

  With neither, `bundleRelease` still succeeds and prints a warning: the bundle is **unsigned**, and Play refuses it. That keeps the release build (R8, resource shrinking, manifest merge) checked on every pull request. A half-filled config (a missing password or alias, a keystore file that doesn't exist) fails the build and names what's missing.
- **CI** (`.github/workflows/android.yml`, on pull requests, pushes to `main` and manual runs): static export → `cap sync android` → `assembleDebug test` → `bundleRelease` → the AAB as the artifact `quickscan-android-<run number>` (kept 14 days). Only pushes to `main` and manual runs get the signing secrets, so code in a pull request can't read the upload key. The static export reads the repository **variables** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`; without them the bundle has no accounts or sync.
- **Size** (0.1.0, 2026-10-04): the AAB is about 31 MB; what a phone downloads is about 17 MB (`bundletool get-size total`: 16.4 MB armeabi-v7a to 17.6 MB x86). Most of it is ML Kit's recognizer (`libmlkit_google_ocr_pipeline.so`, 11 MB for arm64 before compression) and Tesseract's six WASM builds (≈25 MB before compression). The 64-bit native libraries are 16 KB page-aligned, as Play requires.

## Release hardening

Checked on the release bundle with `bundletool dump manifest` and on the APKs built from it with `aapt2 dump badging`.

| Setting | Release build | Why |
|---|---|---|
| Debuggable app and WebView | No | No `android:debuggable` in the merged manifest. Capacitor 8.5.2 turns on WebView debugging only when it isn't set in the config and the app is debuggable (`CapConfig`: `webContentsDebuggingEnabled = getBoolean(config, "android.webContentsDebuggingEnabled", isDebug)`, with `isDebug` from `FLAG_DEBUGGABLE`), and `capacitor.config.ts` doesn't set it. Debug APKs stay inspectable. |
| Backups and device transfer | Off: `android:allowBackup="false"` and `res/xml/data_extraction_rules.xml` excluding every domain | The WebView's IndexedDB holds the sync vault key. "Non-extractable" binds only scripts: Chromium stores the key's raw bytes in its IndexedDB files. Next to it are LLM API keys in plain text and this device's sync id, cursors and replay marks. A backup would put the vault key into Google's backup (or onto another phone) outside what SECURITY.md describes. A restored copy would also be a second device with the same device id and sync cursors. On Android 12+, `allowBackup="false"` stops cloud backups but not device-to-device transfers, hence the rules. Cost: a new phone starts empty. Users move their documents with sync (recovery key, QR pairing) or PDF export. |
| Cleartext HTTP | On: `android:usesCleartextTraffic="true"` | Only for LLM endpoints the user enters on plain `http://` (say, Ollama on the LAN), which the app reaches over native HTTP (`lib/platform/native/http.ts`). The WebView still loads nothing over HTTP: pages come from Capacitor's `https://localhost`, mixed content is off, and the CSP has `upgrade-insecure-requests`. Supabase and jsDelivr use HTTPS. iOS allows the same with `NSAllowsArbitraryLoads` (App Review asks for a reason: user-configured self-hosted servers). |
| R8 and resource shrinking | On | Capacitor's and ML Kit's consumer rules keep what they reach by reflection. Checked in `mapping.txt`: `NativeOcrPlugin` keeps its name (Capacitor loads it by name from `capacitor.plugins.json`) and its `@PluginMethod`s, `@JavascriptInterface` methods such as `MessageHandler.postMessage` keep theirs, and the annotations survive. `proguard-rules.pro` adds `-dontwarn` for ML Kit's Chinese, Devanagari, Japanese and Korean recognizers: `capacitor-native-ocr` compiles against them but ships only the enabled ones (none), and R8 stops at missing classes otherwise. The mapping file goes into the bundle, so Play Console shows readable stack traces. |
| `capacitor.config.ts` | Nothing debug-only | No `server.url`, no `webContentsDebuggingEnabled`, `loggingBehavior: 'none'`, default `https` scheme, mixed content off. |

**Not yet checked:** the R8-shrunk release build hasn't run on a device or emulator (only its mapping was inspected). Install the APKs built from the first signed bundle, or the internal-testing build, and run one scan through native OCR before inviting testers.

## App identity

`applicationId` `app.quickscan`, label "QuickScan". The launcher icon and the splash are the web app's icon (`src/app/icon.png`, `public/icons/`: a grey ring and white disc on `#2563eb`); the iOS app still has Capacitor's placeholder icon. Sources are in `assets/`, rendered at 1024 px (splash 2732 px, light and dark), and the Android resources were generated once with:

```bash
npx @capacitor/assets@3.0.5 generate --android
```

Then, by hand: the adaptive icon's background is the colour `@color/ic_launcher_background` instead of an inset PNG, and `ic_launcher_foreground.png` is rendered at the inset layer's size (72 dp: 72–288 px), not `@capacitor/assets`' 108 dp. Android 12+ draws its own launch screen from the adaptive icon on `@color/splash_background` (white, `#0a0a0a` at night); older versions show `drawable*/splash.png`.

## Google Play: owner checklist

1. **Make the upload key** (once; keep the file and passwords in a password manager, never in the repo):

   ```bash
   keytool -genkeypair -v -keystore quickscan-upload.jks -storetype PKCS12 \
     -alias upload -keyalg RSA -keysize 4096 -validity 9125 \
     -dname "CN=QuickScan upload key"
   ```

   PKCS12 has a single password, so the store and key passwords are the same. For local release builds, put it in `android/keystore.properties`:

   ```properties
   storeFile=/absolute/path/to/quickscan-upload.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```

2. **GitHub secrets** (Settings → Secrets and variables → Actions → Secrets):
   - `ANDROID_KEYSTORE_BASE64`: `base64 -i quickscan-upload.jks | pbcopy`, then paste
   - `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_PASSWORD`: the password (the same for PKCS12)
   - `ANDROID_KEY_ALIAS`: `upload`

   And, for accounts and sync in the app, the **variables** `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the same values as on Vercel; never a secret key). The next push to `main` (or Actions → Android → Run workflow) builds a signed bundle; the log shows `jar verified.`
3. **Create the app in Play Console** (a developer account costs a one-time $25; new personal accounts must run a closed test with testers before production, but internal testing is open to all): Create app → name "QuickScan", app, free → accept the declarations. Fill in the App content pages: privacy policy URL, ads (none), app access (everything works without an account; sync needs an invitation), content rating, target audience, Data safety (below).
4. **Play App Signing** is on by default for new apps. At the first upload, keep "Let Google manage and protect your app signing key". The key from step 1 becomes the upload key.
5. **First upload, by hand:** Testing → Internal testing → Create new release → upload `app-release.aab` from the CI artifact `quickscan-android-<n>` (unzip it first) → release name and notes → Save → Review → Start rollout. The package name `app.quickscan` is fixed from then on.
6. **Internal testers:** Internal testing → Testers → create an email list (up to 100 Google accounts) → save → copy the opt-in link and send it. Testers open it, accept, and install from Play. Builds reach them within minutes, without review.
7. **Later uploads:** each signed `main` build is a candidate; upload it the same way. To automate, create a Google Cloud service account with release access to this app in Play Console (Users and permissions), store its JSON key as the secret `PLAY_SERVICE_ACCOUNT_JSON`, and enable the commented-out `r0adkll/upload-google-play` step in `android.yml` (`track: internal`; `status: draft` while the app itself is still a draft in Play Console).

The static export gets a hash-based meta CSP at build time (PR #86, `SECURITY.md` → "Native app (static export)").

### Data safety answers

From SECURITY.md and the code (the Android app has no analytics or crash reporting of its own). Google's own rule: data that leaves the device only end-to-end encrypted, unreadable by us or the server, need not be disclosed.

- **Does the app collect or share user data?** Yes (because of ML Kit, the optional account and optional LLM naming).
- **Encrypted in transit?** Yes: everything goes over HTTPS.
- **Can users ask for deletion?** Yes: local data is deleted with the app or in it; the account and its encrypted data on request to the owner (give an address or form). Accounts are created by invitation, not in the app, so Play's in-app account deletion rule shouldn't apply; it would once the app lets people sign up.

| Data | Collected | Shared | Optional | Purpose | Where it comes from |
|---|---|---|---|---|---|
| Personal info → Email address | Yes | No | Yes | Account management | Sign-in with an emailed code, only if the user turns on sync (Supabase Auth). |
| Photos, Files and docs (scans, OCR text, document names, tags) | No | No | | | OCR runs on the device (ML Kit, or Tesseract in the WebView). Sync uploads them only end-to-end encrypted with the user's vault key (AES-256-GCM); the server sees ciphertext and sizes. |
| Files and docs (OCR text) and Photos (a page image), for naming, transcription and summaries | Yes | No: sent at the user's request, with the user's own API key, to the provider they picked | Yes, off by default | App functionality | Only when the user configures an LLM provider (OpenAI, Anthropic, Google or a custom endpoint). It goes straight from the device to that provider; we never receive it. If you'd rather not count it as collected, it still has to be named in the privacy policy. |
| App info and performance → Diagnostics; Device or other IDs | Yes | No | No | Analytics (ML Kit's "diagnostics and usage analytics") | ML Kit Text Recognition v2 may send Google device and app information, performance metrics, API configuration, input/output sizes, event types, error codes and a per-installation identifier "not intended to uniquely identify a user or physical device", over HTTPS, not passed to third parties ([ML Kit data disclosure](https://developers.google.com/ml-kit/android-data-disclosure)). It can't be turned off from the app. |

Not collected: location, contacts, financial info, messages, audio, health, web history, app activity, crash logs. Tesseract's language data is downloaded from jsDelivr without user data.

## Still open for M5

- The system document scanner (ML Kit Document Scanner), shared with M3's VisionKit scanner on iOS.
- Running the R8-shrunk release build on a device (see "Release hardening").
- CameraX full-resolution stills for the custom camera.
- The OCR bench on an Android device.
