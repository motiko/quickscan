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

## Still open for M5

- The system document scanner (ML Kit Document Scanner), shared with M3's VisionKit scanner on iOS.
- A signed release build for the Play internal-testing track, and a CI job for it.
- CameraX full-resolution stills for the custom camera.
- The OCR bench on an Android device.
