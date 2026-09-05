-- Where a browser's Web Push subscription is stored, and the flag that
-- keeps deploy/selfhost/send-request-notifications.mjs from alerting
-- anyone twice about the same request.
--
-- Idempotent, safe to re-run.

create table if not exists push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  org_member_id uuid not null references org_members(id) on delete cascade,
  endpoint      text not null unique,
  p256dh        text not null,
  auth          text not null,
  created_at    timestamptz not null default now()
);
create index if not exists push_subscriptions_org_member_id_idx
  on push_subscriptions (org_member_id);

-- Lets the sender script tell "already alerted" from "still needs a push",
-- without which a request with no subscribers would be rechecked forever
-- and one with subscribers would be pushed again on every tick.
alter table maintenance_requests add column if not exists notified_at timestamptz;

alter table push_subscriptions enable row level security;

drop policy if exists push_subscriptions_select on push_subscriptions;
drop policy if exists push_subscriptions_insert on push_subscriptions;
drop policy if exists push_subscriptions_delete on push_subscriptions;

-- A member may only see, add, or remove their own subscription. This is
-- not org data — even an admin has no reason to see another member's row,
-- since it describes that person's browser, not anything about the org.
-- The sender script itself runs as the postgres superuser (see
-- create-test-user.sh for the same pattern) and reads across an org's
-- members that way, deliberately bypassing these policies.
create policy push_subscriptions_select on push_subscriptions for select
  using (exists (select 1 from org_members om
                  where om.id = push_subscriptions.org_member_id and om.user_id = auth.uid()));
create policy push_subscriptions_insert on push_subscriptions for insert
  with check (exists (select 1 from org_members om
                        where om.id = push_subscriptions.org_member_id and om.user_id = auth.uid()));
create policy push_subscriptions_delete on push_subscriptions for delete
  using (exists (select 1 from org_members om
                  where om.id = push_subscriptions.org_member_id and om.user_id = auth.uid()));
