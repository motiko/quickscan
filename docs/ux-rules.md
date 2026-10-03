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
- **Do:** Give icon buttons `min-h-11 min-w-11` (or padding that gets there); keep 8 px between adjacent targets.
- **Enforced by:** review-only for now. The first `e2e/ux.spec.ts` check should measure every visible button and link on each route.
- **Added:** 2026-10-03 (from AGENTS.md)

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
- **Do:** Use the `pt-safe*` / `pb-safe*` / `bottom-safe*` utilities from `src/app/globals.css` on fixed and sticky edges.
- **Enforced by:** review-only. Playwright can't emulate safe-area insets; check on a device or in the iOS Simulator (`npm run sim`).
- **Added:** 2026-10-03 (from AGENTS.md)
