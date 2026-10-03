-- Private bucket for encrypted page images and other blobs, at `vault/<user_id>/<file_id>`.
-- Everything in it is ciphertext, hence application/octet-stream only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vault', 'vault', false, 20 * 1024 * 1024, '{application/octet-stream}')
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Files are immutable (a changed blob gets a new file id), so there is deliberately no update
-- policy: without one, overwriting an object (upload with upsert, move) is denied. Read, upload
-- and delete are limited to the owner's own folder.
create policy "vault: read own files" on storage.objects for select to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "vault: upload own files" on storage.objects for insert to authenticated
  with check (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "vault: delete own files" on storage.objects for delete to authenticated
  using (bucket_id = 'vault' and (storage.foldername(name))[1] = (select auth.uid())::text);
