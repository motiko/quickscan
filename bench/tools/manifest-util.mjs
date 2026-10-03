// Shared manifest helpers for the corpus tools.

import fs from 'node:fs';

export function readManifest(file) {
  if (!fs.existsSync(file)) return { version: 2, cases: [] };
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(m.cases)) m.cases = [];
  m.version = 2;
  return m;
}

export function writeManifest(file, manifest) {
  manifest.version = 2;
  manifest.cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
}

// Merge `entries` into the manifest at `file`. Existing cases for which
// `replace(existing)` returns true are dropped first (e.g. "all synthetic cases",
// or "the ids being re-extracted"); everything else is kept untouched, so tools
// owning different id prefixes can share one manifest.
export function mergeManifestEntries(file, entries, replace) {
  const manifest = readManifest(file);
  const keep = manifest.cases.filter((c) => !replace(c));
  manifest.cases = [...keep, ...entries];
  writeManifest(file, manifest);
  return manifest;
}

// Update fields of existing cases in place (used by autolabel and the labeller export).
export function patchManifestCases(file, patches) {
  const manifest = readManifest(file);
  const byId = new Map(manifest.cases.map((c) => [c.id, c]));
  let n = 0;
  for (const [id, patch] of Object.entries(patches)) {
    const c = byId.get(id);
    if (!c) continue;
    Object.assign(c, patch);
    n++;
  }
  writeManifest(file, manifest);
  return n;
}
