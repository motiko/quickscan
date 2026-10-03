-- Authenticated tombstones (pentest 2026-10, finding 9.1).
--
-- A deletion used to be stored with no payload, so nothing authenticated it: anyone who can
-- write the table without the vault key could insert a tombstone for any record. Clients now
-- seal each deletion as a small record payload (format v2, deleted = '1' in the AAD), and
-- devices verify it before deleting anything. This migration lets a tombstone keep that
-- payload.
--
-- Non-breaking: tombstones without a payload (older clients, existing rows) are still valid,
-- and clients treat them as unverified. Live rows are unchanged; the 2 MB cap
-- (records_payload_size) stays.

-- A live record always carries ciphertext; a tombstone carries at most a small authenticated
-- payload, and never files.
alter table public.records drop constraint records_tombstone;
alter table public.records add constraint records_tombstone check (
  case
    when deleted then (payload is null or octet_length(payload) <= 256) and cardinality(files) = 0
    else payload is not null
  end
);

-- upsert_records: as before, except that a tombstone now keeps the payload it was sent (a
-- tombstone payload over 256 bytes fails the constraint above, rejecting the whole call).
-- Files sent with a tombstone are still dropped, as older clients may send some.
--
-- Input: a JSON array of
--   { "kind": text, "id": text, "updated_at": ISO-8601 timestamptz, "device_id": text,
--     "deleted": boolean (default false), "key_version": int (default 1),
--     "payload": base64 string (standard alphabet, padded; optional for tombstones),
--     "files": text[] (default []) }
-- Any "user_id" or "seq" in the input is ignored: user_id is auth.uid(), seq comes from the trigger.
--
-- A row is written only when its (updated_at, device_id) is greater than the stored one, or no
-- row is stored yet. updated_at is clamped to now() + 5 minutes first; device_id compares
-- bytewise (C collation), like JavaScript's `<` on ASCII strings. Tombstones (deleted = true)
-- are stored with the payload that was sent (or null) and no files.
--
-- Returns the rejected rows, i.e. those whose stored version is newer, with the stored seq,
-- updated_at and device_id; the client keeps the server version and pulls it. A row whose stored
-- clock equals the incoming one is an already-applied retry: not rewritten, not returned.
-- If the batch has the same (kind, id) twice, only the newest one counts.
create or replace function public.upsert_records(rows jsonb)
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
      pg_catalog.decode(r.payload, 'base64') as payload,
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

-- `create or replace` keeps the existing grants; restated so this file stands on its own.
revoke execute on function public.upsert_records(jsonb) from public, anon;
grant execute on function public.upsert_records(jsonb) to authenticated;
