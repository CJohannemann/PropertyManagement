-- Adds what was spent on maintenance to the monthly rent summary, so
-- "how is the business doing" can be answered with both halves rather
-- than just the income.
--
-- Idempotent, safe to re-run.

-- The return type gains a column, which create-or-replace cannot do.
drop function if exists rent_summary(uuid, int);

-- What was billed, what came in, and what went out, per month.
--
-- Rent is keyed on the charge's DUE month — "of the rent I billed for
-- September, how much came in". Spend is keyed on when the entry was
-- recorded, which is the closest honest signal for when money left: a job
-- may be scheduled in one month, worked in another and paid in a third,
-- and job_entries.created_at is the only date that marks the landlord
-- actually writing the cost down.
--
-- Spend mirrors job_totals() exactly — recorded costs plus mileage at the
-- organization's rate — so a job's own total and this roll-up can never
-- disagree. Note that job_totals sums cost across EVERY entry type, not
-- just materials, which is what lets a technician's invoice be recorded
-- against the labour entry it belongs to.
--
-- Labour hours with no cost contribute nothing, deliberately. Hours worked
-- and money owed are different claims, and pricing hours at an invented
-- rate would produce a net figure that looks authoritative and is wrong.
create or replace function rent_summary(org uuid, month_count int default 12)
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
    ),
    org_spend as (
      select date_trunc('month', je.created_at)::date as m,
             coalesce(je.cost, 0)
               + coalesce(je.miles, 0) * coalesce(o.mileage_rate, 0) as amount
        from job_entries je
        join maintenance_jobs mj on mj.id = je.job_id
        join organizations o on o.id = mj.organization_id
       where mj.organization_id = org
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
    -- Joined rather than one grouped query: summing charges and entries in
    -- a single join would multiply each charge by the number of job
    -- entries that month and vice versa, inflating both.
    select b.m, b.billed, b.collected, b.outstanding, s.spent
      from billing b
      join spending s on s.m = b.m
     order by b.m;
end;
$fn$;
revoke all on function rent_summary(uuid, int) from public;
grant execute on function rent_summary(uuid, int) to authenticated;
