-- public.records: RLS between two users, anon, no deletes, seq assignment, constraints.
begin;
create extension if not exists pgtap with schema extensions;
select plan(31);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

-- ---- user A writes ----------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload, files)
    values ('document', 'doc-a', '2026-01-01T00:00:00Z', 'dev-a', '\x01', '{f1}')$$,
  'A inserts a record directly');
select lives_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload, seq)
    values ('page', 'page-a', '2026-01-01T00:00:00Z', 'dev-a', '\x02', 999999999)$$,
  'A inserts a record with a client-chosen seq');
select ok(
  (select user_id = '11111111-1111-1111-1111-111111111111' from public.records where id = 'doc-a'),
  'user_id defaults to auth.uid()');

-- seq
select ok((select seq from public.records where id = 'page-a') <> 999999999, 'a client-sent seq on insert is replaced');
select ok(
  (select seq from public.records where id = 'page-a') > (select seq from public.records where id = 'doc-a'),
  'seq increases with each write');
select set_config('test.seq_before', (select max(seq)::text from public.records), true);
update public.records set seq = 1, payload = '\x03' where id = 'doc-a';
select ok((select seq from public.records where id = 'doc-a') > current_setting('test.seq_before')::bigint, 'an update gets a new, higher seq, ignoring a client-sent one');
select throws_ok(
  $$select pg_catalog.nextval('public.records_seq')$$, '42501', null,
  'authenticated cannot use the seq sequence');
select throws_ok(
  $$update public.records set id = 'renamed' where id = 'doc-a'$$, '42501', null,
  'kind/id are immutable');

-- updated_at clamp on direct writes
insert into public.records (kind, id, updated_at, device_id, payload)
  values ('folder', 'future', now() + interval '1 day', 'dev-a', '\x01');
select ok(
  (select updated_at <= now() + interval '5 minutes' from public.records where id = 'future'),
  'a future updated_at is clamped to now() + 5 minutes');

-- no deletes, only tombstones
select throws_ok($$delete from public.records where id = 'doc-a'$$, '42501', null, 'deleting a record is denied');
select lives_ok(
  $$update public.records set deleted = true, payload = null, files = '{}' where id = 'future'$$,
  'a record can become a tombstone');

-- constraints
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload)
    values ('page', 'big', now(), 'dev-a', decode(repeat('00', 2 * 1024 * 1024 + 1), 'hex'))$$,
  '23514', null, 'a payload over 2 MB is rejected');
select lives_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload)
    values ('page', 'max', now(), 'dev-a', decode(repeat('00', 2 * 1024 * 1024), 'hex'))$$,
  'a payload of exactly 2 MB is accepted');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, deleted, payload)
    values ('page', 'tomb1', now(), 'dev-a', true, '\x01')$$,
  '23514', null, 'a tombstone with a payload is rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, deleted, files)
    values ('page', 'tomb2', now(), 'dev-a', true, '{f1}')$$,
  '23514', null, 'a tombstone with files is rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id)
    values ('page', 'nopayload', now(), 'dev-a')$$,
  '23514', null, 'a live record without payload is rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload) values ('page', '', now(), 'dev-a', '\x01')$$,
  '23514', null, 'an empty id is rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload) values ('page', 'p', now(), repeat('d', 65), '\x01')$$,
  '23514', null, 'an overlong device_id is rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload, files)
    values ('page', 'p', now(), 'dev-a', '\x01', array(select 'f' || g from generate_series(1, 33) g))$$,
  '23514', null, 'more than 32 files are rejected');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload) values ('photo', 'p', now(), 'dev-a', '\x01')$$,
  '23514', null, 'an unknown kind is rejected');

-- ---- user B sees and changes nothing of A's ----------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is((select count(*) from public.records), 0::bigint, 'B sees none of A''s records');
select is_empty(
  $$update public.records set payload = '\xff' where id = 'doc-a' returning id$$,
  'B cannot update A''s records');
select throws_ok(
  $$insert into public.records (user_id, kind, id, updated_at, device_id, payload)
    values ('11111111-1111-1111-1111-111111111111', 'document', 'doc-a', now(), 'dev-b', '\xff')$$,
  '42501', null, 'B cannot insert a record as A');
select is_empty(
  $$select * from public.upsert_records(jsonb_build_array(jsonb_build_object(
      'user_id', '11111111-1111-1111-1111-111111111111', 'kind', 'document', 'id', 'doc-a',
      'updated_at', '2030-01-01T00:00:00Z', 'device_id', 'zzz', 'payload', encode('\xff'::bytea, 'base64'))))$$,
  'B upserting A''s id with A''s user_id is not rejected ...');
select is((select count(*) from public.records), 1::bigint, '... because it lands in B''s own records');

-- ---- anon gets nothing --------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$select * from public.records$$, '42501', null, 'anon cannot read records');
select throws_ok(
  $$insert into public.records (kind, id, updated_at, device_id, payload) values ('page', 'x', now(), 'd', '\x01')$$,
  '42501', null, 'anon cannot insert records');
select throws_ok($$update public.records set deleted = true$$, '42501', null, 'anon cannot update records');
select throws_ok(
  $$select public.upsert_records('[]'::jsonb)$$, '42501', null, 'anon cannot call upsert_records');

-- ---- as owner: A's rows are untouched -------------------------------------------
reset role;
select is(
  (select payload from public.records where user_id = '11111111-1111-1111-1111-111111111111' and id = 'doc-a'),
  '\x03'::bytea, 'A''s record is unchanged by B');
select is(
  (select count(*) from public.records where user_id = '22222222-2222-2222-2222-222222222222'),
  1::bigint, 'B owns exactly the one record B upserted');

select * from finish();
rollback;
