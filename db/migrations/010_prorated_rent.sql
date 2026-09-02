-- Calculating prorated first-month rent instead of asking the landlord to
-- work it out.
--
-- A lease starting mid-period owes part of that period. Doing that on a
-- calculator is where a typo becomes a billing dispute, and the arithmetic
-- is not quite as obvious as it looks: the period is not "the calendar
-- month", it is the span between rent due days. A lease with rent due on
-- the 15th, starting on the 20th, owes from the 20th to the 14th of the
-- following month.
--
-- Method: rent x (days occupied / days in that period). This is the
-- most common approach and the one that self-corrects for month length —
-- a February period divides by 28, a July period by 31 — unlike the
-- "assume 30 days" convention, which quietly overcharges in short months
-- and undercharges in long ones.
--
-- Left as a function the caller may use rather than a trigger that
-- overwrites prorated_rent_amount, because leases legitimately disagree:
-- some specify a different convention, some round, and some negotiate a
-- flat figure. The app offers the computed number and lets it be edited.
--
-- Idempotent, safe to re-run.

create or replace function prorated_first_period(
  start_date   date,
  rent_due_day int,
  rent_amount  numeric
)
returns numeric language plpgsql immutable as $fn$
declare
  period_start date;
  period_end   date;
  days_in      int;
  days_owed    int;
begin
  if start_date is null or rent_due_day is null or rent_amount is null then
    return null;
  end if;

  -- The due day on or before the start date opens the period the lease
  -- starts inside. If the lease starts before this month's due day, that
  -- period opened in the previous month.
  period_start := make_date(extract(year from start_date)::int,
                            extract(month from start_date)::int,
                            rent_due_day);
  if period_start > start_date then
    period_start := (period_start - interval '1 month')::date;
  end if;

  period_end := (period_start + interval '1 month' - interval '1 day')::date;

  days_in   := (period_end - period_start) + 1;
  days_owed := (period_end - start_date) + 1;

  -- Starting exactly on the due day means a whole period is owed, and
  -- generate_rent_charges bills it as normal rent. Prorating here as well
  -- would charge that period twice.
  if days_owed >= days_in then
    return 0;
  end if;

  return round(rent_amount * days_owed::numeric / days_in::numeric, 2);
end;
$fn$;

comment on function prorated_first_period(date, int, numeric) is
  'Rent owed for the partial period a lease starts in. 0 when the lease starts on the due day.';
