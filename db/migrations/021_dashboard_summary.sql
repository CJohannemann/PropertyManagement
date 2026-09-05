-- Everything the landlord's dashboard needs, in one round trip.
--
-- One function rather than a dozen client queries: this is the first thing
-- loaded, usually on a phone on cellular, and a dozen sequential requests
-- is the difference between a dashboard and a spinner.
--
-- Returns structured figures, never sentences. Wording belongs in the
-- interface, where it can be changed without a migration and translated
-- without parsing English back out of a database.
--
-- Every aggregate is computed in its own CTE and joined at the end. Summing
-- charges and job entries in one pass multiplies each by the count of the
-- other — a mistake that produces plausible-looking numbers, and one this
-- schema has already had to fix once (see 020).
--
-- Idempotent, safe to re-run.

drop function if exists dashboard_summary(uuid);

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
