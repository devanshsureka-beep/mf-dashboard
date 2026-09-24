-- =============================================================================
-- MN Advisory Dashboard — 0010 Private document storage
--
-- Bucket `client-documents` is PRIVATE. Files are read only through short-lived
-- signed URLs generated server-side. Object path convention:
--   <client_id>/<document_type>/<sha256>-<sanitised file name>
-- The first path segment decides access (same rule as the client row).
-- Objects are immutable: no UPDATE / DELETE policies.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-documents',
  'client-documents',
  false,
  26214400, -- 25 MB
  array['application/pdf', 'image/png', 'image/jpeg', 'application/json', 'text/csv']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create or replace function app.client_id_from_storage_path(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return split_part(p_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$$;

create policy client_documents_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'client-documents'
    and app.can_access_client(app.client_id_from_storage_path(name))
  );

create policy client_documents_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'client-documents'
    and app.can_operate_client(app.client_id_from_storage_path(name))
  );
