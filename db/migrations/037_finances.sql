-- Year-end finances: income for the tax return, vendors and 1099s,
-- depreciation inputs, and expenses counted in the Rent tab's net.
--
-- Builds on the expense log (036). Everything here is admin/property
-- manager only, like rent totals and expenses.
--
--   income_lines()          every payment received in a date range, sorted
--                           into what is income and what is a deposit held.
--   vendors                 who gets paid: name, last four of their tax id,
--                           their W-9, and whether they get a 1099.
--   expenses.vendor_id,     which vendor a bill was paid to, and how —
--   expenses.paid_by        payments by card are reported by the card
--                           company (1099-K), not by the landlord.
--   vendor_totals()         a year's payments per vendor, for the 1099 list.
--   property_financials,    purchase price, land value and improvements:
--   capital_improvements    what depreciation is worked out from.
--   rent_summary(),         'spent' now includes entered expenses, not just
--   rent_totals()           repair jobs, so the Rent tab's net is real.
--
-- Cash basis throughout, which is what most small landlords file on:
-- income in the year it arrived, expenses in the year they were paid.
--
-- Idempotent, safe to re-run.

-- ============================================================== income ==

-- Every payment that cleared in the range, one row each, with what kind of
-- money it is:
--
--   rent              rent and prorated rent
--   fees              late, bounced-payment, non-refundable and other fees
--                     — all rental income on Schedule E line 3
--   deposit_received  a security, pet or other deposit paid in. Held, not
--                     income: it is owed back.
--   deposit_kept      deposit kept for damage or cleaning at move-out —
--                     income in the year it is kept. (Deposit applied to
--                     unpaid rent already arrives as a rent payment, so it
--                     is counted there and not again here.)
--
-- Only 'succeeded' payments: pending and processing have not arrived, and
-- failed or voided ones never did. amount is the landlord's proceeds; the
-- processing fee a tenant paid on top is returned separately, because it
-- is in Stripe's 1099-K total but went straight back out to Stripe.
drop function if exists income_lines(uuid, date, date, uuid);

create or replace function income_lines(
  org uuid,
  from_date date,
  to_date date,
  property uuid default null
)
returns table(
  id uuid,
  received_on date,
  kind text,
  charge_type text,
  property_id uuid,
  property_name text,
  unit_label text,
  tenant_name text,
  method text,
  amount numeric,
  processing_fee numeric,
  note text
)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see income';
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
  select pay.id,
         coalesce(pay.paid_at, pay.created_at)::date,
         case
           when rc.charge_type in ('security_deposit', 'pet_deposit', 'other_deposit')
             then 'deposit_received'
           when rc.charge_type in ('rent', 'prorated_rent') or rc.charge_type is null
             then 'rent'
           else 'fees'
         end,
         rc.charge_type,
         p.id, p.name, u.label,
         coalesce(nullif(trim(om.full_name), ''), au.email),
         pay.method,
         pay.amount,
         coalesce(pay.processing_fee_amount, 0),
         pay.note
    from payments pay
    join leases l on l.id = pay.lease_id
    join units u on u.id = l.unit_id
    join properties p on p.id = u.property_id
    left join rent_charges rc on rc.id = pay.rent_charge_id
    left join org_members om on om.id = pay.tenant_member_id
    left join auth.users au on au.id = om.user_id
   where p.organization_id = org
     and (property is null or p.id = property)
     and pay.status = 'succeeded'
     and coalesce(pay.paid_at, pay.created_at)::date between from_date and to_date

  union all

  select dd.id,
         dd.created_at::date,
         'deposit_kept'::text,
         null::text,
         p.id, p.name, u.label,
         (select coalesce(nullif(trim(om.full_name), ''), au.email)
            from lease_tenants lt
            join org_members om on om.id = lt.org_member_id
            left join auth.users au on au.id = om.user_id
           where lt.lease_id = l.id
           order by lt.is_primary desc, lt.created_at
           limit 1),
         null::text,
         dd.amount,
         0::numeric,
         dd.description
    from deposit_deductions dd
    join leases l on l.id = dd.lease_id
    join units u on u.id = l.unit_id
    join properties p on p.id = u.property_id
   where p.organization_id = org
     and (property is null or p.id = property)
     and not dd.applied_to_balance
     and dd.created_at::date between from_date and to_date

   order by 2 desc, 1;
end;
$fn$;
revoke all on function income_lines(uuid, date, date, uuid) from public;
grant execute on function income_lines(uuid, date, date, uuid) to authenticated;

-- ============================================================= vendors ==

create table if not exists vendors (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null check (length(trim(name)) > 0),
  business_name   text,
  email           text,
  phone           text,
  address         text,
  -- Only the last four digits. The full SSN or EIN lives on the W-9 file
  -- below, in a private bucket; a column of full tax ids is a liability
  -- this app has no need to carry.
  tin_last4       text check (tin_last4 is null or tin_last4 ~ '^[0-9]{4}$'),
  w9_path         text,
  -- Corporations don't get a 1099-NEC; individuals, sole proprietors,
  -- partnerships and most LLCs do. Defaults on: missing one is the
  -- mistake that costs a penalty.
  gets_1099       boolean not null default true,
  -- A technician with a login, so the labor costs they log on repair jobs
  -- count toward their yearly total.
  member_id       uuid references org_members(id) on delete set null,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists vendors_org_idx on vendors (organization_id);
create unique index if not exists vendors_member_uidx on vendors (member_id)
  where member_id is not null;

alter table vendors enable row level security;
drop policy if exists vendors_read on vendors;
drop policy if exists vendors_insert on vendors;
drop policy if exists vendors_update on vendors;
drop policy if exists vendors_delete on vendors;

create policy vendors_read on vendors for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy vendors_insert on vendors for insert
  with check (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    and (member_id is null
         or exists (select 1 from org_members om
                     where om.id = member_id
                       and om.organization_id = vendors.organization_id))
  );
create policy vendors_update on vendors for update
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  with check (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    and (member_id is null
         or exists (select 1 from org_members om
                     where om.id = member_id
                       and om.organization_id = vendors.organization_id))
  );
create policy vendors_delete on vendors for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

create or replace function vendors_touch()
returns trigger language plpgsql as $fn$
begin
  NEW.organization_id := OLD.organization_id;
  NEW.updated_at := now();
  return NEW;
end;
$fn$;
drop trigger if exists vendors_touch on vendors;
create trigger vendors_touch before update on vendors
  for each row execute function vendors_touch();

-- W-9s go in the expense-receipts bucket (036) under <org>/w9/, so the
-- same organization-keyed policies cover them.

alter table expenses add column if not exists vendor_id uuid
  references vendors(id) on delete set null;
alter table expenses add column if not exists paid_by text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_paid_by_check') then
    alter table expenses add constraint expenses_paid_by_check
      check (paid_by is null
             or paid_by in ('check', 'cash', 'bank_transfer', 'card', 'other'));
  end if;
end $$;
create index if not exists expenses_vendor_idx on expenses (vendor_id);

-- A vendor from another organization cannot be attached to a bill.
create or replace function expenses_check_vendor()
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
drop trigger if exists expenses_check_vendor on expenses;
create trigger expenses_check_vendor before insert or update on expenses
  for each row execute function expenses_check_vendor();

-- A year's payments to each vendor, for deciding who gets a 1099-NEC.
--
-- Counts bills linked to the vendor, except those paid by card (the card
-- company reports those on a 1099-K) and except supplies (merchandise is
-- not reportable). Adds the labor cost a linked technician logged on
-- repair jobs. Materials a technician bought are left out: that money went
-- to the store, not to them.
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
  jb as (
    select v.id as vendor_id, sum(je.cost) as labor
      from vendors v
      join job_entries je on je.technician_id = v.member_id
      join maintenance_jobs mj on mj.id = je.job_id
     where v.organization_id = org
       and mj.organization_id = org
       and je.entry_type = 'labor'
       and coalesce(je.cost, 0) > 0
       and je.created_at::date between y_start and y_end
     group by v.id
  )
  select v.id, coalesce(nullif(trim(v.business_name), ''), v.name), v.gets_1099,
         v.w9_path is not null, v.tin_last4 is not null,
         coalesce(ex.reportable, 0)::numeric,
         coalesce(jb.labor, 0)::numeric,
         coalesce(ex.card, 0)::numeric,
         (coalesce(ex.reportable, 0) + coalesce(jb.labor, 0))::numeric
    from vendors v
    left join ex on ex.vendor_id = v.id
    left join jb on jb.vendor_id = v.id
   where v.organization_id = org
   order by 9 desc, 2;
end;
$fn$;
revoke all on function vendor_totals(uuid, int) from public;
grant execute on function vendor_totals(uuid, int) to authenticated;

-- ======================================================== depreciation ==

-- Kept off `properties` on purpose: tenants and technicians can read
-- property rows (to see the address they live at or work on), and what a
-- landlord paid for the building is none of their business.
create table if not exists property_financials (
  property_id       uuid primary key references properties(id) on delete cascade,
  purchase_price    numeric(12,2) check (purchase_price is null or purchase_price >= 0),
  -- Closing costs that add to the basis: title, recording, transfer tax.
  closing_costs     numeric(12,2) check (closing_costs is null or closing_costs >= 0),
  -- Land is never depreciated, so its share has to come off the basis.
  -- Usually taken from the county assessor's land/building split.
  land_value        numeric(12,2) check (land_value is null or land_value >= 0),
  -- The date it was first ready to rent, which is when depreciation
  -- starts — not necessarily the purchase date.
  placed_in_service date,
  updated_at        timestamptz not null default now()
);

create table if not exists capital_improvements (
  id                uuid primary key default gen_random_uuid(),
  property_id       uuid not null references properties(id) on delete cascade,
  description       text not null check (length(trim(description)) > 0),
  cost              numeric(12,2) not null check (cost > 0),
  placed_in_service date not null,
  -- IRS recovery periods: 27.5 years for the building and anything that
  -- becomes part of it (roof, HVAC, windows); 5 for appliances and
  -- carpet; 7 for furniture; 15 for land improvements (fences, paving).
  recovery_years    numeric(4,1) not null default 27.5
                      check (recovery_years in (5, 7, 15, 27.5)),
  created_at        timestamptz not null default now()
);
create index if not exists capital_improvements_property_idx
  on capital_improvements (property_id);

alter table property_financials enable row level security;
alter table capital_improvements enable row level security;

drop policy if exists property_financials_all on property_financials;
drop policy if exists capital_improvements_all on capital_improvements;

create policy property_financials_all on property_financials for all
  using (has_org_role((select p.organization_id from properties p where p.id = property_id),
                      array['admin','property_manager']::org_role[]))
  with check (has_org_role((select p.organization_id from properties p where p.id = property_id),
                           array['admin','property_manager']::org_role[]));
create policy capital_improvements_all on capital_improvements for all
  using (has_org_role((select p.organization_id from properties p where p.id = property_id),
                      array['admin','property_manager']::org_role[]))
  with check (has_org_role((select p.organization_id from properties p where p.id = property_id),
                           array['admin','property_manager']::org_role[]));

-- ============================================ net includes expenses ==

-- rent_summary() and rent_totals() counted only repair-job costs as
-- 'spent', which was all the app knew about. With an expense log that
-- understated costs and overstated net. Entered expenses now count too;
-- with a property chosen, only that property's (shared bills belong to no
-- single property, the same rule as expense_lines()).

drop function if exists rent_summary(uuid, int, uuid);

create or replace function rent_summary(
  org uuid,
  month_count int default 12,
  property uuid default null
)
returns table(
  month date,
  billed numeric,
  collected numeric,
  outstanding numeric,
  spent numeric
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see rent totals';
  end if;

  if month_count is null or month_count < 1 or month_count > 120 then
    raise exception 'month_count must be between 1 and 120';
  end if;

  if property is not null
     and not exists (select 1 from properties p
                      where p.id = property and p.organization_id = org) then
    raise exception 'that property is not in this organization';
  end if;

  return query
    with window_months as (
      select generate_series(
        date_trunc('month', current_date) - make_interval(months => month_count - 1),
        date_trunc('month', current_date),
        interval '1 month'
      )::date as m
    ),
    org_charges as (
      select date_trunc('month', rc.due_date)::date as m,
             rc.amount,
             rc.amount_paid
        from rent_charges rc
        join leases l on l.id = rc.lease_id
        join units u on u.id = l.unit_id
        join properties p on p.id = u.property_id
       where p.organization_id = org
         and (property is null or p.id = property)
    ),
    org_spend as (
      select date_trunc('month', je.created_at)::date as m,
             coalesce(je.cost, 0)
               + coalesce(je.miles, 0) * coalesce(o.mileage_rate, 0) as amount
        from job_entries je
        join maintenance_jobs mj on mj.id = je.job_id
        join organizations o on o.id = mj.organization_id
       where mj.organization_id = org
         and (property is null or mj.property_id = property)
      union all
      select date_trunc('month', e.spent_on)::date, e.amount
        from expenses e
       where e.organization_id = org
         and (property is null or e.property_id = property)
    ),
    billing as (
      select w.m,
             coalesce(sum(c.amount), 0)::numeric as billed,
             coalesce(sum(c.amount_paid), 0)::numeric as collected,
             coalesce(sum(c.amount - c.amount_paid), 0)::numeric as outstanding
        from window_months w
        left join org_charges c on c.m = w.m
       group by w.m
    ),
    spending as (
      select w.m, coalesce(sum(s.amount), 0)::numeric as spent
        from window_months w
        left join org_spend s on s.m = w.m
       group by w.m
    )
    select b.m, b.billed, b.collected, b.outstanding, s.spent
      from billing b
      join spending s on s.m = b.m
     order by b.m;
end;
$fn$;
revoke all on function rent_summary(uuid, int, uuid) from public;
grant execute on function rent_summary(uuid, int, uuid) to authenticated;

drop function if exists rent_totals(uuid, date, date, uuid);

create or replace function rent_totals(
  org uuid,
  from_date date,
  to_date date,
  property uuid default null
)
returns table(
  expected numeric,
  billed numeric,
  collected numeric,
  outstanding numeric,
  spent numeric
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see rent totals';
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
  with months as (
    select generate_series(
      date_trunc('month', from_date),
      date_trunc('month', to_date),
      interval '1 month'
    )::date as m
  ),
  charges as (
    select rc.lease_id,
           date_trunc('month', rc.due_date)::date as m,
           sum(rc.amount) as amount,
           sum(rc.amount_paid) as paid,
           sum(rc.amount) filter (
             where rc.charge_type in ('rent', 'prorated_rent')) as rent_amount
      from rent_charges rc
      join leases l on l.id = rc.lease_id
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
     where p.organization_id = org
       and (property is null or p.id = property)
       and rc.due_date between from_date and to_date
     group by rc.lease_id, date_trunc('month', rc.due_date)::date
  ),
  running as (
    select l.id as lease_id, l.rent_amount, mo.m
      from leases l
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
      cross join months mo
     where p.organization_id = org
       and (property is null or p.id = property)
       and l.status = 'active'
       and l.start_date <= (mo.m + interval '1 month' - interval '1 day')::date
       and (l.end_date is null or l.end_date >= mo.m)
  ),
  unbilled as (
    select coalesce(sum(r.rent_amount), 0) as amount
      from running r
      left join charges c on c.lease_id = r.lease_id and c.m = r.m
     where coalesce(c.rent_amount, 0) = 0
  ),
  totals as (
    select coalesce(sum(c.amount), 0) as billed,
           coalesce(sum(c.paid), 0) as collected
      from charges c
  ),
  spending as (
    select (
      (select coalesce(sum(
                coalesce(je.cost, 0)
                  + coalesce(je.miles, 0) * coalesce(o.mileage_rate, 0)
              ), 0)
         from job_entries je
         join maintenance_jobs mj on mj.id = je.job_id
         join organizations o on o.id = mj.organization_id
        where mj.organization_id = org
          and (property is null or mj.property_id = property)
          and je.created_at::date between from_date and to_date)
      +
      (select coalesce(sum(e.amount), 0)
         from expenses e
        where e.organization_id = org
          and (property is null or e.property_id = property)
          and e.spent_on between from_date and to_date)
    ) as spent
  )
  select (t.billed + u.amount)::numeric,
         t.billed::numeric,
         t.collected::numeric,
         (t.billed + u.amount - t.collected)::numeric,
         s.spent::numeric
    from totals t, unbilled u, spending s;
end;
$fn$;
revoke all on function rent_totals(uuid, date, date, uuid) from public;
grant execute on function rent_totals(uuid, date, date, uuid) to authenticated;

-- expense_lines() (036) gains the vendor, so the list and the export can
-- say who was paid without a second lookup.
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
         null::text, mj.id,
         null::uuid, null::text
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
