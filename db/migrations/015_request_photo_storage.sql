-- The bucket photos of a reported problem go in, and who may touch them.
-- Mirrors 011_receipt_storage.sql: storage access is enforced by RLS on
-- storage.objects, files are keyed by <request_id>/<filename>, and the
-- bucket is private so "anyone with the link" is not the default for a
-- photo of someone's home.
--
-- ORDERING NOTE: see 011_receipt_storage.sql for why the bucket is created
-- with only the always-present columns, then filled in if storage-api has
-- added the rest. Re-running after storage-api has started completes the
-- job.
--
-- Idempotent, safe to re-run.

insert into storage.buckets (id, name)
values ('request-photos', 'request-photos')
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'public') then
    execute 'update storage.buckets set public = false where id = ''request-photos''';
  end if;

  -- 15MB, same reasoning as receipts: a phone camera photo should not be
  -- rejected for being a large picture.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'file_size_limit') then
    execute 'update storage.buckets set file_size_limit = 15728640 where id = ''request-photos''';
  end if;

  -- Images only — unlike receipts, there is no PDF case here.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    execute 'update storage.buckets set allowed_mime_types =
             array[''image/jpeg'',''image/png'',''image/heic'',''image/webp'']
             where id = ''request-photos''';
  end if;
end $$;

-- The maintenance request a stored object belongs to: the first segment of
-- its path.
create or replace function public.storage_object_request_id(object_name text)
returns uuid language plpgsql immutable as $fn$
declare
  first_segment text;
begin
  first_segment := split_part(object_name, '/', 1);
  begin
    return first_segment::uuid;
  exception when others then
    return null;
  end;
end;
$fn$;

-- Same access rule as maintenance_requests_write: an org admin/PM, or a
-- tenant on the lease for the request's unit. Evaluated against the
-- request row rather than duplicated per policy so read and write stay in
-- sync with who may touch the request itself.
create or replace function public.can_touch_request_photo(r uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from maintenance_requests mr
    where mr.id = r
      and (
        public.has_org_role(public.org_id_for_unit(mr.unit_id),
                            array['admin','property_manager']::public.org_role[])
        or exists (select 1 from leases l
                    where l.unit_id = mr.unit_id and public.is_tenant_of_lease(l.id))
      )
  );
$fn$;

-- Read additionally reaches the technician assigned to a job made from the
-- request — they benefit from seeing the problem before they arrive.
create or replace function public.can_view_request_photo(r uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select public.can_touch_request_photo(r)
    or exists (
      select 1 from maintenance_jobs mj
       where mj.request_id = r and public.is_assigned_technician(mj.id)
    );
$fn$;

-- Delete is narrower than insert, same reasoning as receipts_delete: a
-- tenant clearing a photo they just took is fine, but once a manager has
-- acted on the request (it is no longer 'open'), removing evidence of what
-- was originally reported should not be a one-tap action for the tenant —
-- though a manager can always clean one up.
create or replace function public.can_delete_request_photo(r uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from maintenance_requests mr
    where mr.id = r
      and (
        public.has_org_role(public.org_id_for_unit(mr.unit_id),
                            array['admin','property_manager']::public.org_role[])
        or (mr.status = 'open'
            and exists (select 1 from org_members om
                         where om.id = mr.submitted_by and om.user_id = auth.uid()))
      )
  );
$fn$;

alter table storage.objects enable row level security;

drop policy if exists request_photos_read on storage.objects;
drop policy if exists request_photos_insert on storage.objects;
drop policy if exists request_photos_delete on storage.objects;

create policy request_photos_read on storage.objects for select
  using (
    bucket_id = 'request-photos'
    and public.storage_object_request_id(name) is not null
    and public.can_view_request_photo(public.storage_object_request_id(name))
  );

create policy request_photos_insert on storage.objects for insert
  with check (
    bucket_id = 'request-photos'
    and public.storage_object_request_id(name) is not null
    and public.can_touch_request_photo(public.storage_object_request_id(name))
  );

-- No update policy: a submitted photo is evidence of what was reported: it
-- is either kept as taken or removed, never replaced in place.
create policy request_photos_delete on storage.objects for delete
  using (
    bucket_id = 'request-photos'
    and public.storage_object_request_id(name) is not null
    and public.can_delete_request_photo(public.storage_object_request_id(name))
  );
