-- Assigning a job gives it to the technician. No accept/decline step.
--
-- 027 made assigning work a question: a job given to a named technician
-- started as 'offered' and waited for them to accept or decline it. That
-- isn't how this business runs — the office decides who does the work —
-- so the step only added a tap, and a way for a job to sit unanswered
-- while the tenant waited.
--
--   - create_job_from_request() books the job straight in ('scheduled')
--     whether or not a technician is named, and tells the technician it
--     has been assigned to them.
--   - Jobs still waiting on an answer when this runs are booked in too.
--   - respond_to_job() is retired: it refuses, with a reason, rather than
--     being dropped, so an older copy of the app open on someone's phone
--     gets an explanation instead of "function does not exist".
--
-- 'offered' and 'declined' stay in the status constraint, so jobs that
-- were declined in the past keep their history.
--
-- Idempotent, safe to re-run.

create or replace function create_job_from_request(
  request uuid,
  technician uuid default null,
  when_scheduled date default null
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  req      maintenance_requests%rowtype;
  org      uuid;
  prop     uuid;
  new_job  uuid;
begin
  select * into req from maintenance_requests where id = request;
  if req.id is null then
    raise exception 'no such maintenance request';
  end if;

  select p.organization_id, p.id into org, prop
    from units u join properties p on p.id = u.property_id
   where u.id = req.unit_id;

  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can assign work';
  end if;

  if technician is not null then
    if not exists (
      select 1 from technician_property_access tpa
       where tpa.org_member_id = technician
         and (tpa.property_id = prop or tpa.property_id is null)
    ) then
      raise exception 'that technician does not have access to this property';
    end if;
  end if;

  insert into maintenance_jobs (organization_id, property_id, unit_id, request_id,
                                assigned_technician_id, status, scheduled_date, notes)
  values (org, prop, req.unit_id, req.id, technician, 'scheduled',
          when_scheduled, req.description)
  returning id into new_job;

  update maintenance_requests set status = 'assigned' where id = req.id;

  if technician is not null then
    insert into notifications (organization_id, org_member_id, kind, urgency,
                               title, body, link)
    values (org, technician, 'maintenance_request',
            case when req.priority in ('high', 'urgent') then 'high' else 'normal' end,
            'A job has been assigned to you',
            req.category || ': ' || left(req.description, 120)
              || coalesce(' (scheduled ' || when_scheduled::text || ')', ''),
            '/dashboard');
  end if;

  return new_job;
end;
$fn$;
revoke all on function create_job_from_request(uuid, uuid, date) from public;
grant execute on function create_job_from_request(uuid, uuid, date) to authenticated;

-- Anything left waiting for an answer is simply assigned now.
update maintenance_jobs set status = 'scheduled' where status = 'offered';

create or replace function respond_to_job(target_job uuid, accept boolean, reason text default null)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  raise exception 'jobs are assigned directly now — there is nothing to accept or decline. Reload the app.';
end;
$fn$;
revoke all on function respond_to_job(uuid, boolean, text) from public;
grant execute on function respond_to_job(uuid, boolean, text) to authenticated;
