-- Fills in the maintenance workflow the original schema sketched but left
-- unusable.
--
-- What was missing:
--
--  * No way to turn a tenant's request into a job. The link existed
--    (maintenance_jobs.request_id) but nothing set it, and nothing kept
--    the request's status in step with the job's — so a tenant whose
--    request was fixed would still see "open".
--
--  * job_entries recorded a cost but not what it was for beyond free text,
--    and nothing totalled a job. "What did that repair cost me" was a
--    question the data could answer only by hand.
--
--  * Mileage was a number with no rate, so it could not become money.
--
-- Idempotent, safe to re-run.

-- The IRS business mileage rate changes annually, so it belongs to the
-- organization rather than being a constant in code. Null means mileage is
-- logged but not costed.
alter table organizations add column if not exists mileage_rate numeric(6,3);
comment on column organizations.mileage_rate is
  'Cost per mile for technician travel, e.g. 0.70. Null logs mileage without costing it.';

-- Where a technician bought something. Useful for the receipt, and for
-- answering "which supplier do we actually use".
alter table job_entries add column if not exists vendor text;
-- Quantity x unit cost, for materials bought by the unit. Optional: a
-- single lump cost stays valid.
alter table job_entries add column if not exists quantity numeric(10,2);
alter table job_entries add column if not exists unit_cost numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'job_entries_hours_check') then
    alter table job_entries add constraint job_entries_hours_check
      check (hours is null or hours >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'job_entries_miles_check') then
    alter table job_entries add constraint job_entries_miles_check
      check (miles is null or miles >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'job_entries_cost_check') then
    alter table job_entries add constraint job_entries_cost_check
      check (cost is null or cost >= 0);
  end if;
  -- An entry that records nothing measurable is a note; anything else must
  -- carry the figure its type exists to hold.
  if not exists (select 1 from pg_constraint where conname = 'job_entries_type_payload_check') then
    alter table job_entries add constraint job_entries_type_payload_check
      check (
        (entry_type = 'labor'    and hours is not null) or
        (entry_type = 'mileage'  and miles is not null) or
        (entry_type = 'material' and cost  is not null) or
        (entry_type = 'note')
      );
  end if;
end $$;

-- What a job has cost so far: materials at their recorded cost, plus
-- mileage valued at the organization's rate. Labour hours are counted but
-- not priced — technicians here are paid outside the app, and inventing a
-- rate would produce a total that looks authoritative and is wrong.
create or replace function job_totals(job uuid)
returns table(total_cost numeric, total_hours numeric, total_miles numeric)
language sql stable security definer set search_path = public as $fn$
  select
    coalesce(sum(je.cost), 0)
      + coalesce(sum(je.miles) * (select o.mileage_rate
                                    from maintenance_jobs mj
                                    join organizations o on o.id = mj.organization_id
                                   where mj.id = job), 0),
    coalesce(sum(je.hours), 0),
    coalesce(sum(je.miles), 0)
  from job_entries je
  where je.job_id = job;
$fn$;

-- Creating a job from a tenant's request, in one step, so the two cannot
-- drift apart. Marks the request 'assigned' and copies the location from
-- it rather than trusting the caller to pass a matching unit.
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

  -- A technician can only be assigned to a property they have access to;
  -- otherwise they would be given a job they cannot then open.
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
  values (org, prop, req.unit_id, req.id, technician,
          case when technician is null then 'scheduled' else 'scheduled' end,
          when_scheduled, req.description)
  returning id into new_job;

  update maintenance_requests set status = 'assigned' where id = req.id;

  return new_job;
end;
$fn$;
revoke all on function create_job_from_request(uuid, uuid, date) from public;
grant execute on function create_job_from_request(uuid, uuid, date) to authenticated;

-- Keeps a tenant's request in step with the job doing the work, so
-- "someone is coming" and "it's done" reach the person who reported it
-- without anyone remembering to update two places.
create or replace function sync_request_status_from_job()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.request_id is null then
    return NEW;
  end if;

  update maintenance_requests
     set status = case NEW.status
                    when 'in_progress' then 'in_progress'
                    when 'completed'   then 'completed'
                    when 'canceled'    then 'open'   -- back to the queue
                    else 'assigned'
                  end
   where id = NEW.request_id
     -- A request the tenant or manager has already closed is not reopened
     -- by later activity on the job.
     and status <> 'closed';

  return NEW;
end;
$fn$;

drop trigger if exists maintenance_jobs_sync_request on maintenance_jobs;
create trigger maintenance_jobs_sync_request
  after insert or update of status on maintenance_jobs
  for each row execute function sync_request_status_from_job();
