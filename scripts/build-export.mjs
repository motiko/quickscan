#!/usr/bin/env node
// Static export of the app into out/ for the native (Capacitor) shell.
//
// `output: 'export'` refuses what only a server can do, so the server-only files are moved
// aside for the build and always moved back: the proxy (per-request CSP nonce), the /api/llm
// route handler, and /doc/[id] (unknown ids can't be prerendered; the export uses /doc?id=).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(dirname(new URL(import.meta.url).pathname), '..');
const stash = join(root, '.export-stash');
const SERVER_ONLY = ['src/proxy.ts', 'src/app/api', 'src/app/doc/[id]'];

function restore() {
  for (const path of SERVER_ONLY) {
    const from = join(stash, path);
    if (!existsSync(from)) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    renameSync(from, join(root, path));
  }
  rmSync(stash, { recursive: true, force: true });
}

// A previous run that was killed hard may have left files in the stash.
restore();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

let status = 1;
try {
  for (const path of SERVER_ONLY) {
    const to = join(stash, path);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(root, path), to);
  }
  const result = spawnSync('npx', ['next', 'build'], {
    cwd: root,
    stdio: 'inherit',
    // A separate distDir would keep the web build's cache intact, but Next requires it inside
    // the project; .next is simply rebuilt.
    env: { ...process.env, NEXT_PUBLIC_BUILD_TARGET: 'export' },
  });
  status = result.status ?? 1;
} finally {
  restore();
}
process.exit(status);
