-- End-to-end-encrypted sync: replicated records, wrapped vault keys and device pairing.
--
-- The server only ever sees ciphertext (`payload`, `wrapped_key`, `sealed_key`) plus the
-- metadata needed to merge: record kind/id, the last-write-wins clock and the device id.
-- Access is signed-in users only (`authenticated`, never `anon`), each limited to their own
-- rows by RLS.

-- ---------------------------------------------------------------------------
-- records: one row per synced Dexie record (document, page, folder, signature, setting)
-- ---------------------------------------------------------------------------

create sequence public.records_seq as bigint;
-- Only the trigger below (security definer) draws from it; no API role may touch it.
revoke all on sequence public.records_seq from public, anon, authenticated;

create table public.records (
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  kind        text        not null check (kind in ('document', 'page', 'folder', 'signature', 'settings')),
  id          text        not null,               -- the Dexie id (nanoid); settings use the setting key
  seq         bigint      not null,               -- set by trigger on every write; the pull cursor
  updated_at  timestamptz not null,               -- client time of the edit; the LWW clock
  device_id   text        not null,               -- LWW tie-breaker and "who wrote this"
  deleted     boolean     not null default false,
  key_version int         not null default 1,
  payload     bytea,                              -- encrypted on device; null when deleted
  files       text[]      not null default '{}',  -- Storage object names this record references
  primary key (user_id, kind, id),
  constraint records_id_length check (char_length(id) between 1 and 255),
  constraint records_device_id_length check (char_length(device_id) between 1 and 64),
  constraint records_key_version_positive check (key_version >= 1),
  constraint records_payload_size check (octet_length(payload) <= 2 * 1024 * 1024),
  constraint records_files_count check (cardinality(files) <= 32 and array_position(files, null) is null),
  -- A live record always carries ciphertext; a tombstone carries nothing.
  constraint records_tombstone check (
    case when deleted then payload is null and cardinality(files) = 0 else payload is not null end
  )
);

-- Pull: `where seq > :cursor order by seq limit 500` (user_id comes from RLS).
create index records_pull on public.records (user_id, seq);

-- Assigns `seq` on every insert and update, so clients can never choose it, and enforces the
-- invariants that direct Data API writes would otherwise bypass.
--
-- security definer (owner postgres) with an empty search_path: it can draw from the sequence
-- although `authenticated` has no privilege on it. The alternative, granting `authenticated`
-- usage on the sequence, would let any signed-in user burn or (with update) reset it.
--
-- The per-user advisory lock makes one user's writes commit in `seq` order: a transaction draws
-- its seq only after every earlier writer of that user has committed. Without it, a puller could
-- see seq 11 before a slower transaction holding seq 10 commits, advance its cursor past 10 and
-- never see that row.
create function public.records_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and (new.user_id, new.kind, new.id) is distinct from (old.user_id, old.kind, old.id) then
    raise exception 'records: user_id, kind and id are immutable' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('records:' || new.user_id::text, 0));

  new.seq := pg_catalog.nextval('public.records_seq');
  new.updated_at := least(new.updated_at, pg_catalog.now() + interval '5 minutes');
  return new;
end;
$$;

revoke execute on function public.records_before_write() from public, anon, authenticated;

create trigger records_before_write
  before insert or update on public.records
  for each row execute function public.records_before_write();

alter table public.records enable row level security;

-- No delete: deletions are tombstones (deleted = true) so other devices can pull them.
-- Rows disappear only with the account (on delete cascade).
grant select, insert, update on public.records to authenticated;

create policy "own records" on public.records for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- upsert_records: batched last-write-wins push
-- ---------------------------------------------------------------------------
--
-- Input: a JSON array of
--   { "kind": text, "id": text, "updated_at": ISO-8601 timestamptz, "device_id": text,
--     "deleted": boolean (default false), "key_version": int (default 1),
--     "payload": base64 string (standard alphabet, padded; omitted/null for tombstones),
--     "files": text[] (default []) }
-- Any "user_id" or "seq" in the input is ignored: user_id is auth.uid(), seq comes from the trigger.
--
-- A row is written only when its (updated_at, device_id) is greater than the stored one, or no
-- row is stored yet. updated_at is clamped to now() + 5 minutes first; device_id compares
-- bytewise (C collation), like JavaScript's `<` on ASCII strings. Tombstones (deleted = true)
-- are stored with a null payload and no files, whatever was sent.
--
-- Returns the rejected rows, i.e. those whose stored version is newer, with the stored seq,
-- updated_at and device_id; the client keeps the server version and pulls it. A row whose stored
-- clock equals the incoming one is an already-applied retry: not rewritten, not returned.
-- If the batch has the same (kind, id) twice, only the newest one counts.
create function public.upsert_records(rows jsonb)
returns table (kind text, id text, seq bigint, updated_at timestamptz, device_id text)
language plpgsql
security invoker
set search_path = ''
as $$
#variable_conflict use_column
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'upsert_records: not signed in' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(rows) is distinct from 'array' then
    raise exception 'upsert_records: rows must be a JSON array' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_array_length(rows) > 500 then
    raise exception 'upsert_records: at most 500 rows per call' using errcode = '54000';
  end if;

  -- Take the user's write lock before any row lock (see records_before_write) so concurrent
  -- pushes from two devices queue up instead of deadlocking.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('records:' || uid::text, 0));

  return query
  with input as (
    select distinct on (r.kind, r.id)
      r.kind,
      r.id,
      least(r.updated_at, pg_catalog.now() + interval '5 minutes') as updated_at,
      r.device_id,
      coalesce(r.deleted, false) as deleted,
      coalesce(r.key_version, 1) as key_version,
      case when coalesce(r.deleted, false) then null else pg_catalog.decode(r.payload, 'base64') end as payload,
      case when coalesce(r.deleted, false) then '{}'::text[] else coalesce(r.files, '{}'::text[]) end as files
    from pg_catalog.jsonb_to_recordset(rows) as r(
      kind text, id text, updated_at timestamptz, device_id text,
      deleted boolean, key_version int, payload text, files text[]
    )
    order by r.kind, r.id, 3 desc, r.device_id collate "C" desc
  ),
  written as (
    insert into public.records as t (user_id, kind, id, seq, updated_at, device_id, deleted, key_version, payload, files)
    select uid, i.kind, i.id, 0, i.updated_at, i.device_id, i.deleted, i.key_version, i.payload, i.files
    from input as i
    on conflict (user_id, kind, id) do update set
      updated_at  = excluded.updated_at,
      device_id   = excluded.device_id,
      deleted     = excluded.deleted,
      key_version = excluded.key_version,
      payload     = excluded.payload,
      files       = excluded.files
    where (excluded.updated_at, excluded.device_id collate "C") > (t.updated_at, t.device_id collate "C")
    returning t.kind, t.id
  )
  -- The outer query sees the table as it was before `written`, which for rejected rows is the
  -- stored (winning) version.
  select s.kind, s.id, s.seq, s.updated_at, s.device_id
  from input as i
  join public.records as s on s.user_id = uid and s.kind = i.kind and s.id = i.id
  where not exists (select 1 from written as w where w.kind = i.kind and w.id = i.id)
    and (s.updated_at, s.device_id collate "C") > (i.updated_at, i.device_id collate "C");
end;
$$;

-- Postgres grants EXECUTE to PUBLIC by default.
revoke execute on function public.upsert_records(jsonb) from public, anon;
grant execute on function public.upsert_records(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- vault_keys: the vault key wrapped by the recovery secret or a passkey (PRF)
-- ---------------------------------------------------------------------------

create table public.vault_keys (
  user_id     uuid        not null default auth.uid() references auth.users on delete cascade,
  id          text        not null,               -- 'recovery' or the passkey credential id
  method      text        not null check (method in ('recovery', 'passkey')),
  wrapped_key bytea       not null,
  params      jsonb       not null,               -- KDF salt/params or PRF salt
  label       text,
  created_at  timestamptz not null default now(),
  primary key (user_id, id),
  constraint vault_keys_id_length check (char_length(id) between 1 and 1024),
  constraint vault_keys_recovery_id check ((method = 'recovery') = (id = 'recovery')),
  constraint vault_keys_wrapped_key_size check (octet_length(wrapped_key) between 1 and 4096),
  constraint vault_keys_params_object check (jsonb_typeof(params) = 'object' and octet_length(params::text) <= 4096),
  constraint vault_keys_label_length check (char_length(label) <= 200)
);

alter table public.vault_keys enable row level security;

grant select, insert, update, delete on public.vault_keys to authenticated;

create policy "own vault keys" on public.vault_keys for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- pairing_requests: a new device asks an unlocked one for the vault key (QR code flow)
-- ---------------------------------------------------------------------------

create table public.pairing_requests (
  user_id    uuid        not null default auth.uid() references auth.users on delete cascade,
  id         text        not null,                -- random id carried in the QR code
  sealed_key bytea,                               -- null until the existing device answers
  expires_at timestamptz not null default now() + interval '5 minutes',
  primary key (user_id, id),
  constraint pairing_requests_id_length check (char_length(id) between 16 and 128),
  constraint pairing_requests_sealed_key_size check (octet_length(sealed_key) <= 4096)
);

alter table public.pairing_requests enable row level security;

grant select, insert, update, delete on public.pairing_requests to authenticated;

-- Expired requests are invisible (and so can't be answered or read), and a write can't push
-- expires_at further than 5 minutes ahead.
create policy "own live pairings" on public.pairing_requests for all to authenticated
  using (user_id = (select auth.uid()) and expires_at > now())
  with check (user_id = (select auth.uid()) and expires_at <= now() + interval '5 minutes');

-- Opportunistic cleanup: each new request deletes the caller's own expired requests, which RLS
-- hides from the caller. security definer because of that; it touches only auth.uid()'s rows.
create function public.pairing_requests_cleanup()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pairing_requests
  where user_id = auth.uid() and expires_at <= pg_catalog.now();
  return null;
end;
$$;

revoke execute on function public.pairing_requests_cleanup() from public, anon, authenticated;

create trigger pairing_requests_cleanup
  after insert on public.pairing_requests
  for each statement execute function public.pairing_requests_cleanup();
