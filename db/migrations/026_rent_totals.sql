-- The financial snapshot: expected, collected, outstanding, over any range.
--
-- Separate from rent_summary(), which draws the monthly trend. This answers
-- "how is this month going" for one arbitrary period — including a custom
-- range — and rent_summary keeps answering "how have the last twelve months
-- gone". One function trying to do both would take a month count and a date
-- range and mean neither clearly.
--
-- The bug this fixes: "expected" was the sum of rent_charges that had been
-- generated, not what the leases say is due. Rent is billed by a scheduled
-- job (run_rent_billing, 06:00 UTC daily). Between the 1st of the month and
-- that job running — or any time pg_cron has hiccupped — no charge rows
-- exist yet, so the dashboard reported $0 expected while every lease in the
-- building plainly said otherwise. A landlord opening the app on the 1st
-- was told they were owed nothing.
--
-- Expected is therefore billed charges PLUS, for any month where an active
-- lease has no rent charge yet, that lease's rent. Additive rather than
-- "the larger of the two", because a lease that started mid-month is
-- correctly billed a prorated amount that is smaller than its rent_amount,
-- and the billed figure is the truthful one wherever it exists.
--
-- Idempotent, safe to re-run.

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
  -- Charges actually raised in the range. Every type counts towards billed
  -- — a late fee is money owed like any other.
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
  -- Every lease running during each month of the range, whether or not it
  -- has been billed yet. This is what makes "expected" mean the leases
  -- rather than the paperwork.
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
  -- Rent a lease is due but has not been charged for yet.
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
  -- Repairs paid for in the range, mirroring job_totals so this and a job's
  -- own figure can never disagree.
  spending as (
    select coalesce(sum(
             coalesce(je.cost, 0)
               + coalesce(je.miles, 0) * coalesce(o.mileage_rate, 0)
           ), 0) as spent
      from job_entries je
      join maintenance_jobs mj on mj.id = je.job_id
      join organizations o on o.id = mj.organization_id
     where mj.organization_id = org
       and (property is null or mj.property_id = property)
       and je.created_at::date between from_date and to_date
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
