# Native OCR plugin — published separately

Decision (2026-10-04): QuickScan's native OCR (milestone M4 of the Capacitor migration) is a **standalone open-source Capacitor plugin**, published to npm for anyone to use. QuickScan depends on it like any other package. The plugin knows nothing about QuickScan.

## Why a new plugin

Capacitor has no OCR API. The community plugins, checked on 2026-10-04 by reading their sources, each miss something QuickScan needs and other apps likely do too:

| Plugin | iOS / Android engine | Word boxes | SPM | Licence | Gap |
|---|---|---|---|---|---|
| `@capacitor-community/image-to-text` 8.0.0 | Apple Vision / ML Kit | Lines only | No | Hippocratic 2.0 | Recognition languages never set (Vision's English default); no word boxes; licence with usage restrictions |
| `@jcesarmobile/capacitor-ocr` 0.3.0 | Apple Vision | No | Yes | MIT | Text and confidence only |
| `@capacitor-mlkit/text-recognition` 8.2.1 | ML Kit on both | Yes | No (ML Kit iOS is CocoaPods-only) | Apache-2.0 | Google's engine on iOS rather than Apple's; no SPM |
| `@pantrist/capacitor-plugin-ml-kit-text-recognition` 8.1.1 | ML Kit on both | Yes | No | MIT | Same as above |

The gap the new plugin fills: **Apple Vision on iOS, with word-level boxes, language control and SPM support, under a permissive licence.**

## Package

- **Name:** `capacitor-native-ocr` (free on npm as of 2026-10-04). It doesn't name an engine, because Android uses ML Kit. The scoped `@motiko/capacitor-native-ocr` is the fallback if the owner prefers a scope.
- **Repository:** its own GitHub repo (`motiko/capacitor-native-ocr`), not inside QuickScan. It gets its own issues, releases and contributors.
- **Licence:** MIT.
- **Scaffold:** `npm init @capacitor/plugin` (`@capacitor/create-plugin`, 0.22.0 at the time of writing). It provides Package.swift and a podspec, an Android module, an example app and docgen.
- **Versioning:** the major version follows Capacitor (8.x for Capacitor 8), semver within it. Releases use npm provenance and a changelog.
- **Package managers:** SPM and CocoaPods on iOS, so it works in both new and older Capacitor projects.

## Scope

**v1**
- **iOS:** Apple Vision `VNRecognizeTextRequest`.
  - Settings: recognition level (accurate or fast), recognition languages, automatic language detection (iOS 16+), language correction, custom words.
  - Word boxes come from `VNRecognizedText.boundingBox(for:)` over each word's range.
- **Android:** ML Kit Text Recognition v2 with the bundled model, so it works offline from first launch. Latin script by default; Chinese, Devanagari, Japanese and Korean as optional Gradle flags.
- **Web:** `isAvailable()` returns `false`, and the other methods reject with `unavailable`. Web apps keep their own engine (Tesseract.js in QuickScan).

**Later**
- iOS 26 `RecognizeDocumentsRequest` (paragraphs, tables, lists) as an opt-in `mode: 'document'`.
- Orientation hint and detection.
- Recognition from a camera frame buffer for live preview.

**Out of scope:** document detection and cropping (VisionKit / ML Kit Document Scanner plugins exist), PDF generation, and any app-specific retry or confidence policy.

## API (draft)

```ts
interface NativeOcrPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  getSupportedLanguages(options?: { level?: 'accurate' | 'fast' }): Promise<{ languages: string[] }>; // BCP-47
  recognize(options: RecognizeOptions): Promise<RecognizeResult>;
}

interface RecognizeOptions {
  /** File path or file:// URL (e.g. from a camera or scanner plugin), or base64 image data. */
  path?: string;
  base64?: string;
  /** BCP-47 tags in priority order, e.g. ['de-DE', 'en-US']. Omit for the platform default. */
  languages?: string[];
  /** iOS: let Vision detect the language (iOS 16+). Default true when `languages` is empty. */
  detectLanguage?: boolean;
  level?: 'accurate' | 'fast';          // default 'accurate'
  languageCorrection?: boolean;         // default true
  customWords?: string[];               // iOS only
}

interface RecognizeResult {
  text: string;                         // reading order, lines separated by \n
  imageSize: { width: number; height: number }; // pixels, after EXIF orientation
  blocks: Block[];                      // block → lines → words
  language?: string;                    // detected, when the engine reports it
}

interface Box { x: number; y: number; width: number; height: number } // normalized 0..1, top-left origin

interface Block { text: string; box: Box; lines: Line[] }
interface Line  { text: string; box: Box; confidence?: number; words: Word[] }
interface Word  { text: string; box: Box; confidence?: number }      // confidence 0..1
```

Design rules:
- **One coordinate system on both platforms:** normalized 0..1 with a top-left origin. Vision's bottom-left origin and ML Kit's pixel coordinates are converted inside the plugin.
- **Images are read and oriented natively.** EXIF orientation is applied before recognition, and `imageSize` reports the oriented size.
- **On-device only:** no network access and no analytics. The iOS package ships a `PrivacyInfo.xcprivacy` manifest.
- **Errors are typed codes:** `unavailable`, `invalid-image`, `unsupported-language`, `recognition-failed`.

## Quality bar before 1.0

- **Swift tests** (XCTest) and **Android instrumented tests** on fixture images, covering:
  - expected text
  - box positions within tolerance
  - rotated EXIF input
  - an unsupported language
- **CI:**
  - GitHub Actions builds the example app on a macOS runner for iOS (SPM and CocoaPods) and with Gradle for Android.
  - `npm run verify` from the plugin template.
- **README:** install steps, the supported-language lists per platform, and the coordinate system with a diagram.
- **Accuracy numbers:** QuickScan's bench corpus (`bench/`) measures CER for the plugin against Tesseract, and the README quotes the result with its date.

## How QuickScan uses it (M4)

- `src/lib/platform/native/ocr.ts` implements `OcrProvider` on top of the plugin, behind the interface from M2.
- **Mapping to `OcrResult`:**
  - Word boxes × `imageSize` → `bbox` in processed-image pixels (`OcrWord`, `src/types/index.ts`).
  - Confidence × 100, to match Tesseract's scale.
- **Languages:** QuickScan stores Tesseract codes (`deu`, `eng`, see `src/lib/ocr-languages.ts`). A table maps them to BCP-47 tags.
- **Tesseract fallback:** a page goes to Tesseract when:
  - its language isn't in `getSupportedLanguages()`, or
  - the plugin is unavailable (web, older OS).

  Tesseract supports many more languages than either platform engine, so it stays.
- **Orientation:** the 180/90/270° retry in `ocr-orientation.ts` stays for Tesseract. For the native path, orientation detection is a plugin feature planned for "Later".

## Order of work

1. Create the plugin repo from the template; build the iOS implementation and the example app.
2. Run the bench against Tesseract on the Simulator (the M4 exit: CER ≤ 0.8 % on clean print).
3. Publish `0.x` to npm and wire it into QuickScan behind `OcrProvider`.
4. Add the Android implementation alongside M5.
5. Release `1.0` once both platforms meet the quality bar above.
