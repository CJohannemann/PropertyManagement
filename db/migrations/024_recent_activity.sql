-- What has happened lately.
--
-- Derived from the records themselves rather than written to an audit log
-- as things occur. An audit table would be a second copy of the truth that
-- can drift from it — a payment voided, a request deleted, and the log
-- still cheerfully says otherwise. This asks the rows what happened, so it
-- cannot disagree with them.
--
-- The cost is a union of four queries on every dashboard load. Each is
-- bounded and indexed on the column it orders by, and this is a landlord
-- with tens of properties, not thousands.
--
-- Idempotent, safe to re-run.

drop function if exists recent_activity(uuid, int);

create or replace function recent_activity(org uuid, row_limit int default 12)
returns table(
  kind text,
  happened_at timestamptz,
  title text,
  detail text,
  link text
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see activity';
  end if;

  if row_limit is null or row_limit < 1 or row_limit > 100 then
    raise exception 'row_limit must be between 1 and 100';
  end if;

  return query
  select * from (
    -- Money in. Voided payments are excluded rather than shown struck
    -- through: the feed answers "what happened", and an entry made and
    -- unmade did not.
    select 'payment'::text,
           coalesce(pay.paid_at, pay.created_at),
           'Payment received'::text,
           coalesce(om.full_name, 'A tenant')
             || ' · ' || to_char(pay.amount, 'FM999999990.00')
             || ' by ' || pay.method,
           '/rent'::text
      from payments pay
      join leases l on l.id = pay.lease_id
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
      left join org_members om on om.id = pay.tenant_member_id
     where p.organization_id = org
       and pay.status in ('succeeded', 'processing')

    union all

    select 'request'::text,
           mr.created_at,
           'Repair reported'::text,
           p.name || coalesce(' · ' || u.label, '') || ' — ' || mr.description,
           '/maintenance'::text
      from maintenance_requests mr
      join units u on u.id = mr.unit_id
      join properties p on p.id = u.property_id
     where p.organization_id = org

    union all

    -- Only finished jobs. One underway is a state, not an event, and it is
    -- already visible where the work is managed.
    select 'job'::text,
           mj.updated_at,
           'Repair completed'::text,
           p.name || coalesce(' · ' || u.label, '')
             || coalesce(' — ' || mj.notes, ''),
           '/maintenance'::text
      from maintenance_jobs mj
      join properties p on p.id = mj.property_id
      left join units u on u.id = mj.unit_id
     where mj.organization_id = org
       and mj.status = 'completed'

    union all

    select 'lease'::text,
           l.created_at,
           'Lease created'::text,
           p.name || coalesce(' · ' || u.label, '')
             || ' · ' || to_char(l.rent_amount, 'FM999999990.00') || '/month',
           '/properties'::text
      from leases l
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
     where p.organization_id = org
  ) events
  order by 2 desc
  limit row_limit;
end;
$fn$;
revoke all on function recent_activity(uuid, int) from public;
grant execute on function recent_activity(uuid, int) to authenticated;
