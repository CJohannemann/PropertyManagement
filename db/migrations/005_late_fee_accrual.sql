-- Two corrections, both found by checking the model against a real signed
-- lease (Kentucky, 2025) rather than against assumptions.
--
-- 1. THE KENTUCKY REGULATION ROW WAS WRONG.
--
-- seed.sql recorded "max late fee 10% of rent, 5-day minimum grace, KRS
-- 383.565" as though it were statute. It is not. Kentucky has no
-- statewide statutory cap on late fees; the test is judicial
-- reasonableness. And the URLTA sections in KRS 383.505-383.715 are
-- local-option — they bind only in cities and counties that adopted them
-- by ordinance (Louisville, Lexington, Covington, Newport and others),
-- not statewide. KRS 383.565 concerns rent being due as the lease
-- specifies; it sets no cap.
--
-- The practical damage: enforce_late_fee_limits would have rejected a
-- real, signed, in-force lease ($25 after 5 days plus $5/day thereafter,
-- which passes 10% of a $1,200 rent around day 24) as illegal, on the
-- authority of a number that came from a blog. Enforcing invented law is
-- worse than enforcing none — it blocks lawful terms while implying the
-- app has checked something it hasn't.
--
-- Note also that this table is keyed by state, and Kentucky's rules are
-- decided per municipality. That granularity mismatch is real and is left
-- documented rather than silently papered over; it needs revisiting
-- before this serves landlords in jurisdictions where a local cap exists.
--
-- 2. LATE FEES CAN ACCRUE DAILY.
--
-- The model allowed exactly one fee, flat or percent, applied once. Real
-- leases commonly use an initial fee plus a per-day amount, which no
-- combination of the old columns could express.
--
-- Idempotent, safe to re-run.

-- ------------------------------------------------------- 1. the KY row --

update state_rent_regulations
   set max_late_fee_type = 'none',
       max_late_fee_value = null,
       min_grace_days = 0,
       tenant_paid_processing_fee_allowed = true,
       source_citation =
         'No statewide statutory cap on late fees; reasonableness is a judicial standard. '
         || 'URLTA (KRS 383.505-383.715) is local-option and adopted only by some '
         || 'jurisdictions; it sets no late-fee cap. No known prohibition on passing '
         || 'payment processing fees to tenants, provided the charge is disclosed in the '
         || 'lease. NOT LEGAL ADVICE - confirm with counsel.',
       last_verified_at = current_date
 where state_code = 'KY';

-- ------------------------------------------------- 2. daily accrual --

-- The existing late_fee_type / late_fee_amount / late_fee_grace_days
-- columns keep their meaning and now describe the ONE-OFF initial fee.
-- These two add the per-day component charged after it.
alter table leases add column if not exists late_fee_daily_amount     numeric(10,2);
alter table leases add column if not exists late_fee_daily_start_days int;

comment on column leases.late_fee_amount is
  'One-off fee charged once the charge is late_fee_grace_days past due.';
comment on column leases.late_fee_daily_amount is
  'Charged per day from late_fee_daily_start_days past due, on top of the one-off fee.';

-- One late-fee charge per rent charge. Required for the upsert below: the
-- daily portion is recalculated as it accrues, so the fee has to be a row
-- that gets updated, not a new row each run.
create unique index if not exists rent_charges_one_late_fee_per_parent
  on rent_charges (parent_charge_id) where charge_type = 'late_fee';

-- Recomputes each unpaid rent charge's late fee to what it should be
-- today, and stops touching it once the rent is paid — so the fee freezes
-- at whatever it had reached, rather than continuing to climb or being
-- retroactively recalculated.
--
-- Returns the number of late-fee charges created or updated.
create or replace function apply_late_fees()
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  with due as (
    select
      rc.id       as parent_id,
      rc.lease_id,
      (current_date - rc.due_date) as days_late,
      case
        when l.late_fee_amount is null then 0
        when (current_date - rc.due_date) < coalesce(l.late_fee_grace_days, 0) then 0
        when l.late_fee_type = 'percent'
          then round(l.rent_amount * (l.late_fee_amount / 100.0), 2)
        else l.late_fee_amount
      end as initial_fee,
      -- Day `late_fee_daily_start_days` is itself the first chargeable
      -- day, hence the +1: a $5/day fee starting 6 days past due is $5 on
      -- day 6, not $0.
      case
        when l.late_fee_daily_amount is null or l.late_fee_daily_start_days is null then 0
        else l.late_fee_daily_amount
             * greatest((current_date - rc.due_date) - l.late_fee_daily_start_days + 1, 0)
      end as daily_fee
    from rent_charges rc
    join leases l on l.id = rc.lease_id
    where rc.charge_type = 'rent'
      and rc.amount_paid < rc.amount
      and l.late_fee_auto_apply
  ),
  totals as (
    select parent_id, lease_id, (initial_fee + daily_fee) as fee
      from due
     where days_late > 0 and (initial_fee + daily_fee) > 0
  ),
  upserted as (
    insert into rent_charges (lease_id, charge_type, due_date, amount, parent_charge_id)
    select lease_id, 'late_fee', current_date, fee, parent_id from totals
    on conflict (parent_charge_id) where charge_type = 'late_fee'
      -- Only ever revises the amount. Leaves due_date at the day the fee
      -- first appeared, and never lowers it below what has already been
      -- paid against it.
      do update set amount = greatest(excluded.amount, rent_charges.amount_paid)
      where rent_charges.amount is distinct from greatest(excluded.amount, rent_charges.amount_paid)
    returning 1
  )
  select count(*) into n from upserted;
  return n;
end;
$fn$;
revoke all on function apply_late_fees() from public, authenticated, anon;

-- The cap check now explicitly covers only the one-off fee. A daily
-- accrual's total depends on how late the payment eventually is, which is
-- unknowable when the lease is written — so claiming to validate it here
-- would be pretending to a check that cannot exist. Said plainly rather
-- than left implied.
create or replace function enforce_late_fee_limits()
returns trigger language plpgsql as $fn$
declare
  st               text;
  reg              state_rent_regulations%rowtype;
  effective_amount numeric;
begin
  select p.state into st
    from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;

  select * into reg from state_rent_regulations where state_code = st;

  if reg.id is null then
    if NEW.late_fee_auto_apply or NEW.fee_payer = 'tenant' then
      raise exception
        'auto-applied late fees and tenant-paid processing fees require verified rent regulations for state %; none on file yet',
        st;
    end if;
    return NEW;
  end if;

  if NEW.late_fee_grace_days is not null and NEW.late_fee_grace_days < reg.min_grace_days then
    raise exception '% requires at least % day(s) grace before a late fee applies',
      st, reg.min_grace_days;
  end if;

  -- Normalizes to dollars before comparing rather than requiring the
  -- lease's fee type to match the cap's, so a percent cap cannot be
  -- sidestepped by expressing the same fee as a flat amount.
  if reg.max_late_fee_type is not null and reg.max_late_fee_type <> 'none'
     and NEW.late_fee_amount is not null and NEW.late_fee_type is not null then
    if NEW.late_fee_type = 'percent' then
      effective_amount := NEW.rent_amount * (NEW.late_fee_amount / 100.0);
    else
      effective_amount := NEW.late_fee_amount;
    end if;

    if reg.max_late_fee_type = 'percent'
       and effective_amount > NEW.rent_amount * (reg.max_late_fee_value / 100.0) then
      raise exception '% caps late fees at % percent of rent', st, reg.max_late_fee_value;
    elsif reg.max_late_fee_type = 'flat' and effective_amount > reg.max_late_fee_value then
      raise exception '% caps late fees at $%', st, reg.max_late_fee_value;
    end if;
  end if;

  if NEW.fee_payer = 'tenant' and reg.tenant_paid_processing_fee_allowed is distinct from true then
    raise exception 'tenant-paid processing fees are not confirmed allowed in % yet', st;
  end if;

  return NEW;
end;
$fn$;
