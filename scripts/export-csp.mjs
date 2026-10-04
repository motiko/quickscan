#!/usr/bin/env node
// Content-Security-Policy for the static export (the native app). With no server there is no
// nonce and no response header, so each exported page gets a <meta> policy, first in <head>,
// that allows exactly its own inline scripts by SHA-256 hash. The policy itself comes from
// src/lib/csp.ts (buildExportCsp), shared with the web build. See SECURITY.md, "Native app".
//
//   node scripts/export-csp.mjs          inject the policy into out/**/*.html, then check it
//   node scripts/export-csp.mjs --check  only check: exits 1 if any inline script lacks its hash
//
// scripts/build-export.mjs runs both after `next build`, so a page that would break fails the build.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExportCsp } from '../src/lib/csp.ts';

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const CSP_META = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/?>/gi;
// <meta charset> must stay within the first 1024 bytes, and the iOS shell serves HTML without
// a charset, so it stays ahead of the (long) policy. It loads nothing, so nothing escapes the CSP.
const HEAD_START = /<head(?:\s[^>]*)?>(?:\s*<meta\s+charset=["']?[\w-]+["']?\s*\/?>)?/i;

/** Bodies of the inline `<script>` elements (no `src`), exactly as they appear in the HTML. */
export function inlineScripts(html) {
  return [...html.matchAll(SCRIPT)].filter(([, attrs]) => !/\ssrc\s*=/i.test(` ${attrs}`)).map(([, , body]) => body);
}

/** Base64 SHA-256 of a script body, as CSP hashes it (UTF-8, no normalization). */
export function scriptHash(body) {
  return createHash('sha256').update(body, 'utf8').digest('base64');
}

function escapeAttribute(value) {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function unescapeAttribute(value) {
  return value.replaceAll('&quot;', '"').replaceAll('&amp;', '&');
}

/** The page with its <meta> CSP and referrer policy first in <head> (after <meta charset> only). */
export function injectCsp(html, options = {}) {
  if ([...html.matchAll(CSP_META)].length > 0) throw new Error('page already has a CSP <meta>');
  const head = HEAD_START.exec(html);
  if (!head) throw new Error('page has no <head>');
  const hashes = [...new Set(inlineScripts(html).map(scriptHash))];
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(buildExportCsp(hashes, options))}"/>`
    // The web build's Referrer-Policy header (csp.ts), which <meta name="referrer"> can carry.
    + '<meta name="referrer" content="no-referrer"/>';
  const at = head.index + head[0].length;
  return html.slice(0, at) + meta + html.slice(at);
}

function directive(policy, name) {
  for (const part of policy.split(';')) {
    const [key, ...values] = part.trim().split(/\s+/);
    if (key === name) return values;
  }
  return undefined;
}

/** What's wrong with a page's CSP; empty when every inline script is allowed and nothing precedes the policy. */
export function cspProblems(html) {
  const metas = [...html.matchAll(CSP_META)];
  if (metas.length !== 1) return [`expected one CSP <meta>, found ${metas.length}`];
  const [meta] = metas;
  const problems = [];

  const head = HEAD_START.exec(html);
  if (!head || head.index + head[0].length !== meta.index) {
    problems.push('the CSP <meta> is not first in <head>');
  }

  const scriptSrc = directive(unescapeAttribute(meta[1]), 'script-src');
  if (!scriptSrc) return [...problems, 'the policy has no script-src'];
  for (const keyword of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'"]) {
    if (scriptSrc.includes(keyword)) problems.push(`script-src allows ${keyword}`);
  }
  for (const body of inlineScripts(html)) {
    const hash = scriptHash(body);
    if (!scriptSrc.includes(`'sha256-${hash}'`)) {
      problems.push(`inline script without its hash ${hash}: ${JSON.stringify(body.slice(0, 60))}`);
    }
  }
  return problems;
}

function htmlFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Injects the policy into every exported page. Returns the number of pages. */
export function writeExportCsp(outDir, options = {}) {
  const files = htmlFiles(outDir);
  for (const file of files) writeFileSync(file, injectCsp(readFileSync(file, 'utf8'), options));
  return files.length;
}

/** Problems in every exported page, prefixed with the page's path; empty when all pass. */
export function checkExportCsp(outDir) {
  const files = htmlFiles(outDir);
  if (files.length === 0) return [`no pages in ${outDir}`];
  return files.flatMap((file) =>
    cspProblems(readFileSync(file, 'utf8')).map((problem) => `${relative(outDir, file)}: ${problem}`),
  );
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outDir = join(root, 'out');
  if (!process.argv.includes('--check')) {
    // The Supabase origin goes into connect-src. Next inlined NEXT_PUBLIC_SUPABASE_URL from the
    // same .env files, so load them the way `next build` does.
    const { default: nextEnv } = await import('@next/env');
    nextEnv.loadEnvConfig(root, false, { info: () => {}, error: console.error });
    const pages = writeExportCsp(outDir, {
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      // The app's origin is a secure context (capacitor://localhost, https://localhost).
      upgradeInsecureRequests: true,
    });
    console.log(`Added a hash-based CSP <meta> to ${pages} exported pages`);
  }
  const problems = checkExportCsp(outDir);
  if (problems.length > 0) {
    console.error(`CSP check failed:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log('CSP check passed: every inline script in out/ is allowed by its hash');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
