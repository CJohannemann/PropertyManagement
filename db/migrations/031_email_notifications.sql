-- Notifications by email, and technicians told about new repairs directly.
--
-- Until now a technician heard about a repair only once the office offered
-- them the job, and then only through the in-app bell: no push, no email.
-- For a small crew that is a slow way to find out the water heater at a
-- property you look after has failed.
--
--   1. A new maintenance request now also raises a notification for every
--      active technician who services that property (technician_property_
--      access, including "all properties"), linked to the property's page
--      — where its units and installed equipment are. The office's
--      notification is unchanged.
--
--   2. notifications.emailed_at / email_attempts: deploy/selfhost/
--      send-email-notifications.mjs emails each notification once, via
--      the same Brevo SMTP account auth emails already use, and records it
--      here. Notifications that existed before this migration are marked as
--      already emailed, so turning this on does not mail out the backlog.
--
-- Idempotent, safe to re-run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name = 'emailed_at'
  ) then
    alter table notifications add column emailed_at timestamptz;
    -- Only on the run that adds the column. Re-running must not mark
    -- notifications raised since then as sent when they never were.
    update notifications set emailed_at = created_at;
  end if;
end $$;

alter table notifications add column if not exists email_attempts int not null default 0;

create index if not exists notifications_unemailed_idx
  on notifications (created_at) where emailed_at is null;

create or replace function notify_new_maintenance_request()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org     uuid;
  prop    uuid;
  place   text;
  urg     text;
  heading text;
begin
  select p.organization_id, p.id,
         p.name || coalesce(' · ' || u.label, '')
    into org, prop, place
    from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;

  urg := case when NEW.priority in ('high', 'urgent') then 'high' else 'normal' end;
  heading := case when NEW.priority = 'urgent' then 'Urgent repair reported'
                  else 'New repair reported' end;

  -- The office: whoever manages the organization.
  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (org, 'maintenance_request', urg, heading,
          place || ' — ' || NEW.description, '/maintenance');

  -- Each technician who services this property, addressed to them by
  -- name. Linked to the property rather than /maintenance: a technician
  -- cannot open the request list, but can open the property and the
  -- equipment in it.
  insert into notifications (organization_id, org_member_id, kind, urgency, title, body, link)
  select distinct org, om.id, 'maintenance_request', urg, heading,
         place || ' — ' || NEW.description, '/properties/' || prop
    from technician_property_access tpa
    join org_members om on om.id = tpa.org_member_id
   where om.organization_id = org
     and om.role = 'technician'
     and om.status = 'active'
     and (tpa.property_id = prop or tpa.property_id is null);

  return NEW;
end;
$fn$;
