-- Lets the rent summary be asked about one building rather than all of
-- them, so the dashboard's property filter has something to filter with.
--
-- Idempotent, safe to re-run.

-- Adding a parameter with a default keeps every existing call working, but
-- Postgres will not create-or-replace across a changed signature, and the
-- old two-argument form would remain and be ambiguous. Dropped explicitly.
drop function if exists rent_summary(uuid, int);
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

  -- A property from another organization would otherwise return an empty
  -- set that reads as "this building earns nothing" rather than "that is
  -- not yours".
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
revoke all on function rent_summary(uuid, int, uuid) from public;
grant execute on function rent_summary(uuid, int, uuid) to authenticated;
