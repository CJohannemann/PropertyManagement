-- Rent billing: generating each period's rent charge, marking overdue
-- ones, and applying automatic late fees. db/schema.sql flagged all three
-- as "NOT built here" because they're time-driven rather than write-driven
-- — nothing a trigger on a table can do.
--
-- The logic lives in SQL functions rather than in a script so that what
-- drives them is an independent choice: pg_cron (scheduled at the bottom
-- of this file) or, if that isn't available, a systemd timer calling
-- `select run_rent_billing();` through psql. Either way the rules live in
-- one place, next to the data they enforce.
--
-- Every function here is idempotent: running billing twice in a day (or
-- re-running this whole migration) must not double-charge anyone, which
-- is enforced by `not exists` guards rather than by remembering when it
-- last ran.

-- Links a late fee back to the rent charge it penalizes. Without this
-- there's no way to ask "has this charge already been penalized?", and a
-- daily job would add a fresh late fee every single day a charge stayed
-- unpaid.
alter table rent_charges
  add column if not exists parent_charge_id uuid references rent_charges(id) on delete cascade;
create index if not exists rent_charges_parent_idx on rent_charges (parent_charge_id);

-- One rent charge per active lease per month, dated on that lease's own
-- rent_due_day. Skips leases whose term doesn't cover the date, and skips
-- any charge already on file.
create or replace function generate_rent_charges(
  for_month date default date_trunc('month', current_date)::date
)
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  insert into rent_charges (lease_id, charge_type, due_date, amount)
  select l.id, 'rent', (for_month + (l.rent_due_day - 1))::date, l.rent_amount
    from leases l
   where l.status = 'active'
     and (for_month + (l.rent_due_day - 1))::date >= l.start_date
     and (l.end_date is null or (for_month + (l.rent_due_day - 1))::date <= l.end_date)
     -- Deliberately "is there already a rent charge anywhere in this
     -- month", not "on this exact date". Matching the exact due date
     -- looks equivalent and is not: change a lease's rent_due_day from
     -- the 1st to the 15th partway through a month and the existing
     -- charge no longer matches, so the next run bills that tenant a
     -- second time for the same month.
     and not exists (
       select 1 from rent_charges rc
        where rc.lease_id = l.id
          and rc.charge_type = 'rent'
          and rc.due_date >= for_month
          and rc.due_date < (for_month + interval '1 month')
     );
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- Flags fully-unpaid charges past their due date. Deliberately leaves
-- 'partial' alone: a tenant who has paid half is a different (and more
-- useful) fact than "late", and overwriting it would lose that. The UI can
-- still show a partial charge as overdue by comparing due_date to today —
-- this column is about payment state, not the calendar.
create or replace function mark_overdue_charges()
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  update rent_charges
     set status = 'late'
   where status = 'pending'
     and due_date < current_date;
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- Adds a late fee for each overdue, not-fully-paid rent charge on a lease
-- that opted into automatic fees — once, ever, per charge.
--
-- The fee amount comes from the lease's own late_fee_type/amount, which
-- enforce_late_fee_limits already validated against that state's caps when
-- the lease was written. So this doesn't re-check the cap: the invalid
-- lease it would be protecting against cannot exist.
create or replace function apply_late_fees()
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  insert into rent_charges (lease_id, charge_type, due_date, amount, parent_charge_id)
  select rc.lease_id,
         'late_fee',
         current_date,
         case
           when l.late_fee_type = 'percent'
             then round(l.rent_amount * (l.late_fee_amount / 100.0), 2)
           else l.late_fee_amount
         end,
         rc.id
    from rent_charges rc
    join leases l on l.id = rc.lease_id
   where rc.charge_type = 'rent'
     and rc.amount_paid < rc.amount
     and l.late_fee_auto_apply
     and l.late_fee_type is not null
     and l.late_fee_amount is not null
     and current_date > (rc.due_date + coalesce(l.late_fee_grace_days, 0))
     and not exists (
       select 1 from rent_charges f
        where f.parent_charge_id = rc.id and f.charge_type = 'late_fee'
     );
  get diagnostics n = row_count;
  return n;
end;
$fn$;

-- What the scheduler actually calls. Order matters: generate this month's
-- charges, then mark what's overdue, then penalize what qualifies.
create or replace function run_rent_billing()
returns text language plpgsql security definer set search_path = public as $fn$
declare
  generated int;
  overdue   int;
  fees      int;
begin
  generated := generate_rent_charges();
  overdue   := mark_overdue_charges();
  fees      := apply_late_fees();
  return format('generated %s charge(s), marked %s overdue, applied %s late fee(s)',
                generated, overdue, fees);
end;
$fn$;

-- Called only by the scheduler (or by hand as the DB owner), never by a
-- signed-in user — billing is not something a browser should be able to
-- trigger, and these are security definer.
revoke all on function generate_rent_charges(date) from public, authenticated, anon;
revoke all on function mark_overdue_charges() from public, authenticated, anon;
revoke all on function apply_late_fees() from public, authenticated, anon;
revoke all on function run_rent_billing() from public, authenticated, anon;

-- Schedule it daily. Wrapped in a DO block that degrades to a notice
-- rather than failing the migration, because pg_cron needs to be in
-- shared_preload_libraries and that's a property of the server, not
-- something a migration can fix. If this prints the warning, drive
-- run_rent_billing() from a systemd timer instead — see
-- deploy/selfhost/README.md.
do $do$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- Unschedule first so re-running this migration doesn't stack up
    -- duplicate jobs that would each bill on the same morning.
    perform cron.unschedule(jobid) from cron.job where jobname = 'rent-billing';
    perform cron.schedule('rent-billing', '0 6 * * *', 'select run_rent_billing();');
    raise notice 'pg_cron: rent-billing scheduled daily at 06:00 UTC';
  else
    raise warning 'pg_cron unavailable — schedule run_rent_billing() externally (see deploy/selfhost/README.md)';
  end if;
exception when others then
  raise warning 'could not schedule rent-billing via pg_cron (%) — schedule run_rent_billing() externally', sqlerrm;
end
$do$;
