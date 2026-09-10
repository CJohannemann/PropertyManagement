-- Gaps found by working through the rental app test plan.
--
-- Five unrelated-looking changes that share one cause: the database could
-- already express the thing, and nothing ever told anybody about it, or
-- nothing let a person do it.
--
--   1. A tenant was never told their repair was scheduled or finished.
--   2. A landlord was never told a payment bounced.
--   3. A technician could not accept or decline the work offered to them.
--   4. There was no way to take someone's access away.
--   5. Notifications only ever reached admins and property managers,
--      because every trigger raised them with org_member_id null.
--
-- The notifications table has addressed a single member since it was
-- written (023) — the column, the RLS policy and mark_notifications_read()
-- all handle it. Nothing had used it. Points 1 and 3 are the first
-- notifications that go to one person rather than to management.
--
-- Idempotent, safe to re-run.

-- ------------------------------------------------------ job offers --

-- 'offered' and 'declined', so assigning work is a question rather than an
-- instruction. Existing rows are untouched: a job created before this went
-- straight to 'scheduled', which still means the same thing — accepted,
-- work expected.
alter table maintenance_jobs drop constraint if exists maintenance_jobs_status_check;
alter table maintenance_jobs add constraint maintenance_jobs_status_check
  check (status in ('offered', 'scheduled', 'in_progress', 'completed',
                    'canceled', 'declined'));

-- The request status a job status implies. Extracted from
-- sync_request_status_from_job() below so both it and respond_to_job()
-- agree, rather than each having its own opinion.
--
-- A declined job puts the request back in the queue exactly as a canceled
-- one does: from the tenant's side nothing has happened yet, and "declined"
-- is the landlord's problem to solve, not a status the tenant should have
-- to interpret.
--
-- 'offered' falls through to 'assigned' for the same reason from the other
-- direction: the tenant's repair HAS been given to someone, and whether
-- that person has tapped Accept yet is the landlord's business, not a
-- distinction to show the person waiting for a plumber.
create or replace function request_status_for_job(job_status text)
returns text language sql immutable set search_path = public as $fn$
  select case job_status
           when 'in_progress' then 'in_progress'
           when 'completed'   then 'completed'
           when 'canceled'    then 'open'
           when 'declined'    then 'open'
           else 'assigned'
         end;
$fn$;

create or replace function sync_request_status_from_job()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.request_id is null then
    return NEW;
  end if;

  update maintenance_requests
     set status = request_status_for_job(NEW.status)
   where id = NEW.request_id
     and status <> 'closed';

  return NEW;
end;
$fn$;

-- Assigning to a named technician now offers the job rather than booking
-- it. An unassigned job stays 'scheduled': there is nobody to accept it,
-- and a job waiting on no one should not sit in a state that means
-- "waiting for an answer".
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
  values (org, prop, req.unit_id, req.id, technician,
          case when technician is null then 'scheduled' else 'offered' end,
          when_scheduled, req.description)
  returning id into new_job;

  update maintenance_requests set status = 'assigned' where id = req.id;

  -- The technician is told there is work waiting. Without this the only
  -- way to find out was to open the app and look, which is the same gap
  -- notifications were built to close for everyone else.
  if technician is not null then
    insert into notifications (organization_id, org_member_id, kind, urgency,
                               title, body, link)
    values (org, technician, 'maintenance_request', 'normal',
            'A job has been offered to you',
            req.category || ': ' || left(req.description, 120)
              || coalesce(' (scheduled ' || when_scheduled::text || ')', ''),
            '/dashboard');
  end if;

  return new_job;
end;
$fn$;
revoke all on function create_job_from_request(uuid, uuid, date) from public;
grant execute on function create_job_from_request(uuid, uuid, date) to authenticated;

-- A technician answering the offer. Deliberately not an update policy on
-- maintenance_jobs: letting a technician write that table directly would
-- also let them mark a job complete they never did, or move it to another
-- property. This is the one transition they own.
create or replace function respond_to_job(target_job uuid, accept boolean, reason text default null)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  the_job  maintenance_jobs%rowtype;
  member   org_members%rowtype;
  who      text;
begin
  select * into the_job from maintenance_jobs where id = target_job;
  if the_job.id is null then
    raise exception 'no such job';
  end if;

  select * into member from org_members
   where user_id = auth.uid() and organization_id = the_job.organization_id
     and status = 'active'
   limit 1;
  if member.id is null then
    raise exception 'you are not a member of this organization';
  end if;
  if the_job.assigned_technician_id is distinct from member.id then
    raise exception 'that job is not assigned to you';
  end if;

  -- Only an unanswered offer can be answered. Without this, declining a
  -- job halfway through the work would quietly hand it back and strand the
  -- hours already logged against it.
  if the_job.status not in ('offered', 'scheduled') then
    raise exception 'this job has already been started or finished';
  end if;

  update maintenance_jobs
     set status = case when accept then 'scheduled' else 'declined' end,
         -- The technician keeps the job when they accept and loses it when
         -- they decline, so it returns to the queue genuinely unassigned
         -- rather than sitting on someone who has said no.
         assigned_technician_id = case when accept then member.id else null end,
         notes = case
                   when accept or btrim(coalesce(reason, '')) = '' then notes
                   else coalesce(notes || E'\n\n', '')
                        || 'Declined by ' || coalesce(member.full_name, 'technician')
                        || ': ' || btrim(reason)
                 end,
         updated_at = now()
   where id = target_job;

  who := coalesce(member.full_name, 'A technician');

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (
    the_job.organization_id, 'other',
    case when accept then 'low' else 'high' end,
    who || (case when accept then ' accepted a job' else ' declined a job' end),
    case when accept then null
         else coalesce(nullif(btrim(reason), ''), 'No reason given')
              || ' — it is back in the queue and needs reassigning.' end,
    '/maintenance');
end;
$fn$;
revoke all on function respond_to_job(uuid, boolean, text) from public;
grant execute on function respond_to_job(uuid, boolean, text) to authenticated;

-- --------------------------------------------- telling the tenant --

-- The person who reported it finds out it was scheduled, started, or
-- finished. Addressed to their member row, not to the organization: this
-- is the first notification in the app that is nobody else's business.
--
-- Only on a real change of status, so re-saving a request does not ring.
create or replace function notify_request_status_change()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org      uuid;
  headline text;
begin
  if NEW.status is not distinct from OLD.status then
    return NEW;
  end if;
  if NEW.submitted_by is null then
    return NEW;
  end if;

  select p.organization_id into org
    from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;

  headline := case NEW.status
    when 'assigned'    then 'Someone is booked in for your repair'
    when 'in_progress' then 'Work has started on your repair'
    when 'completed'   then 'Your repair has been completed'
    when 'closed'      then 'Your repair has been closed'
    when 'open'        then 'Your repair is back in the queue'
    else null
  end;
  if headline is null then
    return NEW;
  end if;

  insert into notifications (organization_id, org_member_id, kind, urgency,
                             title, body, link)
  values (org, NEW.submitted_by, 'maintenance_request', 'normal',
          headline, NEW.category || ': ' || left(NEW.description, 120), '/dashboard');
  return NEW;
end;
$fn$;

drop trigger if exists maintenance_requests_notify_status on maintenance_requests;
create trigger maintenance_requests_notify_status
  after update of status on maintenance_requests
  for each row execute function notify_request_status_change();

-- A finished job, told to whoever manages the organization. The tenant
-- learns the same thing through their request's status above; this is the
-- other half, because a landlord finding out that work is done by
-- happening to look at a list is how an invoice sits unapproved.
create or replace function notify_job_completed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  place text;
begin
  if NEW.status <> 'completed' or OLD.status = 'completed' then
    return NEW;
  end if;

  select p.name || coalesce(' · ' || u.label, '') into place
    from properties p
    left join units u on u.id = NEW.unit_id
   where p.id = NEW.property_id;

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (NEW.organization_id, 'other', 'normal',
          'A repair has been completed', place, '/maintenance');
  return NEW;
end;
$fn$;

drop trigger if exists maintenance_jobs_notify_completed on maintenance_jobs;
create trigger maintenance_jobs_notify_completed
  after update of status on maintenance_jobs
  for each row execute function notify_job_completed();

-- ------------------------------------------- telling the landlord --

-- A bounced payment. 'payment_failed' has been in the kind constraint since
-- 023 and nothing ever raised one, so a returned ACH showed up as a line on
-- the tenant's own charge list saying "did not clear" — visible to the one
-- person who already knew, and to nobody who needed to act.
--
-- High urgency: this is money that was counted and is not there.
create or replace function notify_payment_failed()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org   uuid;
  payer text;
begin
  if NEW.status <> 'failed' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'failed' then
    return NEW;
  end if;

  org := org_id_for_lease(NEW.lease_id);

  select coalesce(m.full_name, 'A tenant') into payer
    from lease_tenants lt
    join org_members m on m.id = lt.org_member_id
   where lt.lease_id = NEW.lease_id and lt.is_primary
   limit 1;

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (org, 'payment_failed', 'high',
          'A rent payment failed',
          coalesce(payer, 'A tenant') || ' — '
            || to_char(NEW.amount, 'FM999999990.00')
            || coalesce(' (' || NEW.failure_reason || ')', '')
            || '. The balance is owed again.',
          '/rent');
  return NEW;
end;
$fn$;

drop trigger if exists payments_notify_failed on payments;
create trigger payments_notify_failed after insert or update of status on payments
  for each row execute function notify_payment_failed();

-- ------------------------------------------------ taking access away --

-- Disabling a member, which is what "remove someone" has to mean here:
-- deleting the row would take their signature off a lease, their name off
-- the charges they paid, and the history of who logged what work. Their
-- access ends; the record of what they did does not.
--
-- fetchMyMemberships() already filters to status = 'active', so a disabled
-- member is signed out of the organization at the next page load.
create or replace function set_member_status(target_member_id uuid, new_status text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  target        org_members%rowtype;
  caller        org_members%rowtype;
  active_admins int;
begin
  if new_status not in ('active', 'disabled') then
    raise exception 'a member is either active or disabled';
  end if;

  select * into target from org_members where id = target_member_id;
  if target.id is null then
    raise exception 'no such member';
  end if;

  select * into caller from org_members
   where user_id = auth.uid() and organization_id = target.organization_id
     and status = 'active' and role in ('admin', 'property_manager')
   limit 1;
  if caller.id is null then
    raise exception 'only an admin or property manager can change access';
  end if;

  -- A property manager may take a tenant's access away, and no more. The
  -- alternative is that anyone who can manage tenants can also lock out
  -- the owner.
  if caller.role = 'property_manager' and target.role <> 'tenant' then
    raise exception 'property managers can only change tenant access';
  end if;

  -- Same reasoning as update_org_member_role() refusing self-demotion, and
  -- as the repair block in 014: an organization with no active admin is
  -- one nobody can administer, and there is no way back in from the app.
  if target.role = 'admin' and new_status = 'disabled' then
    select count(*) into active_admins from org_members
     where organization_id = target.organization_id
       and role = 'admin' and status = 'active' and id <> target.id;
    if active_admins = 0 then
      raise exception 'this is the last active admin — make someone else an admin first';
    end if;
  end if;

  -- Cast: org_members.status is the member_status enum, not text. The
  -- parameter is text so the caller can pass a plain string, and the
  -- allowed values are checked at the top of this function.
  update org_members set status = new_status::member_status
   where id = target_member_id;
end;
$fn$;
revoke all on function set_member_status(uuid, text) from public;
grant execute on function set_member_status(uuid, text) to authenticated;
