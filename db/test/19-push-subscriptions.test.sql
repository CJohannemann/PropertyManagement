-- Registering a phone for push alerts.
--
-- A device belongs to whoever turned notifications on most recently: two
-- accounts tried on one phone must not leave it receiving the first
-- account's alerts, nor fail for the second. Nobody can register a device
-- for someone else. New notifications start un-pushed; the sender script
-- picks those up.

insert into auth.users (id, email) values
  ('b2000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('b2000000-0000-0000-0000-000000000002', 'tech@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', 'b2000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset
select id as owner_member from org_members
 where user_id = 'b2000000-0000-0000-0000-000000000001' \gset
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'b2000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');
select id as tech from org_members
 where user_id = 'b2000000-0000-0000-0000-000000000002' \gset

set role authenticated;

-- The owner turns alerts on, on the shared test phone.
select set_config('request.jwt.uid', 'b2000000-0000-0000-0000-000000000001', false);
select register_push_subscription(:'owner_member', 'https://push.example/phone', 'k1', 'a1');
select assert((select count(*) from push_subscriptions) = 1, 'the owner registers the phone');

-- Registering again from the same account is not a duplicate.
select register_push_subscription(:'owner_member', 'https://push.example/phone', 'k2', 'a2');
select assert((select count(*) from push_subscriptions) = 1, 're-registering replaces, not duplicates');

-- The technician cannot register a device in the owner's name.
select set_config('request.jwt.uid', 'b2000000-0000-0000-0000-000000000002', false);
select assert_rejected(
  format($$select register_push_subscription(%L, 'https://push.example/other', 'k', 'a')$$, :'owner_member'),
  'nobody can register a device for someone else');

-- Signing in as the technician on the same phone and turning alerts on
-- hands the phone over.
select register_push_subscription(:'tech', 'https://push.example/phone', 'k3', 'a3');
select assert((select count(*) from push_subscriptions) = 1,
  'the technician sees their own registration');

select assert_rejected(
  format($$select register_push_subscription(%L, '', 'k', 'a')$$, :'tech'),
  'a subscription without an endpoint is refused');

reset role;
select assert(
  (select org_member_id from push_subscriptions where endpoint = 'https://push.example/phone') = :'tech',
  'the phone now belongs to the technician, not the owner');
select assert((select count(*) from push_subscriptions) = 1,
  'and only once');

insert into notifications (organization_id, org_member_id, kind, title)
values (:'org', :'tech', 'other', 'Something new');
select assert(
  (select pushed_at is null and emailed_at is null from notifications where title = 'Something new'),
  'a new notification waits to be pushed and emailed');

select assert(true, 'push subscription tests completed');
