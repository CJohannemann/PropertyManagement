-- The bucket receipt photos go in, and who may touch them.
--
-- Storage access is enforced by RLS on storage.objects, the same as every
-- other table. That matters more here than it looks: a receipt photo can
-- show a card number, an address, a signature. "Anyone with the link" is
-- not an acceptable default for it.
--
-- Files are keyed by job id: <job_id>/<filename>. That makes the first
-- path segment the thing permissions are decided by, so a policy can ask
-- "may this person see this job?" without a separate lookup table.
--
-- ORDERING NOTE: the `storage` schema shipped inside supabase/postgres is
-- an old snapshot — buckets there has only (id, name, owner, timestamps).
-- The storage-api container adds `public`, `file_size_limit` and
-- `allowed_mime_types` by running its own migrations the first time it
-- starts. This migration therefore cannot assume those columns exist: it
-- creates the bucket with what is always present, then fills in the rest
-- only if it is there. Re-running after storage-api has started completes
-- the job, which is why apply-migrations.sh being safe to re-run matters
-- rather than being a nicety.
--
-- Idempotent, safe to re-run.

insert into storage.buckets (id, name)
values ('receipts', 'receipts')
on conflict (id) do nothing;

do $$
begin
  -- Private. A public bucket serves any file to anyone who guesses the
  -- URL, with no reference to who is signed in.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'public') then
    execute 'update storage.buckets set public = false where id = ''receipts''';
  end if;

  -- 15MB: a modern phone camera produces 3-8MB, and a technician
  -- photographing a receipt should not have an upload rejected for taking
  -- a large picture.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'file_size_limit') then
    execute 'update storage.buckets set file_size_limit = 15728640 where id = ''receipts''';
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    execute 'update storage.buckets set allowed_mime_types =
             array[''image/jpeg'',''image/png'',''image/heic'',''image/webp'',''application/pdf'']
             where id = ''receipts''';
  end if;
end $$;

-- The job a stored object belongs to: the first segment of its path.
create or replace function public.storage_object_job_id(object_name text)
returns uuid language plpgsql immutable as $fn$
declare
  first_segment text;
begin
  first_segment := split_part(object_name, '/', 1);
  -- A path whose first segment is not a uuid belongs to no job; the
  -- policies below then deny it rather than erroring on the cast.
  begin
    return first_segment::uuid;
  exception when others then
    return null;
  end;
end;
$fn$;

alter table storage.objects enable row level security;

drop policy if exists receipts_read on storage.objects;
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_update on storage.objects;
drop policy if exists receipts_delete on storage.objects;

-- Every function here is schema-qualified: these policies live in the
-- storage schema, and an unqualified name would depend on whatever
-- search_path the storage service happens to connect with.
create policy receipts_read on storage.objects for select
  using (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and (
      public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                          array['admin','property_manager']::public.org_role[])
      or public.is_assigned_technician(public.storage_object_job_id(name))
    )
  );

create policy receipts_insert on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and (
      public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                          array['admin']::public.org_role[])
      or public.is_assigned_technician(public.storage_object_job_id(name))
    )
  );

-- Replacing a photo is allowed for whoever could upload it; deleting is
-- deliberately narrower. A receipt is a tax record, and a technician
-- removing evidence of what was spent should not be a one-tap action.
create policy receipts_update on storage.objects for update
  using (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and (
      public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                          array['admin']::public.org_role[])
      or public.is_assigned_technician(public.storage_object_job_id(name))
    )
  );

create policy receipts_delete on storage.objects for delete
  using (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                            array['admin']::public.org_role[])
  );
