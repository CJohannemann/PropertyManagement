-- Five fixes to the books, found by asking what could quietly go wrong.
--
--   1. Selling a property. There was no "sold", and deleting a property
--      deleted every payment, expense and receipt row with it — the year
--      of sale's income included. Now a property is marked sold (date,
--      price, selling costs; the money kept off `properties`, which
--      tenants can read), and a property or unit with any financial
--      history cannot be deleted at all.
--   2. Partial refunds. Stripe sends charge.refunded for a $50 refund on a
--      $1,200 payment too, and the webhook reversed the whole $1,200.
--      payments.refunded_amount now records how much went back, and only
--      that comes off the charge.
--   3. Mileage rate per year. One organization-wide rate meant changing
--      it for 2027 rewrote 2026's costs after they were filed. Rates are
--      per year now; a year without one uses the latest earlier year's.
--   4. Dates near midnight. Timestamps were turned into dates in UTC, so
--      a repair logged at 9pm on December 31 in Kentucky landed in the
--      next tax year. Organizations have a time zone, and money dates are
--      taken in it. Hand-recorded payments, stored as midnight UTC of the
--      day typed, are moved to midday local so that conversion keeps the
--      day.
--   5. Closing a year. Once the books for a year are closed, a property
--      manager can no longer change money in it; an admin can, and every
--      change after closing — including a Stripe reversal arriving in
--      January — is logged for the accountant.
--
-- Idempotent, safe to re-run.

-- =========================================================== 4. time zone ==

alter table organizations add column if not exists timezone text not null
  default 'America/New_York';

-- An unknown zone name fails here, at save, rather than in every report.
create or replace function organizations_check_timezone()
returns trigger language plpgsql as $fn$
begin
  perform now() at time zone NEW.timezone;
  return NEW;
exception when others then
  raise exception '"%" is not a time zone this app knows', NEW.timezone;
end;
$fn$;
drop trigger if exists organizations_check_timezone on organizations;
create trigger organizations_check_timezone before insert or update of timezone on organizations
  for each row execute function organizations_check_timezone();

create or replace function org_timezone(org uuid)
returns text language sql stable security definer set search_path = public as $fn$
  select coalesce((select timezone from organizations where id = org), 'America/New_York');
$fn$;

-- The calendar day a moment fell on, where the landlord is.
create or replace function local_date(org uuid, ts timestamptz)
returns date language sql stable security definer set search_path = public as $fn$
  select (ts at time zone org_timezone(org))::date;
$fn$;

-- A payment recorded by hand for "December 31" was stored as midnight UTC
-- on the 31st — which in Kentucky is 7pm on the 30th. Midday local keeps
-- the typed day whichever way it is converted.
create or replace function payments_local_midday()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.method not in ('ach', 'card') and NEW.paid_at is not null
     and NEW.paid_at = date_trunc('day', NEW.paid_at at time zone 'UTC') at time zone 'UTC' then
    NEW.paid_at := ((NEW.paid_at at time zone 'UTC')::date + time '12:00')
                     at time zone org_timezone(org_id_for_lease(NEW.lease_id));
  end if;
  return NEW;
end;
$fn$;
drop trigger if exists payments_local_midday on payments;
create trigger payments_local_midday before insert or update of paid_at on payments
  for each row execute function payments_local_midday();

-- Existing hand-recorded payments, moved the same way. Only rows still at
-- exactly midnight UTC, so a re-run changes nothing.
update payments set paid_at = paid_at
 where method not in ('ach', 'card')
   and paid_at = date_trunc('day', paid_at at time zone 'UTC') at time zone 'UTC';

-- ====================================================== 3. mileage rates ==

create table if not exists mileage_rates (
  organization_id uuid not null references organizations(id) on delete cascade,
  year            int not null check (year between 2000 and 2100),
  rate            numeric(6,3) not null check (rate >= 0 and rate <= 10),
  primary key (organization_id, year)
);

alter table mileage_rates enable row level security;
drop policy if exists mileage_rates_read on mileage_rates;
drop policy if exists mileage_rates_write on mileage_rates;
create policy mileage_rates_read on mileage_rates for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy mileage_rates_write on mileage_rates for all
  using (has_org_role(organization_id, array['admin']::org_role[]))
  with check (has_org_role(organization_id, array['admin']::org_role[]));

-- The single rate an organization already had becomes the rate from the
-- earliest year it has mileage in (or this year), so nothing already
-- costed changes.
insert into mileage_rates (organization_id, year, rate)
select o.id,
       coalesce((select min(extract(year from je.created_at))::int
                   from job_entries je
                   join maintenance_jobs mj on mj.id = je.job_id
                  where mj.organization_id = o.id and je.miles is not null),
                extract(year from current_date)::int),
       o.mileage_rate
  from organizations o
 where o.mileage_rate is not null
on conflict do nothing;

-- The rate for the year a day falls in: that year's, else the latest
-- earlier year's, else none (miles logged, not costed).
create or replace function mileage_rate_for(org uuid, d date)
returns numeric language sql stable security definer set search_path = public as $fn$
  select rate from mileage_rates
   where organization_id = org and year <= extract(year from d)
   order by year desc limit 1;
$fn$;

create or replace function job_totals(job uuid)
returns table(total_cost numeric, total_hours numeric, total_miles numeric)
language sql stable security definer set search_path = public as $fn$
  select
    coalesce(sum(je.cost), 0)
      + coalesce(sum(je.miles * coalesce(
          mileage_rate_for(mj.organization_id, local_date(mj.organization_id, je.created_at)), 0)), 0),
    coalesce(sum(je.hours), 0),
    coalesce(sum(je.miles), 0)
  from job_entries je
  join maintenance_jobs mj on mj.id = je.job_id
  where je.job_id = job;
$fn$;

-- ===================================================== 2. partial refunds ==

alter table payments add column if not exists refunded_amount numeric(10,2) not null default 0;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_refunded_amount_check') then
    alter table payments add constraint payments_refunded_amount_check
      check (refunded_amount >= 0 and refunded_amount <= total_charged);
  end if;
end $$;

-- A partial refund takes only what went back off the charge. Refunds come
-- off the rent first, then the processing fee: a landlord refunding $50 is
-- giving back rent.
create or replace function apply_partial_refund()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  delta numeric;
begin
  if NEW.status = 'succeeded' and NEW.rent_charge_id is not null
     and NEW.refunded_amount is distinct from OLD.refunded_amount then
    delta := least(NEW.refunded_amount, NEW.amount) - least(OLD.refunded_amount, OLD.amount);
    update rent_charges
       set amount_paid = greatest(amount_paid - delta, 0),
           status = case
                      when amount_paid - delta <= 0 then 'pending'
                      when amount_paid - delta < amount then 'partial'
                      else 'paid'
                    end
     where id = NEW.rent_charge_id;
  end if;
  return NEW;
end;
$fn$;
drop trigger if exists payments_apply_partial_refund on payments;
create trigger payments_apply_partial_refund after update of refunded_amount on payments
  for each row execute function apply_partial_refund();

-- The full reversal (017) took the whole payment off the charge. After a
-- partial refund part of it is already off, so only the rest comes off
-- now — otherwise the refunded part would be taken twice.
create or replace function reverse_refunded_payment()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  still_credited numeric;
begin
  if NEW.status = 'refunded' and OLD.status = 'succeeded'
     and NEW.rent_charge_id is not null then
    still_credited := NEW.amount - least(OLD.refunded_amount, OLD.amount);
    update rent_charges
       set amount_paid = greatest(amount_paid - still_credited, 0),
           status = case
                       when amount_paid - still_credited <= 0 then 'pending'
                       when amount_paid - still_credited < amount then 'partial'
                       else 'paid'
                     end
     where id = NEW.rent_charge_id;
  end if;
  return NEW;
end;
$fn$;

-- ================================================== 1. sold properties ==

alter table properties add column if not exists sold_on date;
alter table property_financials add column if not exists sale_price numeric(12,2)
  check (sale_price is null or sale_price >= 0);
alter table property_financials add column if not exists selling_costs numeric(12,2)
  check (selling_costs is null or selling_costs >= 0);

create or replace function mark_property_sold(
  target uuid, sold date, price numeric, costs numeric default 0
)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  org uuid;
begin
  select organization_id into org from properties where id = target;
  if org is null then
    raise exception 'no such property';
  end if;
  if not has_org_role(org, array['admin']::org_role[]) then
    raise exception 'only an admin can mark a property as sold';
  end if;
  if sold is null or sold > current_date then
    raise exception 'record the sale once it has closed, with the closing date';
  end if;
  if price is null or price < 0 or coalesce(costs, 0) < 0 then
    raise exception 'the sale price and selling costs cannot be negative';
  end if;
  -- The buyer takes the tenants on with a new lease of their own; this
  -- landlord's leases end. Ending them first is what records the
  -- deposits going with them.
  if exists (select 1 from leases l join units u on u.id = l.unit_id
              where u.property_id = target and l.status in ('active', 'pending')) then
    raise exception 'end the leases on this property first, with "Property sold" as the reason, then mark it sold';
  end if;

  update properties set sold_on = sold where id = target;
  insert into property_financials (property_id, sale_price, selling_costs)
  values (target, price, coalesce(costs, 0))
  on conflict (property_id) do update
    set sale_price = excluded.sale_price,
        selling_costs = excluded.selling_costs,
        updated_at = now();
end;
$fn$;
revoke all on function mark_property_sold(uuid, date, numeric, numeric) from public;
grant execute on function mark_property_sold(uuid, date, numeric, numeric) to authenticated;

-- For a sale entered by mistake.
create or replace function unmark_property_sold(target uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  org uuid;
begin
  select organization_id into org from properties where id = target;
  if not has_org_role(org, array['admin']::org_role[]) then
    raise exception 'only an admin can undo a sale';
  end if;
  update properties set sold_on = null where id = target;
  update property_financials set sale_price = null, selling_costs = null where property_id = target;
end;
$fn$;
revoke all on function unmark_property_sold(uuid) from public;
grant execute on function unmark_property_sold(uuid) to authenticated;

-- No new lease on a building this landlord no longer owns.
create or replace function leases_not_on_sold_property()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  sold date;
begin
  select p.sold_on into sold from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;
  if sold is not null then
    raise exception 'that property was sold on %', sold;
  end if;
  return NEW;
end;
$fn$;
drop trigger if exists leases_not_on_sold_property on leases;
create trigger leases_not_on_sold_property before insert on leases
  for each row execute function leases_not_on_sold_property();

-- Deleting a property or unit cascades to every lease, charge, payment and
-- expense under it. With any of that history it is refused: the records
-- are needed for the tax years they fall in, and for several years after.
create or replace function properties_keep_history()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if exists (select 1 from units u join leases l on l.unit_id = u.id
               join rent_charges rc on rc.lease_id = l.id where u.property_id = OLD.id)
     or exists (select 1 from units u join leases l on l.unit_id = u.id
                  join payments pay on pay.lease_id = l.id where u.property_id = OLD.id)
     or exists (select 1 from expenses where property_id = OLD.id)
     or exists (select 1 from maintenance_jobs where property_id = OLD.id)
     or exists (select 1 from capital_improvements where property_id = OLD.id) then
    raise exception '% has rent, payment or expense records, which are kept for taxes. Mark it as sold instead of deleting it.', OLD.name;
  end if;
  return OLD;
end;
$fn$;
drop trigger if exists properties_keep_history on properties;
create trigger properties_keep_history before delete on properties
  for each row execute function properties_keep_history();

create or replace function units_keep_history()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if exists (select 1 from leases l join rent_charges rc on rc.lease_id = l.id where l.unit_id = OLD.id)
     or exists (select 1 from leases l join payments pay on pay.lease_id = l.id where l.unit_id = OLD.id)
     or exists (select 1 from maintenance_jobs where unit_id = OLD.id) then
    raise exception 'unit % has rent, payment or repair records, which are kept for taxes, so it cannot be deleted', OLD.label;
  end if;
  return OLD;
end;
$fn$;
drop trigger if exists units_keep_history on units;
create trigger units_keep_history before delete on units
  for each row execute function units_keep_history();

-- ======================================================= 5. closed years ==

create table if not exists closed_years (
  organization_id uuid not null references organizations(id) on delete cascade,
  year            int not null check (year between 2000 and 2100),
  closed_at       timestamptz not null default now(),
  closed_by       uuid references org_members(id) on delete set null,
  primary key (organization_id, year)
);

-- What changed in a year after it was closed: the accountant's list of
-- "the numbers moved since you last looked".
create table if not exists year_change_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  year            int not null,
  changed_at      timestamptz not null default now(),
  -- Null when the change came from the system — a Stripe webhook.
  changed_by      uuid references org_members(id) on delete set null,
  summary         text not null
);
create index if not exists year_change_log_org_year_idx on year_change_log (organization_id, year);

alter table closed_years enable row level security;
alter table year_change_log enable row level security;
drop policy if exists closed_years_read on closed_years;
drop policy if exists closed_years_write on closed_years;
drop policy if exists closed_years_delete on closed_years;
drop policy if exists year_change_log_read on year_change_log;
create policy closed_years_read on closed_years for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy closed_years_write on closed_years for insert
  with check (has_org_role(organization_id, array['admin']::org_role[]));
create policy closed_years_delete on closed_years for delete
  using (has_org_role(organization_id, array['admin']::org_role[]));
-- Read only: rows are written by the guard below and nothing else.
create policy year_change_log_read on year_change_log for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

create or replace function closed_years_fill()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  NEW.closed_by := get_my_member_id(NEW.organization_id);
  NEW.closed_at := now();
  return NEW;
end;
$fn$;
drop trigger if exists closed_years_fill on closed_years;
create trigger closed_years_fill before insert on closed_years
  for each row execute function closed_years_fill();

-- The guard every money table calls. Open year: nothing. Closed year:
-- a property manager is refused; an admin goes ahead and it is logged;
-- the system (no signed-in user — the Stripe webhook) goes ahead and it
-- is logged, because refusing a bank's reversal would leave the books
-- wrong rather than closed.
create or replace function guard_closed_year(org uuid, d date, what text)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  y int := extract(year from d);
begin
  if org is null or d is null
     or not exists (select 1 from closed_years where organization_id = org and year = y) then
    return;
  end if;
  if auth.uid() is not null and not has_org_role(org, array['admin']::org_role[]) then
    raise exception 'The books for % are closed. Only an admin can change them.', y;
  end if;
  insert into year_change_log (organization_id, year, changed_by, summary)
  values (org, y,
          case when auth.uid() is null then null else get_my_member_id(org) end,
          what);
end;
$fn$;

create or replace function expenses_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if TG_OP in ('UPDATE', 'DELETE') then
    perform guard_closed_year(OLD.organization_id, OLD.spent_on,
      format('Expense %s %s on %s %s', to_char(OLD.amount, 'FM$999,999,990.00'),
             OLD.category, OLD.spent_on, lower(TG_OP) || 'd'));
  end if;
  if TG_OP in ('INSERT', 'UPDATE') then
    if TG_OP = 'INSERT' or extract(year from NEW.spent_on) <> extract(year from OLD.spent_on) then
      perform guard_closed_year(NEW.organization_id, NEW.spent_on,
        format('Expense %s %s on %s added', to_char(NEW.amount, 'FM$999,999,990.00'),
               NEW.category, NEW.spent_on));
    end if;
  end if;
  return coalesce(NEW, OLD);
end;
$fn$;
drop trigger if exists expenses_guard_closed on expenses;
create trigger expenses_guard_closed before insert or update or delete on expenses
  for each row execute function expenses_guard_closed();

create or replace function payments_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org uuid := org_id_for_lease(coalesce(NEW.lease_id, OLD.lease_id));
begin
  -- Redelivered webhooks touch succeeded rows without changing the money;
  -- only a change to status, amount, refund or date counts.
  if (TG_OP = 'DELETE' and OLD.status = 'succeeded')
     or (TG_OP = 'UPDATE' and OLD.status = 'succeeded'
         and (NEW.status, NEW.amount, NEW.refunded_amount, NEW.paid_at)
             is distinct from (OLD.status, OLD.amount, OLD.refunded_amount, OLD.paid_at)) then
    perform guard_closed_year(org, local_date(org, coalesce(OLD.paid_at, OLD.created_at)),
      format('Payment %s by %s on %s %s', to_char(OLD.amount, 'FM$999,999,990.00'), OLD.method,
             local_date(org, coalesce(OLD.paid_at, OLD.created_at)),
             case when TG_OP = 'DELETE' then 'deleted'
                  when NEW.status <> OLD.status then 'now ' || NEW.status
                  when NEW.refunded_amount <> OLD.refunded_amount
                    then 'refunded ' || to_char(NEW.refunded_amount, 'FM$999,999,990.00')
                  else 'changed' end));
  end if;
  if TG_OP in ('INSERT', 'UPDATE') and NEW.status = 'succeeded'
     and (TG_OP = 'INSERT' or OLD.status <> 'succeeded') then
    perform guard_closed_year(org, local_date(org, coalesce(NEW.paid_at, NEW.created_at)),
      format('Payment %s by %s on %s received', to_char(NEW.amount, 'FM$999,999,990.00'), NEW.method,
             local_date(org, coalesce(NEW.paid_at, NEW.created_at))));
  end if;
  return coalesce(NEW, OLD);
end;
$fn$;
drop trigger if exists payments_guard_closed on payments;
create trigger payments_guard_closed before insert or update or delete on payments
  for each row execute function payments_guard_closed();

create or replace function job_entries_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org uuid := (select organization_id from maintenance_jobs
                where id = coalesce(NEW.job_id, OLD.job_id));
  r job_entries%rowtype := coalesce(NEW, OLD);
begin
  -- Only entries that carry money; notes and unpaid hours change nothing.
  if coalesce(r.cost, 0) = 0 and coalesce(r.miles, 0) = 0
     and (TG_OP <> 'UPDATE' or (coalesce(OLD.cost, 0) = 0 and coalesce(OLD.miles, 0) = 0)) then
    return r;
  end if;
  perform guard_closed_year(org, local_date(org, r.created_at),
    format('Repair job %s on %s %s', r.entry_type, local_date(org, r.created_at),
           case TG_OP when 'INSERT' then 'added' when 'DELETE' then 'deleted' else 'changed' end));
  return r;
end;
$fn$;
drop trigger if exists job_entries_guard_closed on job_entries;
create trigger job_entries_guard_closed before insert or update or delete on job_entries
  for each row execute function job_entries_guard_closed();

create or replace function deposit_deductions_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  r deposit_deductions%rowtype := coalesce(NEW, OLD);
  org uuid := org_id_for_lease(r.lease_id);
begin
  perform guard_closed_year(org, local_date(org, r.created_at),
    format('Deposit deduction %s %s', to_char(r.amount, 'FM$999,999,990.00'),
           case TG_OP when 'INSERT' then 'added' when 'DELETE' then 'deleted' else 'changed' end));
  return r;
end;
$fn$;
drop trigger if exists deposit_deductions_guard_closed on deposit_deductions;
create trigger deposit_deductions_guard_closed before insert or update or delete on deposit_deductions
  for each row execute function deposit_deductions_guard_closed();

create or replace function capital_improvements_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  r capital_improvements%rowtype := coalesce(NEW, OLD);
begin
  perform guard_closed_year(org_id_for_property(r.property_id), r.placed_in_service,
    format('Improvement "%s" %s', r.description,
           case TG_OP when 'INSERT' then 'added' when 'DELETE' then 'deleted' else 'changed' end));
  return r;
end;
$fn$;
drop trigger if exists capital_improvements_guard_closed on capital_improvements;
create trigger capital_improvements_guard_closed before insert or update or delete on capital_improvements
  for each row execute function capital_improvements_guard_closed();

create or replace function mileage_rates_guard_closed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  r mileage_rates%rowtype := coalesce(NEW, OLD);
begin
  perform guard_closed_year(r.organization_id, make_date(r.year, 1, 1),
    format('Mileage rate for %s %s', r.year,
           case TG_OP when 'DELETE' then 'removed' else 'set to ' || to_char(NEW.rate, 'FM$0.000') end));
  return r;
end;
$fn$;
drop trigger if exists mileage_rates_guard_closed on mileage_rates;
create trigger mileage_rates_guard_closed before insert or update or delete on mileage_rates
  for each row execute function mileage_rates_guard_closed();

-- ==================================== reports, with all of the above ==

-- Same functions as 037, now taking dates in the organization's time
-- zone, costing mileage at the rate for its year, and netting out
-- partial refunds.

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
         local_date(org, coalesce(pay.paid_at, pay.created_at)),
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
         -- Less anything refunded: rent first, as the refund trigger takes it.
         pay.amount - least(pay.refunded_amount, pay.amount),
         coalesce(pay.processing_fee_amount, 0)
           - greatest(pay.refunded_amount - pay.amount, 0),
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
     and local_date(org, coalesce(pay.paid_at, pay.created_at)) between from_date and to_date
     and pay.refunded_amount < pay.total_charged

  union all

  select dd.id,
         local_date(org, dd.created_at),
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
     and local_date(org, dd.created_at) between from_date and to_date

   order by 2 desc, 1;
end;
$fn$;
revoke all on function income_lines(uuid, date, date, uuid) from public;
grant execute on function income_lines(uuid, date, date, uuid) to authenticated;

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
       and local_date(org, je.created_at) between y_start and y_end
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
      select date_trunc('month', local_date(org, je.created_at))::date as m,
             coalesce(je.cost, 0)
               + coalesce(je.miles, 0)
                 * coalesce(mileage_rate_for(org, local_date(org, je.created_at)), 0) as amount
        from job_entries je
        join maintenance_jobs mj on mj.id = je.job_id
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
                  + coalesce(je.miles, 0)
                    * coalesce(mileage_rate_for(org, local_date(org, je.created_at)), 0)
              ), 0)
         from job_entries je
         join maintenance_jobs mj on mj.id = je.job_id
        where mj.organization_id = org
          and (property is null or mj.property_id = property)
          and local_date(org, je.created_at) between from_date and to_date)
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
         case when je.entry_type = 'mileage' then 'auto_travel' else 'repairs' end,
         mj.property_id, p.name,
         je.vendor,
         coalesce(nullif(je.description, ''),
                  case je.entry_type
                    when 'mileage' then je.miles || ' miles'
                    when 'labor'   then 'Labor'
                    else 'Materials' end),
         case when je.entry_type = 'mileage'
              then round(je.miles * mileage_rate_for(org, local_date(org, je.created_at)), 2)
              else je.cost end,
         null::text, mj.id,
         null::uuid, null::text
    from job_entries je
    join maintenance_jobs mj on mj.id = je.job_id
    join properties p on p.id = mj.property_id
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

-- The dashboard (021) counts units and occupancy across the portfolio. A
-- sold building's units are no longer the landlord's, empty or not.
create or replace function dashboard_summary(org uuid)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  result jsonb;
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see the dashboard';
  end if;

  with
  -- Every unit in the organization, with the active lease it has (if any).
  -- Occupancy is derived from that lease, never from units.status: nothing
  -- has ever written that column, so it reads 'vacant' for every unit ever
  -- created no matter who lives there.
  unit_state as (
    select u.id as unit_id,
           u.label,
           p.id as property_id,
           p.name as property_name,
           l.id as lease_id,
           l.rent_amount,
           l.end_date
      from units u
      join properties p on p.id = u.property_id
      left join leases l on l.unit_id = u.id and l.status = 'active'
     where p.organization_id = org
       and p.sold_on is null
  ),

  -- Money owed, per property. Split by whether it is late yet.
  owing as (
    select us.property_id,
           sum(rc.amount - rc.amount_paid) as outstanding,
           sum(rc.amount - rc.amount_paid)
             filter (where rc.due_date < current_date) as overdue,
           count(distinct rc.lease_id)
             filter (where rc.due_date < current_date) as overdue_leases,
           sum(rc.amount - rc.amount_paid)
             filter (where rc.due_date between current_date and current_date + 7) as due_soon,
           count(distinct rc.lease_id)
             filter (where rc.due_date between current_date and current_date + 7) as due_soon_leases
      from rent_charges rc
      join unit_state us on us.lease_id = rc.lease_id
     where rc.amount_paid < rc.amount
     group by us.property_id
  ),

  -- Requests still needing someone to act.
  open_requests as (
    select us.property_id,
           count(*) as open_count,
           count(*) filter (where mr.priority in ('high', 'urgent')) as urgent_count
      from maintenance_requests mr
      join unit_state us on us.unit_id = mr.unit_id
     where mr.status in ('open', 'assigned', 'in_progress')
     group by us.property_id
  ),

  per_property as (
    select us.property_id as id,
           us.property_name as name,
           count(*) as units,
           count(*) filter (where us.lease_id is not null) as occupied,
           count(*) filter (where us.lease_id is null) as vacant,
           coalesce(sum(us.rent_amount), 0) as monthly_rent
      from unit_state us
     group by us.property_id, us.property_name
  )

  select jsonb_build_object(
    'portfolio', (
      select jsonb_build_object(
        'properties', count(*),
        'units', coalesce(sum(pp.units), 0),
        'occupied', coalesce(sum(pp.occupied), 0),
        'vacant', coalesce(sum(pp.vacant), 0),
        'monthly_rent', coalesce(sum(pp.monthly_rent), 0)
      ) from per_property pp
    ),

    'properties', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pp.id,
               'name', pp.name,
               'units', pp.units,
               'occupied', pp.occupied,
               'vacant', pp.vacant,
               'monthly_rent', pp.monthly_rent,
               'overdue', coalesce(o.overdue, 0),
               'open_maintenance', coalesce(r.open_count, 0),
               'urgent_maintenance', coalesce(r.urgent_count, 0)
             ) order by coalesce(o.overdue, 0) desc, pp.name)
        from per_property pp
        left join owing o on o.property_id = pp.id
        left join open_requests r on r.property_id = pp.id
    ), '[]'::jsonb),

    'maintenance', (
      select jsonb_build_object(
        'open', (select count(*) from maintenance_requests mr
                   join unit_state us on us.unit_id = mr.unit_id
                  where mr.status in ('open', 'assigned', 'in_progress')),
        'urgent', (select count(*) from maintenance_requests mr
                     join unit_state us on us.unit_id = mr.unit_id
                    where mr.status in ('open', 'assigned', 'in_progress')
                      and mr.priority in ('high', 'urgent')),
        'unassigned', (select count(*) from maintenance_requests mr
                         join unit_state us on us.unit_id = mr.unit_id
                        where mr.status = 'open'),
        'scheduled', (select count(*) from maintenance_jobs
                       where organization_id = org and status = 'scheduled'),
        'completed_this_month', (select count(*) from maintenance_jobs
                                  where organization_id = org
                                    and status = 'completed'
                                    and completed_date >= date_trunc('month', current_date)::date)
      )
    ),

    'rent', (
      select jsonb_build_object(
        'overdue', coalesce(sum(o.overdue), 0),
        'overdue_leases', coalesce(sum(o.overdue_leases), 0),
        'due_soon', coalesce(sum(o.due_soon), 0),
        'due_soon_leases', coalesce(sum(o.due_soon_leases), 0),
        'outstanding', coalesce(sum(o.outstanding), 0)
      ) from owing o
    ),

    -- Leases running out. 60 days is enough notice to renew or re-let
    -- without the reminder becoming background noise.
    'expiring_leases', coalesce((
      select jsonb_agg(jsonb_build_object(
               'lease_id', us.lease_id,
               'property_name', us.property_name,
               'unit_label', us.label,
               'end_date', us.end_date
             ) order by us.end_date)
        from unit_state us
       where us.end_date is not null
         and us.end_date between current_date and current_date + 60
    ), '[]'::jsonb),

    -- The most urgent open request, named, so the dashboard can say which
    -- one rather than only how many.
    'top_request', (
      select jsonb_build_object(
               'id', mr.id,
               'category', mr.category,
               'priority', mr.priority,
               'description', mr.description,
               'property_name', us.property_name,
               'unit_label', us.label,
               'created_at', mr.created_at
             )
        from maintenance_requests mr
        join unit_state us on us.unit_id = mr.unit_id
       where mr.status in ('open', 'assigned', 'in_progress')
       order by case mr.priority
                  when 'urgent' then 0 when 'high' then 1
                  when 'normal' then 2 else 3 end,
                mr.created_at
       limit 1
    )
  ) into result;

  return result;
end;
$fn$;
revoke all on function dashboard_summary(uuid) from public;
grant execute on function dashboard_summary(uuid) to authenticated;
