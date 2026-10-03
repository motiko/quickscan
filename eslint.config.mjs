import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// docs/ux-rules.md: patterns that break a UX rule and can be spotted in source
const PX_FONT_SIZE = String.raw`/(^|\s|:)text-\[\d+(\.\d+)?px\]/`;
// "Tap the title", "Click here": UI copy that names a gesture instead of the action
const POINTER_WORDING = String.raw`/\b([Tt]ap|[Cc]lick)s? [A-Za-z]/`;
const uxRestrictions = [
  {
    selector: `Literal[value=${PX_FONT_SIZE}]`,
    message: 'UX-010: font sizes in px ignore the user’s text size. Use text-xs/sm/… or a rem value (text-[0.6875rem]).',
  },
  {
    selector: `TemplateElement[value.raw=${PX_FONT_SIZE}]`,
    message: 'UX-010: font sizes in px ignore the user’s text size. Use text-xs/sm/… or a rem value (text-[0.6875rem]).',
  },
  {
    selector: `JSXText[value=${POINTER_WORDING}]`,
    message: 'UX-011: “tap”/“click” assumes one kind of pointer. Name the action instead, and make it a visible control.',
  },
  {
    selector: `JSXAttribute > Literal[value=${POINTER_WORDING}]`,
    message: 'UX-011: “tap”/“click” assumes one kind of pointer. Name the action instead, and make it a visible control.',
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...uxRestrictions] },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Agent worktrees carry their own checkouts and build output
    ".claude/**",
    // Tesseract worker and cores copied from node_modules by scripts/copy-tesseract.mjs
    "public/tesseract/**",
  ]),
]);

export default eslintConfig;
