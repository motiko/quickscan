# UX & accessibility rules

Rules for QuickScan's mobile UI. Each one exists because the problem happened, or is easy to introduce, and each names the check that enforces it. The `ux-reviewer` agent (`.claude/agents/ux-reviewer.md`) adds a rule here with every fix it makes. Anyone changing UI should read this list.

Prefer enforcement in this order: a rendered check in `e2e/ux.spec.ts`, then ESLint (`eslint.config.mjs`), then Vitest, and review-only as a last resort, with a reason. A rule must fail on the code that had the problem.

## Template

```md
### UX-NNN: <the rule, one sentence>
- **Why:** what the user experienced when this was broken (screen, theme, width, state).
- **Do:** how to comply, naming the shared component/utility to use.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-NNN: …" | ESLint `<rule>` | `path/to/test.ts` | review-only (reason)
- **Added:** YYYY-MM-DD, PR #
```

## Rules

### UX-001: Touch targets are at least 44×44 px
- **Why:** QuickScan is used one-handed on phones; small targets cause mis-taps (AGENTS.md › Mobile-First).
- **Do:** Give icon buttons `min-h-11 min-w-11` (or padding that gets there), pills and chips `h-11`, toolbar buttons `min-h-14 flex-1`; keep 8 px between adjacent targets. A chip with a remove button makes the button itself 44×44 (`h-11 w-11`), not the chip.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-001: touch targets are at least 44×44 px" (document page, page viewer and text sheet, light and dark). Other routes are still review-only until they're added to the check.
- **Added:** 2026-10-03 (from AGENTS.md); check added 2026-10-03

### UX-002: Every overlay closes on Escape, topmost layer first
- **Why:** Keyboard and switch-control users get trapped in layers they can't dismiss.
- **Do:** `useEscape(onClose)` in the component that renders the layer, calling the same handler as its close button (AGENTS.md › Dialogs & Overlays).
- **Enforced by:** `e2e/overlays.spec.ts` › "Escape closes the topmost layer first"
- **Added:** 2026-10-03 (from AGENTS.md)

### UX-003: No native `alert`/`confirm`/`prompt`
- **Why:** Native dialogs look foreign in an installed PWA, can't be styled for dark mode, and block the page.
- **Do:** `confirmDialog` / `alertDialog` / `promptDialog` from `src/lib/dialogs.ts`, with a question as title and a verb as the confirm label.
- **Enforced by:** `e2e/overlays.spec.ts` › "deleting a document asks in an in-app dialog"
- **Added:** 2026-10-03 (from AGENTS.md)

### UX-004: Content stays clear of the notch and home indicator
- **Why:** With `viewport-fit: cover`, fixed headers and bottom bars otherwise sit under the status bar or home indicator on iPhone.
- **Do:** Use the `pt-safe*` / `pb-safe*` / `bottom-safe*` utilities from `src/app/globals.css` on fixed and sticky edges, and `px-safe-offset-*` on full-width bars and content so landscape clears the notch.
- **Enforced by:** review-only. Playwright can't emulate safe-area insets; check on a device or in the iOS Simulator (`npm run sim`).
- **Added:** 2026-10-03 (from AGENTS.md)

### UX-005: Text meets WCAG AA contrast in both themes, disabled controls included
- **Why:** On the document page the disabled Summarize button was blue text at 50 % opacity: 2.6:1, unreadable in dark mode, while its reason sat in small grey text underneath. WCAG exempts disabled controls, but users still need to read what they can't do yet.
- **Do:** Body text ≥ 4.5:1, large text ≥ 3:1. Show "disabled" with a neutral colour (`disabled:text-gray-600 dark:disabled:text-gray-400`) and a changed shape (dashed border, no fill), not with `opacity-50` on coloured text. Secondary text is `gray-600`/`dark:gray-400` at least, not `gray-400`/`dark:gray-500`.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-005: text meets WCAG AA contrast, disabled controls included" (document page while OCR is running, light and dark). The check composites ancestor backgrounds and opacity, so faded text is measured as seen.
- **Added:** 2026-10-03

### UX-006: Bottom bars never cover the end of the content
- **Why:** The document page's action bar was `fixed` with 24 px of padding under the content, so the last row of pages sat 69 px under the bar and couldn't be scrolled clear (worse at large text).
- **Do:** Put the bar last in a `min-h-dvh flex-col` layout with `sticky bottom-0` instead of `fixed` plus a guessed padding. It stays pinned while scrolling and the content always ends above it, whatever the bar's height.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-006: the bottom toolbar never covers page content" (6 pages at 375×667, scrolled to the end).
- **Added:** 2026-10-03

### UX-007: Anything that looks clickable is a real, focusable control
- **Why:** Page thumbnails were `div`s with `onClick` and the document title an `h1` with `onClick`: keyboard and switch users couldn't open a page or rename the document.
- **Do:** Use `<button>` (or a link). If it shows `cursor-pointer` or reacts to a click, it must be a button, link or form control.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-007: anything that looks clickable is a focusable control" (no element with `cursor: pointer` outside a control). ESLint's `jsx-a11y/no-static-element-interactions` would also flag it but also every backdrop-click overlay, so it's not enabled.
- **Added:** 2026-10-03

### UX-008: A modal layer takes focus when it opens and gives it back when it closes
- **Why:** The full-screen page viewer left focus on the page underneath, had no dialog role, and Tab walked through the hidden page.
- **Do:** `role="dialog" aria-modal="true"` with a label, focus its close button on open, mark what's underneath `inert`, and on close focus the control that opened it.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-008: the page viewer takes focus when it opens and gives it back when it closes".
- **Added:** 2026-10-03

### UX-009: Header and toolbar actions show a text label
- **Why:** The document header had an unlabelled copy icon next to "Share PDF". Its tooltip never shows on touch, so people had to guess (it copied all text, which the Text sheet already offers).
- **Do:** Every action in a page header or action bar has a visible label. Only universally understood icons (back, close) may be icon-only. If there's no room, move the action into a sheet or the screen it belongs to rather than dropping its label.
- **Enforced by:** `e2e/ux.spec.ts` › "UX-009: header and toolbar actions show a text label" (`header` buttons and `role="group"` bars labelled "… actions"; Back is the exception).
- **Added:** 2026-10-03

### UX-010: Layouts survive 200 % text
- **Why:** At 200 % text on a 375 px phone, the document header's fixed `h-16` clipped the title, the bottom bar labels stayed at 11 px (`text-[11px]` ignores the user's text size), and the page scrolled sideways.
- **Do:** Font sizes in rem (`text-xs` …, or `text-[0.6875rem]`), never px. Bars use `min-h-*` and `flex-wrap`, not fixed heights. Where large text can't fit, use a container query (`@container` + `@min-[20rem]:`) to drop toolbar labels to `sr-only` or move the title onto its own row, not to clip it. Avoid rem-sized minimum widths in rows (`min-w-[min(12rem,100%)]`).
- **Enforced by:** ESLint `no-restricted-syntax` (px font sizes in class strings, `eslint.config.mjs`) and `e2e/ux.spec.ts` › "UX-010: the header grows with 200% text instead of clipping" (header children inside the header, no horizontal overflow, toolbar labels scale).
- **Added:** 2026-10-03

### UX-011: Copy names the action, not the gesture, and editable things look editable
- **Why:** The document header said "1 page • Tap title to rename" (with a "Click to rename" tooltip). Wrong for keyboard and mouse users, easy to miss, and the title itself gave no hint it was editable.
- **Do:** Show an affordance (a pencil next to the title) on a real button, and describe actions without "tap"/"click".
- **Enforced by:** ESLint `no-restricted-syntax` (JSX text and string attributes matching "tap …"/"click …").
- **Added:** 2026-10-03

### UX-012: A disabled control says why
- **Why:** The disabled Summarize button's reason was a separate line of text that screen readers didn't associate with the button.
- **Do:** Link the reason with `aria-describedby`. If nothing the user can do (or wait for) will enable it, hide the control instead and explain the situation where it can be fixed (UX-013).
- **Enforced by:** `e2e/ux.spec.ts` › "UX-012: a disabled control says why" (every disabled button on the document page has a non-empty description).
- **Added:** 2026-10-03

### UX-013: When an automatic step finds nothing, say how to fix it
- **Why:** An upside-down scan got no text from OCR. The page showed only a dimmed Summarize button and "No recognized text to summarize yet", so it looked like the text was still coming, and nothing pointed to Rotate in the page viewer.
- **Do:** Say what happened and what to do, with a button that goes there ("No text recognized … open it and use Rotate" + "Open page"). Don't leave buttons that wait for something that will never come. Where a fix can be automatic, make it so: OCR now turns upside-down and sideways pages upright (`lib/ocr-orientation.ts`).
- **Enforced by:** `e2e/ux.spec.ts` › "UX-013: when recognition finds no text, the page says how to fix it instead of offering dead ends", and `src/lib/__tests__/ocr-orientation.test.ts` for the automatic orientation.
- **Added:** 2026-10-03
