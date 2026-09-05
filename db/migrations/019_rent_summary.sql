-- Rent totals by month, and a view that was handing them to strangers.
--
-- Idempotent, safe to re-run.

-- ------------------------------------------------ the view leak first --
--
-- A Postgres view runs with its OWNER's rights unless declared
-- security_invoker. The owner here is the superuser that loaded the
-- schema, which bypasses row-level security entirely — so
-- lease_signing_status, granted to `authenticated` in
-- 013_lease_signatures.sql, returned every lease in every organization to
-- any signed-in user. However carefully the underlying tables are policed,
-- the view walked straight past it.
--
-- Confirmed by a test in 04-access-control.test.sql that failed before
-- this line and passes after it. Any view added from here needs the same
-- declaration; RLS on the tables underneath is not enough on its own.
alter view lease_signing_status set (security_invoker = true);

-- --------------------------------------------------- rent by the month --

-- What was billed and what came in, per month, for one organization.
--
-- Keyed on the charge's DUE month rather than the date money arrived.
-- "Of the rent I billed for September, how much came in" is the question a
-- landlord is actually asking; receipts-by-date is a different question
-- and a worse default, since a tenant paying three months late would make
-- a bad month look good.
--
-- No join to `payments` needed: rent_charges.amount_paid is kept correct
-- by the triggers in 017_payment_triggers.sql, so there is one definition
-- of "paid" rather than two that can disagree.
--
-- security definer with an explicit role check, rather than a view — see
-- the note above for why views are the more dangerous shape here.
--
-- Dropped first: `create or replace` cannot change a function's return
-- type, and 020 widens this one with a `spent` column. Without the drop,
-- re-running the migrations after 020 fails here with "row type defined by
-- OUT parameters is different" — and because apply-migrations.sh stops at
-- the first error, that would block every later migration too. The order
-- still settles correctly: 019 recreates the narrow version and 020
-- immediately replaces it again.
drop function if exists rent_summary(uuid, int);

create or replace function rent_summary(org uuid, month_count int default 12)
returns table(month date, billed numeric, collected numeric, outstanding numeric)
language plpgsql security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see rent totals';
  end if;

  if month_count is null or month_count < 1 or month_count > 120 then
    raise exception 'month_count must be between 1 and 120';
  end if;

  -- Every month in the window gets a row, including ones with no charges
  -- at all. A chart with gaps where a quiet month should be reads as
  -- missing data rather than as a quiet month.
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
    )
    select w.m,
           coalesce(sum(c.amount), 0)::numeric,
           coalesce(sum(c.amount_paid), 0)::numeric,
           coalesce(sum(c.amount - c.amount_paid), 0)::numeric
      from window_months w
      left join org_charges c on c.m = w.m
     group by w.m
     order by w.m;
end;
$fn$;
revoke all on function rent_summary(uuid, int) from public;
grant execute on function rent_summary(uuid, int) to authenticated;
