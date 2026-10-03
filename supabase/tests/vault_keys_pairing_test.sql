-- vault_keys and pairing_requests: RLS between two users, anon, expiry.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

-- Expired requests, inserted as the owner (bypassing RLS) to test visibility and cleanup.
insert into public.pairing_requests (user_id, id, expires_at) values
  ('11111111-1111-1111-1111-111111111111', 'expired-a-0000000', now() - interval '1 second'),
  ('22222222-2222-2222-2222-222222222222', 'expired-b-0000000', now() - interval '1 second');

-- ---- user A -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$insert into public.vault_keys (id, method, wrapped_key, params) values ('recovery', 'recovery', '\x0102', '{"salt":"abc"}')$$,
  'A stores a recovery-wrapped key');
select lives_ok(
  $$insert into public.vault_keys (id, method, wrapped_key, params, label) values ('cred-1', 'passkey', '\x0304', '{"prf_salt":"xyz"}', 'iPhone')$$,
  'A stores a passkey-wrapped key');
select throws_ok(
  $$insert into public.vault_keys (id, method, wrapped_key, params) values ('cred-2', 'recovery', '\x01', '{}')$$,
  '23514', null, 'a recovery key must use the id ''recovery''');
select throws_ok(
  $$insert into public.vault_keys (id, method, wrapped_key, params) values ('cred-3', 'passkey', '\x01', '[]')$$,
  '23514', null, 'params must be a JSON object');
select is((select count(*) from public.vault_keys), 2::bigint, 'A sees A''s vault keys');

select is((select count(*) from public.pairing_requests), 0::bigint, 'an expired pairing request is invisible');
select lives_ok(
  $$insert into public.pairing_requests (id) values ('live-a-000000000')$$,
  'A''s new device creates a pairing request');
select is(
  (select expires_at from public.pairing_requests where id = 'live-a-000000000'), now() + interval '5 minutes',
  'it expires after 5 minutes by default');
select throws_ok(
  $$insert into public.pairing_requests (id, expires_at) values ('long-a-000000000', now() + interval '1 hour')$$,
  '42501', null, 'a request cannot live longer than 5 minutes');
select throws_ok(
  $$update public.pairing_requests set expires_at = now() + interval '1 hour' where id = 'live-a-000000000'$$,
  '42501', null, 'a request cannot be extended beyond 5 minutes');
select lives_ok(
  $$update public.pairing_requests set sealed_key = '\xabcd' where id = 'live-a-000000000'$$,
  'A''s existing device answers the request');
select is_empty(
  $$update public.pairing_requests set sealed_key = '\xabcd' where id = 'expired-a-0000000' returning id$$,
  'an expired request cannot be answered');

-- ---- user B -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is((select count(*) from public.vault_keys), 0::bigint, 'B sees none of A''s vault keys');
select is_empty($$update public.vault_keys set wrapped_key = '\xff' returning id$$, 'B cannot update A''s vault keys');
select is_empty($$delete from public.vault_keys returning id$$, 'B cannot delete A''s vault keys');
select throws_ok(
  $$insert into public.vault_keys (user_id, id, method, wrapped_key, params)
    values ('11111111-1111-1111-1111-111111111111', 'cred-b', 'passkey', '\xff', '{}')$$,
  '42501', null, 'B cannot add a vault key for A');

select is((select count(*) from public.pairing_requests), 0::bigint, 'B sees none of A''s pairing requests');
select is_empty(
  $$update public.pairing_requests set sealed_key = '\xff' where id = 'live-a-000000000' returning id$$,
  'B cannot answer A''s pairing request');
select throws_ok(
  $$insert into public.pairing_requests (user_id, id) values ('11111111-1111-1111-1111-111111111111', 'evil-b-000000000')$$,
  '42501', null, 'B cannot create a pairing request for A');

-- ---- anon ---------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$select * from public.vault_keys$$, '42501', null, 'anon cannot read vault keys');
select throws_ok($$select * from public.pairing_requests$$, '42501', null, 'anon cannot read pairing requests');
select throws_ok(
  $$insert into public.pairing_requests (user_id, id) values ('11111111-1111-1111-1111-111111111111', 'anon-0000000000000')$$,
  '42501', null, 'anon cannot create pairing requests');

-- ---- as owner -------------------------------------------------------------------
reset role;
select is(
  (select array_agg(id order by id) from public.pairing_requests),
  array['expired-b-0000000', 'live-a-000000000'],
  'A''s insert deleted A''s expired request, but not B''s');
select is(
  (select sealed_key from public.pairing_requests where id = 'live-a-000000000'), '\xabcd'::bytea,
  'A''s answer is unchanged by B');

select * from finish();
rollback;
