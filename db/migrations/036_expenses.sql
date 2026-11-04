-- The expense log: what a property costs to run, by tax category.
--
-- Until now the only spending the app knew about was repair work logged
-- against a job. That leaves out most of what a landlord pays — insurance,
-- property tax, mortgage interest, utilities, HOA dues, the accountant —
-- and without those there is no profit figure and nothing to hand an
-- accountant at tax time.
--
--   expenses           one row per bill paid, in a Schedule E category,
--                      against one property or shared across all of them.
--   expense-receipts   private bucket for the bill or receipt, keyed
--                      <organization_id>/<file>.
--   expense_lines()    every cost in a date range in one list: the rows
--                      above plus the costs already logged on repair jobs,
--                      so repairs are never typed in twice.
--
-- Categories follow Schedule E (Form 1040) lines 5–19, the form a landlord
-- reports rental income and expenses on, one column per property. Line 18,
-- depreciation, is left out on purpose: it is not a bill anyone pays, and
-- it needs purchase price and land value, which come later.
--
-- Who: admins and property managers, the same people who already see rent
-- totals (rent_totals(), 026). Technicians and tenants see none of it.
--
-- Idempotent, safe to re-run.

create table if not exists expenses (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Null means shared across the portfolio: one insurance policy or one
  -- accountant's bill covering every property. Schedule E wants those
  -- split between properties; the split is left to the accountant rather
  -- than guessed here.
  property_id     uuid references properties(id) on delete cascade,
  category        text not null check (category in (
                    'advertising', 'auto_travel', 'cleaning_maintenance',
                    'commissions', 'insurance', 'legal_professional',
                    'management_fees', 'mortgage_interest', 'other_interest',
                    'repairs', 'supplies', 'taxes', 'utilities', 'other')),
  -- The date it was paid, not the date on the bill: a cash-basis landlord
  -- deducts it in the year the money left.
  spent_on        date not null,
  amount          numeric(10,2) not null check (amount > 0),
  payee           text,
  description     text,
  receipt_path    text,
  recorded_by     uuid references org_members(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists expenses_org_date_idx on expenses (organization_id, spent_on);
create index if not exists expenses_property_idx on expenses (property_id);

-- Who entered it, worked out here rather than taken from the browser,
-- which could otherwise attribute a bill to someone else.
create or replace function expenses_set_recorded_by()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if TG_OP = 'INSERT' then
    NEW.recorded_by := (select om.id from org_members om
                         where om.organization_id = NEW.organization_id
                           and om.user_id = auth.uid()
                         limit 1);
  else
    NEW.recorded_by := OLD.recorded_by;
    NEW.organization_id := OLD.organization_id;
    NEW.updated_at := now();
  end if;
  return NEW;
end;
$fn$;

drop trigger if exists expenses_set_recorded_by on expenses;
create trigger expenses_set_recorded_by before insert or update on expenses
  for each row execute function expenses_set_recorded_by();

alter table expenses enable row level security;

drop policy if exists expenses_read on expenses;
drop policy if exists expenses_insert on expenses;
drop policy if exists expenses_update on expenses;
drop policy if exists expenses_delete on expenses;

create policy expenses_read on expenses for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- The property, when there is one, must be this organization's: without
-- this an admin could file a bill against another landlord's building.
create policy expenses_insert on expenses for insert
  with check (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    and (property_id is null
         or exists (select 1 from properties p
                     where p.id = property_id
                       and p.organization_id = expenses.organization_id))
  );

create policy expenses_update on expenses for update
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  with check (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    and (property_id is null
         or exists (select 1 from properties p
                     where p.id = property_id
                       and p.organization_id = expenses.organization_id))
  );

create policy expenses_delete on expenses for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- ------------------------------------------------------------ receipts --

-- Same scheme as the other buckets (011, 015, 033): private, and the first
-- path segment decides access — here the organization id, since a bill
-- may belong to no single property. See 011 for why the bucket's columns
-- are only filled in if storage-api has created them.
insert into storage.buckets (id, name)
values ('expense-receipts', 'expense-receipts')
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'public') then
    execute 'update storage.buckets set public = false where id = ''expense-receipts''';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'file_size_limit') then
    execute 'update storage.buckets set file_size_limit = 15728640 where id = ''expense-receipts''';
  end if;
  -- PDFs as well as photos: an insurance renewal or a tax bill usually
  -- arrives as one.
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    execute 'update storage.buckets set allowed_mime_types =
             array[''image/jpeg'',''image/png'',''image/heic'',''image/webp'',''application/pdf'']
             where id = ''expense-receipts''';
  end if;
end $$;

create or replace function public.storage_object_org_id(object_name text)
returns uuid language plpgsql immutable as $fn$
begin
  return split_part(object_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$fn$;

drop policy if exists expense_receipts_read on storage.objects;
drop policy if exists expense_receipts_insert on storage.objects;
drop policy if exists expense_receipts_delete on storage.objects;

create policy expense_receipts_read on storage.objects for select
  using (
    bucket_id = 'expense-receipts'
    and public.storage_object_org_id(name) is not null
    and public.has_org_role(public.storage_object_org_id(name),
                            array['admin','property_manager']::public.org_role[])
  );
create policy expense_receipts_insert on storage.objects for insert
  with check (
    bucket_id = 'expense-receipts'
    and public.storage_object_org_id(name) is not null
    and public.has_org_role(public.storage_object_org_id(name),
                            array['admin','property_manager']::public.org_role[])
  );
-- No update policy: a receipt is kept as uploaded or removed, never
-- swapped out in place.
create policy expense_receipts_delete on storage.objects for delete
  using (
    bucket_id = 'expense-receipts'
    and public.storage_object_org_id(name) is not null
    and public.has_org_role(public.storage_object_org_id(name),
                            array['admin','property_manager']::public.org_role[])
  );

-- ------------------------------------------------------- the full list --

-- Every cost in a date range, entered expenses and repair-job costs
-- together, so a yearly total by category is one call and repairs are
-- never entered twice.
--
-- Job costs come from job_entries the way job_totals() and rent_totals()
-- already count them: parts and paid labor are repairs (Schedule E line
-- 14); mileage is auto and travel (line 6) at the organization's per-mile
-- rate, and left out while no rate is set rather than counted as free.
--
-- With a property given, only that property's costs: shared expenses
-- (property_id null) belong to no one property until they are split.
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
  job_id uuid
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
         e.payee, e.description, e.amount, e.receipt_path, null::uuid
    from expenses e
    left join properties p on p.id = e.property_id
   where e.organization_id = org
     and e.spent_on between from_date and to_date
     and (property is null or e.property_id = property)

  union all

  select je.id, 'job'::text, je.created_at::date,
         case when je.entry_type = 'mileage' then 'auto_travel' else 'repairs' end,
         mj.property_id, p.name,
         je.vendor,
         coalesce(nullif(je.description, ''),
                  case je.entry_type
                    when 'mileage' then je.miles || ' miles'
                    when 'labor'   then 'Labor'
                    else 'Materials' end),
         case when je.entry_type = 'mileage'
              then round(je.miles * o.mileage_rate, 2)
              else je.cost end,
         null::text, mj.id
    from job_entries je
    join maintenance_jobs mj on mj.id = je.job_id
    join organizations o on o.id = mj.organization_id
    join properties p on p.id = mj.property_id
   where mj.organization_id = org
     and je.created_at::date between from_date and to_date
     and (property is null or mj.property_id = property)
     and (
       (je.entry_type in ('material', 'labor') and coalesce(je.cost, 0) > 0)
       or (je.entry_type = 'mileage' and coalesce(je.miles, 0) > 0
           and coalesce(o.mileage_rate, 0) > 0)
     )

   order by 3 desc, 1;
end;
$fn$;

revoke all on function expense_lines(uuid, date, date, uuid) from public;
grant execute on function expense_lines(uuid, date, date, uuid) to authenticated;
