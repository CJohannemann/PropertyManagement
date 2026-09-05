-- Somewhere for notifications to live.
--
-- Web Push delivery already exists (016_push_subscriptions.sql and
-- deploy/selfhost/send-request-notifications.mjs), but a push is a
-- doorbell: it rings once and is gone. A phone that was face-down, or a
-- browser that was closed, meant the landlord never learned a thing
-- happened. There was no record, no unread count, and nothing to open.
--
-- This is the record. Delivery stays separate — a notification row is
-- created whether or not any push goes out, so the history is complete
-- even for someone who never turned push on.
--
-- Idempotent, safe to re-run.

create table if not exists notifications (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Who it is for. Null means everyone who manages the organization, which
  -- is most of them: a new maintenance request concerns whoever picks it up.
  org_member_id   uuid references org_members(id) on delete cascade,
  kind            text not null
                    check (kind in ('maintenance_request', 'payment_received',
                                    'payment_failed', 'lease_signed',
                                    'rent_overdue', 'task_due', 'other')),
  urgency         text not null default 'normal'
                    check (urgency in ('low', 'normal', 'high')),
  title           text not null,
  body            text,
  -- What to open. Kept as a route rather than an id plus a type, so the
  -- interface can link straight there without a lookup table of its own.
  link            text,
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists notifications_org_idx
  on notifications (organization_id, created_at desc);
create index if not exists notifications_unread_idx
  on notifications (organization_id, created_at desc) where read_at is null;

alter table notifications enable row level security;

drop policy if exists notifications_read on notifications;
drop policy if exists notifications_update on notifications;

-- Addressed to you, or to nobody in particular within an organization you
-- manage. A technician's job notifications are not a tenant's business and
-- vice versa, so this deliberately does not fall back to "any member".
create policy notifications_read on notifications for select
  using (
    (org_member_id is not null
      and exists (select 1 from org_members om
                   where om.id = notifications.org_member_id and om.user_id = auth.uid()))
    or (org_member_id is null
      and has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  );

-- Marking read is the only thing a client may change. No insert policy:
-- notifications are raised by triggers and by the sender script, never by
-- a browser claiming something happened.
create policy notifications_update on notifications for update
  using (
    (org_member_id is not null
      and exists (select 1 from org_members om
                   where om.id = notifications.org_member_id and om.user_id = auth.uid()))
    or (org_member_id is null
      and has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  )
  with check (
    (org_member_id is not null
      and exists (select 1 from org_members om
                   where om.id = notifications.org_member_id and om.user_id = auth.uid()))
    or (org_member_id is null
      and has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  );

-- Raised when a tenant reports something. The same event the push script
-- sends on, recorded so it survives a missed doorbell.
create or replace function notify_new_maintenance_request()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org  uuid;
  place text;
begin
  select p.organization_id,
         p.name || coalesce(' · ' || u.label, '')
    into org, place
    from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (
    org,
    'maintenance_request',
    case when NEW.priority in ('high', 'urgent') then 'high' else 'normal' end,
    case when NEW.priority = 'urgent' then 'Urgent repair reported'
         else 'New repair reported' end,
    place || ' — ' || NEW.description,
    '/maintenance'
  );
  return NEW;
end;
$fn$;

drop trigger if exists maintenance_requests_notify on maintenance_requests;
create trigger maintenance_requests_notify after insert on maintenance_requests
  for each row execute function notify_new_maintenance_request();

-- Raised when money actually lands, so a landlord who was not looking still
-- finds out. Only on the transition into 'succeeded', for the same reason
-- the ledger trigger is: Stripe redelivers, and a notification per delivery
-- would be a stream of identical alerts for one payment.
create or replace function notify_payment_received()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org uuid;
begin
  if NEW.status <> 'succeeded' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'succeeded' then
    return NEW;
  end if;

  org := org_id_for_lease(NEW.lease_id);

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (org, 'payment_received', 'low', 'Rent payment received',
          to_char(NEW.amount, 'FM999999990.00') || ' by ' || NEW.method,
          '/rent');
  return NEW;
end;
$fn$;

drop trigger if exists payments_notify_received on payments;
create trigger payments_notify_received after insert or update of status on payments
  for each row execute function notify_payment_received();

-- Marks everything the caller can see as read, in one go.
create or replace function mark_notifications_read(org uuid)
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int;
begin
  if not is_org_member(org) then
    raise exception 'not a member of that organization';
  end if;

  update notifications
     set read_at = now()
   where organization_id = org
     and read_at is null
     and (
       (org_member_id is not null
         and exists (select 1 from org_members om
                      where om.id = notifications.org_member_id and om.user_id = auth.uid()))
       or (org_member_id is null
         and has_org_role(org, array['admin','property_manager']::org_role[]))
     );
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function mark_notifications_read(uuid) from public;
grant execute on function mark_notifications_read(uuid) to authenticated;
