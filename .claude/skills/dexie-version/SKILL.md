---
name: dexie-version
description: Change QuickScan's IndexedDB schema — a new db.version() in src/lib/db.ts (new table, index, field backfill or data migration), keeping it sync-ready and upgrade-safe on iOS. Use for any change to the Dexie data model or a new persisted field.
---

# Dexie schema change (QuickScan)

`src/lib/db.ts` is the single source of truth for the data model. Every installed device upgrades through each version in order, so a version, once merged, is never edited — add a new one.

## 1. Add the version

Append `db.version(N + 1)` after the last one (read the file for the current number). Follow the existing pattern: a short comment above it saying *why*, `.stores({...})` with only the tables that change (`stores({})` for an upgrade-only version), and `.upgrade(async (tx) => …)` for backfills.

- Inside `upgrade`, use only `tx.table(...)` and await only Dexie calls — no `fetch`, crypto, timers or helper promises (they break the transaction zone).
- Optional fields need no backfill (`folderId`/`tags` in v6 are the model). Prefer optional over backfilling every row.
- Store binary data as `Blob`, never Base64.

## 2. Keep it sync-ready

- New records: nanoid string `id`, `createdAt`, `updatedAt`.
- A new **synced** table, or a new **local-only** field on a synced table (thumbnails, caches, status flags), goes in `TRACKED_TABLES` in `src/lib/sync-tracking.ts`. Synced data also needs its payload in `src/lib/sync/payload.ts`. If the change touches sync, run the `sync-reviewer` agent.
- If existing records must reach the server after the upgrade, queue them in the outbox the way v7 does.
- Update the Data Model section of `AGENTS.md` (and `CLAUDE.md` if the architecture summary changes).

## 3. Test the upgrade

- Unit test the upgrade logic in `src/lib/__tests__/` with `fake-indexeddb` (see `sync-groundwork-migration.test.ts`, `folders-tags-migration.test.ts`).
- **Extend `e2e/upgrade.spec.ts`** — required for every new version: seed the previous schema with data, upgrade, assert the data survived; the blocked-upgrade case (another tab holding the old connection) must still show `DatabaseGate` instead of hanging.

```bash
npx vitest run src/lib/__tests__/<your-migration>.test.ts
npm run build && E2E_SERVER=prod npx playwright test e2e/upgrade.spec.ts
```

The second command runs WebKit too (CI only runs Chromium); run it locally since every iOS browser is WebKit.
