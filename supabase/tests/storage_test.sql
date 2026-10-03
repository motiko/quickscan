-- The private `vault` bucket: config and per-user folder policies.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

select results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'vault'$$,
  $$values (false, 20971520::bigint, array['application/octet-stream'])$$,
  'vault is private, capped at 20 MB and octet-stream only');

-- The Storage API sets this before deleting rows; direct SQL deletes are blocked otherwise.
select set_config('storage.allow_delete_query', 'true', true);

-- ---- user A -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('vault', '11111111-1111-1111-1111-111111111111/file-1')$$,
  'A uploads into A''s folder');
select lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('vault', '11111111-1111-1111-1111-111111111111/file-2')$$,
  'A uploads a second file');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('vault', '22222222-2222-2222-2222-222222222222/file-x')$$,
  '42501', null, 'A cannot upload into B''s folder');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('vault', 'file-root')$$,
  '42501', null, 'A cannot upload outside a user folder');
select is((select count(*) from storage.objects where bucket_id = 'vault'), 2::bigint, 'A sees A''s files');
select is_empty(
  $$update storage.objects set name = '11111111-1111-1111-1111-111111111111/renamed' where name like '%/file-1' returning name$$,
  'files are immutable: even A cannot update or overwrite them');
select results_eq(
  $$delete from storage.objects where name like '%/file-2' returning name$$,
  $$values ('11111111-1111-1111-1111-111111111111/file-2'::text)$$,
  'A can delete A''s files');

-- ---- user B -------------------------------------------------------------------
select set_config('request.jwt.claims', '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}', true);

select is((select count(*) from storage.objects where bucket_id = 'vault'), 0::bigint, 'B sees none of A''s files');
select is_empty($$update storage.objects set metadata = '{}' returning name$$, 'B cannot update A''s files');
select is_empty($$delete from storage.objects returning name$$, 'B cannot delete A''s files');

-- ---- anon ---------------------------------------------------------------------
reset role;
set local role anon;
select is((select count(*) from storage.objects where bucket_id = 'vault'), 0::bigint, 'anon sees no vault files');

reset role;
select is(
  (select array_agg(name) from storage.objects where bucket_id = 'vault'),
  array['11111111-1111-1111-1111-111111111111/file-1'], 'A''s remaining file is untouched');

select * from finish();
rollback;
