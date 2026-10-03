---
name: supabase-migration
description: Add or change QuickScan's Supabase schema — a new migration in supabase/migrations/ with RLS, grants, function hardening and pgTAP tests in supabase/tests/, plus the deploy-order note for the PR. Use for any table, column, policy, function, trigger, or storage bucket change.
---

# Supabase migration (QuickScan)

Load the `supabase-postgres-best-practices` skill too; this skill adds the project rules from `AGENTS.md` → "Accounts & Supabase".

**Never** run `supabase link` or `supabase db push` — the owner applies migrations to production by hand.

## 1. Create the file

```bash
npx supabase migration new <snake_case_name>   # → supabase/migrations/<timestamp>_<name>.sql
```

Look at the existing migrations first (`supabase/migrations/`) and match their style and comment density.

## 2. Required in the migration

- **Tables**
  - `alter table public.<t> enable row level security;` — explicit even though automatic RLS is on.
  - Policies scoped to `auth.uid()` (e.g. `using (user_id = (select auth.uid()))`, plus `with check` on insert/update), one per operation actually needed.
  - `grant select, insert, update, delete on public.<t> to authenticated;` — only the operations needed; **never** grant to `anon`. The project doesn't auto-expose new tables.
- **Functions**
  - `security invoker` and `set search_path = ''`, schema-qualify everything (`public.records`, `auth.uid()`).
  - `security definer` only when unavoidable, never with input-driven queries, only touching `auth.uid()`'s rows.
  - `revoke execute on function public.<f>(…) from public, anon;` and, if clients call it, `grant execute … to authenticated;`.
- **Storage:** bucket private, `storage.objects` policies scoped to the user's own path prefix (see `20261003022946_vault_storage.sql`).
- **Data stays encrypted:** columns hold ciphertext (`bytea`) from `src/lib/crypto`; never add a plaintext user-content column. Clients send `bytea` as `'\x' + hex` via `toBytea`/`fromBytea` (`src/lib/bytea.ts`).

## 3. pgTAP tests

Add or extend `supabase/tests/<area>_test.sql`, following `records_test.sql`: `begin; … select plan(n); … select * from finish(); rollback;`, two users in `auth.users`, and switch identity with `set_config('request.jwt.claims', …)` + `set local role authenticated|anon`.

Cover for **each** policy and constraint: owner can, other user can't (sees 0 rows / gets an error), `anon` can't, plus every check constraint and function grant (e.g. `throws_ok` for `anon` executing it).

```bash
npx supabase start          # Docker, local only
npx supabase db reset       # applies all migrations to the local stack
npx supabase test db
```

If client code in `src/lib/sync/` or `vault-session.ts` changes too, also run `npm run test:supabase` against the local stack.

## 4. Client compatibility & PR

- Client code should keep working against the schema **before** the migration where it reasonably can (the owner deploys the migration separately).
- The PR body states the deploy order, e.g. "Apply `<file>` with `npx supabase@2.119.0 db push` before/after merging."
- Before the PR, run the `security-reviewer` agent on the branch.
