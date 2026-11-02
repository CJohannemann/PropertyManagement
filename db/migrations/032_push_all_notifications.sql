-- Browser push for every notification, to whoever it is for.
--
-- Push used to cover one thing: a new maintenance request, sent to admins
-- and property managers, tracked by maintenance_requests.notified_at. A
-- technician told about a repair at their property, or offered a job, got
-- the bell and an email (031) but nothing on their phone.
--
--   1. notifications.pushed_at: deploy/selfhost/send-push-notifications.mjs
--      now pushes each notification once — addressed ones to that member's
--      devices, unaddressed ones to the office's — mirroring how email
--      works. Existing notifications are marked as already pushed, so this
--      does not replay the backlog to anyone's phone.
--      (maintenance_requests.notified_at is left in place, no longer read.)
--
--   2. register_push_subscription(): one browser, one owner. The client
--      used to upsert on endpoint, which fails when the same phone was
--      previously enabled by a different account — the row belongs to the
--      other member, and RLS rightly won't let you update it. Testing two
--      roles on one phone is exactly how that happens, and the phone would
--      keep receiving the first account's alerts. This hands the endpoint
--      to whoever enabled it most recently.
--
-- Idempotent, safe to re-run.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name = 'pushed_at'
  ) then
    alter table notifications add column pushed_at timestamptz;
    -- Only on the run that adds the column, as with emailed_at in 031.
    update notifications set pushed_at = created_at;
  end if;
end $$;

create index if not exists notifications_unpushed_idx
  on notifications (created_at) where pushed_at is null;

create or replace function register_push_subscription(
  member uuid, sub_endpoint text, sub_p256dh text, sub_auth text
)
returns void language plpgsql security definer set search_path = public as $fn$
begin
  if not exists (
    select 1 from org_members
     where id = member and user_id = auth.uid() and status = 'active'
  ) then
    raise exception 'you can only register a device for yourself';
  end if;

  if coalesce(sub_endpoint, '') = '' or coalesce(sub_p256dh, '') = ''
     or coalesce(sub_auth, '') = '' then
    raise exception 'subscription is missing required fields';
  end if;

  delete from push_subscriptions where endpoint = sub_endpoint;
  insert into push_subscriptions (org_member_id, endpoint, p256dh, auth)
  values (member, sub_endpoint, sub_p256dh, sub_auth);
end;
$fn$;
revoke all on function register_push_subscription(uuid, text, text, text) from public;
grant execute on function register_push_subscription(uuid, text, text, text) to authenticated;
