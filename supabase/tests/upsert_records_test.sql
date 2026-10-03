-- upsert_records: last-write-wins, tie-break by device_id, clamping, user_id, rejected rows.
begin;
create extension if not exists pgtap with schema extensions;
select plan(29);

insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'a@example.com');

select has_function('public', 'upsert_records', array['jsonb'], 'upsert_records(jsonb) exists');
select ok(
  (select not prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.upsert_records(jsonb)'::regprocedure),
  'upsert_records is security invoker with an empty search_path');
select ok(not has_function_privilege('anon', 'public.upsert_records(jsonb)', 'execute'), 'anon cannot execute upsert_records');
select ok(has_function_privilege('authenticated', 'public.upsert_records(jsonb)', 'execute'), 'authenticated can execute upsert_records');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

-- Build one input row: (id, updated_at, device_id, payload text)
create function pg_temp.row(id text, ts text, dev text, body text)
returns jsonb language sql as $$
  select jsonb_build_object('kind', 'document', 'id', id, 'updated_at', ts, 'device_id', dev,
                            'payload', encode(convert_to(body, 'UTF8'), 'base64'))
$$;
create function pg_temp.body(rid text) returns text language sql as $$
  select convert_from(payload, 'UTF8') from public.records where kind = 'document' and id = rid
$$;

-- insert when absent
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T10:00:00Z', 'dev-m', 'v1')))$$,
  'a new record is accepted');
select is(pg_temp.body('d1'), 'v1', 'the base64 payload is decoded and stored');
select is((select files from public.records where id = 'd1'), '{}'::text[], 'files default to empty');

-- newer wins
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T11:00:00Z', 'dev-m', 'v2')))$$,
  'a newer version is accepted');
select is(pg_temp.body('d1'), 'v2', 'the newer version is stored');

-- older loses, and is returned with the stored clock
select results_eq(
  $$select kind, id, updated_at, device_id from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T09:00:00Z', 'dev-z', 'old')))$$,
  $$values ('document'::text, 'd1'::text, '2026-01-01T11:00:00Z'::timestamptz, 'dev-m'::text)$$,
  'an older version is rejected and returned with the stored updated_at/device_id');
select is(pg_temp.body('d1'), 'v2', 'the older version is not stored');
select ok(
  (select r.seq = s.seq from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T09:00:00Z', 'dev-z', 'old'))) r
     join public.records s on s.id = r.id),
  'the rejected row carries the stored seq');

-- ties on updated_at: the greater device_id wins (bytewise)
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T11:00:00Z', 'dev-n', 'tie-n')))$$,
  'same updated_at, greater device_id is accepted');
select is(pg_temp.body('d1'), 'tie-n', 'the greater device_id wins the tie');
select results_eq(
  $$select id from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T11:00:00Z', 'dev-M', 'tie-M')))$$,
  $$values ('d1'::text)$$,
  'same updated_at, smaller device_id is rejected (uppercase sorts first bytewise)');

-- an identical clock is an already-applied retry: neither rewritten nor rejected
create temp table seq_before as select seq from public.records where id = 'd1';
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d1', '2026-01-01T11:00:00Z', 'dev-n', 'retry')))$$,
  'a retry with the stored clock is not reported as rejected');
select is((select seq from public.records where id = 'd1'), (select seq from seq_before), '... and does not rewrite the row');

-- clamp future timestamps
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d2', '2099-01-01T00:00:00Z', 'dev-m', 'future')))$$,
  'a far-future version is accepted ...');
select is(
  (select updated_at from public.records where id = 'd2'), now() + interval '5 minutes',
  '... with updated_at clamped to now() + 5 minutes');

-- client-sent user_id and seq are ignored
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(pg_temp.row('d3', '2026-01-01T00:00:00Z', 'dev-m', 'x')
      || '{"user_id":"22222222-2222-2222-2222-222222222222","seq":1}'))$$,
  'a row with a foreign user_id and a seq is accepted ...');
select ok(
  (select user_id = '11111111-1111-1111-1111-111111111111' and seq <> 1 from public.records where id = 'd3'),
  '... as the caller''s row with a server-assigned seq');

-- tombstones keep their (authenticated) payload and drop files
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(jsonb_build_object(
      'kind', 'document', 'id', 'd1', 'updated_at', '2026-01-02T00:00:00Z', 'device_id', 'dev-m',
      'deleted', true, 'payload', encode('\x0102'::bytea, 'base64'), 'files', jsonb_build_array('f1'))))$$,
  'a newer tombstone is accepted');
select ok(
  (select deleted and payload = '\x0102'::bytea and files = '{}' from public.records where id = 'd1'),
  'the tombstone is stored with its payload and without files');

-- tombstones from older clients, without a payload, are still accepted
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(jsonb_build_object(
      'kind', 'document', 'id', 'd5', 'updated_at', '2026-01-02T00:00:00Z', 'device_id', 'dev-m', 'deleted', true)))$$,
  'a tombstone without a payload is accepted');
select ok(
  (select deleted and payload is null and files = '{}' from public.records where id = 'd5'),
  '... and stored without one');

-- a tombstone payload over 256 bytes fails the whole call
select throws_ok(
  $$select * from public.upsert_records(jsonb_build_array(jsonb_build_object(
      'kind', 'document', 'id', 'd6', 'updated_at', '2026-01-02T00:00:00Z', 'device_id', 'dev-m',
      'deleted', true, 'payload', encode(decode(repeat('00', 257), 'hex'), 'base64'))))$$,
  '23514', null, 'a tombstone payload over 256 bytes is rejected');
select ok(not exists (select 1 from public.records where id = 'd6'), '... and nothing is stored');

-- mixed batch: rejected rows only
select results_eq(
  $$select id from public.upsert_records(jsonb_build_array(
      pg_temp.row('d1', '2026-01-01T00:00:00Z', 'dev-m', 'stale'),
      pg_temp.row('d4', '2026-01-01T00:00:00Z', 'dev-m', 'new'),
      pg_temp.row('d3', '2026-01-03T00:00:00Z', 'dev-m', 'newer')))$$,
  $$values ('d1'::text)$$,
  'a mixed batch returns only the rejected rows');
select is(
  (select array_agg(convert_from(payload, 'UTF8') order by id) from public.records where id in ('d3', 'd4')),
  array['newer', 'new'], '... and writes the others');

select * from finish();
rollback;
