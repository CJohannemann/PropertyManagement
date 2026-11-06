-- Outside companies on repair jobs, and property managers running them.
--
--   1. Hiring a vendor. A job could only go to a technician — someone with
--      a login. An exterminator, a plumber's company, anyone the office
--      calls in from outside has no account and should not have one. A
--      job can now record the vendor that was hired instead
--      (maintenance_jobs.vendor_id). Nothing is sent to the vendor: the
--      office phones them as before. The tenant still hears that someone
--      is booked in, from the request status trigger (027).
--   2. Property managers log job costs. job_entries and receipts were
--      admin-or-assigned-technician, so a manager could write a $300
--      exterminator bill into Expenses but not onto the job for the same
--      visit. Managers now add, change and delete costs and receipts on
--      jobs like an admin. Two limits stay: a closed tax year is still
--      admin-only (guard_closed_year, 038), and deleting a stored receipt
--      file is still admin-only — it is the tax record.
--   3. What was done. maintenance_jobs.completion_notes: the office's
--      account of the finished work ("treated kitchen and basement,
--      follow-up in 30 days"). Internal — tenants do not read jobs.
--   4. An invoice is a labor entry with a cost and no hours. The payload
--      check required hours on every labor entry, so a vendor's bill had
--      nowhere honest to go.
--   5. Books. Invoices on a vendor's job count toward that vendor's 1099
--      total, and appear in Expenses under the vendor's name. Pest control
--      is Schedule E "cleaning and maintenance", not "repairs"; job costs
--      on pest requests are filed there now — except in a year already
--      closed, whose figures are left exactly as they were filed.
--
-- Idempotent, safe to re-run.

-- ================================================== 1. hiring a vendor ==

alter table maintenance_jobs add column if not exists vendor_id uuid
  references vendors(id) on delete set null;
create index if not exists maintenance_jobs_vendor_idx on maintenance_jobs (vendor_id);

-- One or the other. A technician and a vendor on the same job leaves no
-- answer to "who is doing this"; the office can note a technician letting
-- the vendor in, in the job's notes.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'maintenance_jobs_one_assignee') then
    alter table maintenance_jobs add constraint maintenance_jobs_one_assignee
      check (assigned_technician_id is null or vendor_id is null);
  end if;
end $$;

-- A vendor from another organization cannot be put on a job. Same shape
-- as expenses_check_vendor (037).
create or replace function maintenance_jobs_check_vendor()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.vendor_id is not null
     and not exists (select 1 from vendors v
                      where v.id = NEW.vendor_id
                        and v.organization_id = NEW.organization_id) then
    raise exception 'that vendor is not in this organization';
  end if;
  return NEW;
end;
$fn$;
drop trigger if exists maintenance_jobs_check_vendor on maintenance_jobs;
create trigger maintenance_jobs_check_vendor before insert or update of vendor_id on maintenance_jobs
  for each row execute function maintenance_jobs_check_vendor();

-- A technician may update their own job (status, mostly), and the update
-- policy cannot tell columns apart. Who is on a job is the office's call:
-- a technician cannot hand their job to a vendor or take a vendor's job.
create or replace function maintenance_jobs_guard_assignee()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is not null
     and (NEW.vendor_id is distinct from OLD.vendor_id
          or NEW.assigned_technician_id is distinct from OLD.assigned_technician_id)
     and not has_org_role(NEW.organization_id, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can change who is on a job';
  end if;
  return NEW;
end;
$fn$;
drop trigger if exists maintenance_jobs_guard_assignee on maintenance_jobs;
create trigger maintenance_jobs_guard_assignee before update on maintenance_jobs
  for each row execute function maintenance_jobs_guard_assignee();

-- create_job_from_request gains a vendor. The three-argument version is
-- dropped first: alongside a four-argument one with defaults, a call with
-- three arguments would be ambiguous.
drop function if exists create_job_from_request(uuid, uuid, date);

create or replace function create_job_from_request(
  request uuid,
  technician uuid default null,
  when_scheduled date default null,
  vendor uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  req      maintenance_requests%rowtype;
  org      uuid;
  prop     uuid;
  new_job  uuid;
begin
  select * into req from maintenance_requests where id = request;
  if req.id is null then
    raise exception 'no such maintenance request';
  end if;

  select p.organization_id, p.id into org, prop
    from units u join properties p on p.id = u.property_id
   where u.id = req.unit_id;

  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can assign work';
  end if;

  if technician is not null and vendor is not null then
    raise exception 'a job goes to a technician or a vendor, not both';
  end if;

  if technician is not null then
    if not exists (
      select 1 from technician_property_access tpa
       where tpa.org_member_id = technician
         and (tpa.property_id = prop or tpa.property_id is null)
    ) then
      raise exception 'that technician does not have access to this property';
    end if;
  end if;

  if vendor is not null
     and not exists (select 1 from vendors v where v.id = vendor and v.organization_id = org) then
    raise exception 'that vendor is not in this organization';
  end if;

  insert into maintenance_jobs (organization_id, property_id, unit_id, request_id,
                                assigned_technician_id, vendor_id, status,
                                scheduled_date, notes)
  values (org, prop, req.unit_id, req.id, technician, vendor, 'scheduled',
          when_scheduled, req.description)
  returning id into new_job;

  update maintenance_requests set status = 'assigned' where id = req.id;

  -- Only a technician is told: a vendor has no login to be told in.
  if technician is not null then
    insert into notifications (organization_id, org_member_id, kind, urgency,
                               title, body, link)
    values (org, technician, 'maintenance_request',
            case when req.priority in ('high', 'urgent') then 'high' else 'normal' end,
            'A job has been assigned to you',
            req.category || ': ' || left(req.description, 120)
              || coalesce(' (scheduled ' || when_scheduled::text || ')', ''),
            '/dashboard');
  end if;

  return new_job;
end;
$fn$;
revoke all on function create_job_from_request(uuid, uuid, date, uuid) from public;
grant execute on function create_job_from_request(uuid, uuid, date, uuid) to authenticated;

-- ========================================= 2. managers log job costs ==

drop policy if exists job_entries_write on job_entries;
drop policy if exists job_entries_update on job_entries;
drop policy if exists job_entries_delete on job_entries;
create policy job_entries_write on job_entries for insert
  with check (
    (has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
     and technician_id = get_my_member_id(org_id_for_job(job_id)))
    or has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or (is_assigned_technician(job_id) and technician_id = get_my_member_id(org_id_for_job(job_id)))
  );
create policy job_entries_update on job_entries for update
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  )
  with check (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  );
create policy job_entries_delete on job_entries for delete
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  );

drop policy if exists receipts_write on receipts;
drop policy if exists receipts_update on receipts;
drop policy if exists receipts_delete on receipts;
create policy receipts_write on receipts for insert
  with check (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or (is_assigned_technician(job_id) and uploaded_by = get_my_member_id(org_id_for_job(job_id)))
  );
create policy receipts_update on receipts for update
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  )
  with check (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  );
create policy receipts_delete on receipts for delete
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  );

-- The stored files (011). Uploading and replacing open to managers;
-- deleting a file stays admin-only, as 011 decided for technicians.
drop policy if exists receipts_insert on storage.objects;
drop policy if exists receipts_update on storage.objects;
create policy receipts_insert on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and (
      public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                          array['admin','property_manager']::public.org_role[])
      or public.is_assigned_technician(public.storage_object_job_id(name))
    )
  );
create policy receipts_update on storage.objects for update
  using (
    bucket_id = 'receipts'
    and public.storage_object_job_id(name) is not null
    and (
      public.has_org_role(public.org_id_for_job(public.storage_object_job_id(name)),
                          array['admin','property_manager']::public.org_role[])
      or public.is_assigned_technician(public.storage_object_job_id(name))
    )
  );

-- ===================================================== 3. what was done ==

alter table maintenance_jobs add column if not exists completion_notes text;

-- ============================================== 4. an invoice entry ==

alter table job_entries drop constraint if exists job_entries_type_payload_check;
alter table job_entries add constraint job_entries_type_payload_check
  check (
    (entry_type = 'labor'    and (hours is not null or cost is not null)) or
    (entry_type = 'mileage'  and miles is not null) or
    (entry_type = 'material' and cost  is not null) or
    (entry_type = 'note')
  );

-- ============================================================ 5. books ==

-- The Schedule E line a job cost belongs on. Mileage is travel; pest
-- control is cleaning and maintenance; everything else is repairs. A
-- closed year keeps "repairs" for pest jobs too: it was filed that way.
create or replace function job_entry_category(
  org uuid, entry_type text, request_category text, d date
)
returns text language sql stable security definer set search_path = public as $fn$
  select case
    when entry_type = 'mileage' then 'auto_travel'
    when request_category = 'pest'
         and not exists (select 1 from closed_years cy
                          where cy.organization_id = org
                            and cy.year = extract(year from d)::int)
      then 'cleaning_maintenance'
    else 'repairs'
  end;
$fn$;
revoke all on function job_entry_category(uuid, text, text, date) from public;
grant execute on function job_entry_category(uuid, text, text, date) to authenticated;

drop function if exists vendor_totals(uuid, int);

create or replace function vendor_totals(org uuid, tax_year int)
returns table(
  vendor_id uuid,
  name text,
  gets_1099 boolean,
  has_w9 boolean,
  has_tin boolean,
  from_expenses numeric,
  from_jobs numeric,
  card_payments numeric,
  reportable numeric
)
language plpgsql stable security definer set search_path = public as $fn$
declare
  y_start date := make_date(tax_year, 1, 1);
  y_end   date := make_date(tax_year, 12, 31);
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see vendor totals';
  end if;
  if tax_year < 2000 or tax_year > 2100 then
    raise exception 'that is not a tax year';
  end if;

  return query
  with ex as (
    select e.vendor_id,
           sum(e.amount) filter (where coalesce(e.paid_by, '') <> 'card'
                                   and e.category <> 'supplies') as reportable,
           sum(e.amount) filter (where e.paid_by = 'card') as card
      from expenses e
     where e.organization_id = org
       and e.vendor_id is not null
       and e.spent_on between y_start and y_end
     group by e.vendor_id
  ),
  -- What each vendor was paid on jobs: labor a technician with a login
  -- logged themselves (037), and invoices on a job the vendor was hired
  -- for. Materials are left out either way: they were bought from a shop,
  -- whoever was on the job. Each entry is counted once, for one vendor —
  -- the hired vendor over a logging member, since that is who was paid.
  job_costs as (
    select je.id, coalesce(mj.vendor_id, tv.id) as vendor_id, je.cost
      from job_entries je
      join maintenance_jobs mj on mj.id = je.job_id
      left join vendors tv on tv.member_id = je.technician_id
                          and tv.organization_id = org
     where mj.organization_id = org
       and je.entry_type = 'labor'
       and coalesce(je.cost, 0) > 0
       and local_date(org, je.created_at) between y_start and y_end
       and (mj.vendor_id is not null or tv.id is not null)
  ),
  jb as (
    select jc.vendor_id, sum(jc.cost) as paid
      from job_costs jc
     group by jc.vendor_id
  )
  select v.id, coalesce(nullif(trim(v.business_name), ''), v.name), v.gets_1099,
         v.w9_path is not null, v.tin_last4 is not null,
         coalesce(ex.reportable, 0)::numeric,
         coalesce(jb.paid, 0)::numeric,
         coalesce(ex.card, 0)::numeric,
         (coalesce(ex.reportable, 0) + coalesce(jb.paid, 0))::numeric
    from vendors v
    left join ex on ex.vendor_id = v.id
    left join jb on jb.vendor_id = v.id
   where v.organization_id = org
   order by 9 desc, 2;
end;
$fn$;
revoke all on function vendor_totals(uuid, int) from public;
grant execute on function vendor_totals(uuid, int) to authenticated;

drop function if exists expense_lines(uuid, date, date, uuid);

create or replace function expense_lines(
  org uuid,
  from_date date,
  to_date date,
  property uuid default null
)
returns table(
  id uuid,
  source text,
  spent_on date,
  category text,
  property_id uuid,
  property_name text,
  payee text,
  description text,
  amount numeric,
  receipt_path text,
  job_id uuid,
  vendor_id uuid,
  paid_by text
)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see expenses';
  end if;
  if from_date is null or to_date is null or to_date < from_date then
    raise exception 'that date range runs backwards';
  end if;
  if to_date - from_date > 3660 then
    raise exception 'that date range is longer than ten years';
  end if;
  if property is not null
     and not exists (select 1 from properties p
                      where p.id = property and p.organization_id = org) then
    raise exception 'that property is not in this organization';
  end if;

  return query
  select e.id, 'expense'::text, e.spent_on, e.category, e.property_id, p.name,
         coalesce(nullif(trim(e.payee), ''),
                  nullif(trim(v.business_name), ''), v.name),
         e.description, e.amount, e.receipt_path, null::uuid,
         e.vendor_id, e.paid_by
    from expenses e
    left join properties p on p.id = e.property_id
    left join vendors v on v.id = e.vendor_id
   where e.organization_id = org
     and e.spent_on between from_date and to_date
     and (property is null or e.property_id = property)

  union all

  select je.id, 'job'::text, local_date(org, je.created_at),
         job_entry_category(org, je.entry_type, mr.category, local_date(org, je.created_at)),
         mj.property_id, p.name,
         -- Materials name the shop they were bought from; an invoice on a
         -- vendor's job was paid to the vendor.
         coalesce(nullif(trim(je.vendor), ''),
                  case when je.entry_type = 'labor'
                       then coalesce(nullif(trim(jv.business_name), ''), jv.name) end),
         coalesce(nullif(je.description, ''),
                  case je.entry_type
                    when 'mileage' then je.miles || ' miles'
                    when 'labor'   then case when mj.vendor_id is not null
                                             then 'Invoice' else 'Labor' end
                    else 'Materials' end),
         case when je.entry_type = 'mileage'
              then round(je.miles * mileage_rate_for(org, local_date(org, je.created_at)), 2)
              else je.cost end,
         null::text, mj.id,
         case when je.entry_type = 'labor' then mj.vendor_id end, null::text
    from job_entries je
    join maintenance_jobs mj on mj.id = je.job_id
    join properties p on p.id = mj.property_id
    left join maintenance_requests mr on mr.id = mj.request_id
    left join vendors jv on jv.id = mj.vendor_id
   where mj.organization_id = org
     and local_date(org, je.created_at) between from_date and to_date
     and (property is null or mj.property_id = property)
     and (
       (je.entry_type in ('material', 'labor') and coalesce(je.cost, 0) > 0)
       or (je.entry_type = 'mileage' and coalesce(je.miles, 0) > 0
           and coalesce(mileage_rate_for(org, local_date(org, je.created_at)), 0) > 0)
     )

   order by 3 desc, 1;
end;
$fn$;
revoke all on function expense_lines(uuid, date, date, uuid) from public;
grant execute on function expense_lines(uuid, date, date, uuid) to authenticated;
