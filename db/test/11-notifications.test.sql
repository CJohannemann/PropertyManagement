-- Notifications: the record behind the doorbell.
--
-- Web Push already delivered these events, but a push rings once and is
-- gone — a phone face-down meant the landlord never learned a thing
-- happened. These check the record gets written, stays inside the
-- organization, and cannot be forged by a browser.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-1111111111ff', 'owner@example.com'),
  ('22222222-2222-2222-2222-2222222222ff', 'other@example.com'),
  ('33333333-3333-3333-3333-3333333333ff', 'tenant@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('other@example.com');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-1111111111ff', false);
select create_organization('Owner Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Central', '807', 'Newport', 'KY', '41071') returning id as prop \gset
insert into units (property_id, label) values (:'prop', '2 - Middle') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', '33333333-3333-3333-3333-3333333333ff', false);
select accept_invite(:'token');
select id as tenant_member from org_members
 where user_id = '33333333-3333-3333-3333-3333333333ff' \gset

-- A second landlord, whose notifications must stay their own.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-2222222222ff', false);
select create_organization('Other Org') as org2 \gset

select set_config('request.jwt.uid', '11111111-1111-1111-1111-1111111111ff', false);

-- ------------------------------------------- a tenant reports something --

insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'plumbing', 'No hot water', 'urgent');

select assert((select count(*) from notifications where organization_id = :'org') = 1,
  'reporting a repair raises a notification');
select assert(
  (select kind from notifications where organization_id = :'org') = 'maintenance_request',
  'of the right kind');
select assert(
  (select urgency from notifications where organization_id = :'org') = 'high',
  'an urgent request is urgent news');
select assert(
  (select body from notifications where organization_id = :'org')
    = 'Central · 2 - Middle — No hot water',
  'and says where and what, got '
  || (select body from notifications where organization_id = :'org'));
select assert(
  (select link from notifications where organization_id = :'org') = '/maintenance',
  'with somewhere to open');

-- A routine request is still recorded, just not shouted about.
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'other', 'Squeaky door', 'low');
select assert(
  (select count(*) from notifications
    where organization_id = :'org' and urgency = 'normal') = 1,
  'a routine request is normal urgency');

-- ------------------------------------------------- money landing --

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', current_date, 1200) returning id as charge \gset

-- Recorded by hand, which is the path a cheque takes.
select record_manual_payment(:'charge', 1200, 'check', current_date, 'cheque 1041');

select assert(
  (select count(*) from notifications
    where organization_id = :'org' and kind = 'payment_received') = 1,
  'money arriving raises a notification');

-- Stripe redelivers webhooks for days. The trigger fires on the transition
-- into succeeded, not on the state, or one payment would produce a stream
-- of identical alerts.
update payments set status = 'succeeded' where rent_charge_id = :'charge';
select assert(
  (select count(*) from notifications
    where organization_id = :'org' and kind = 'payment_received') = 1,
  'a redelivered success does not notify twice');

-- ---------------------------------------------------- who can see them --

set role authenticated;

select set_config('request.jwt.uid', '11111111-1111-1111-1111-1111111111ff', false);
select assert((select count(*) from notifications) = 3,
  'the landlord sees the organization''s notifications, got '
  || (select count(*)::text from notifications));

-- A tenant is a member, but these are for whoever manages the place: the
-- read policy deliberately does not fall back to "any member".
select set_config('request.jwt.uid', '33333333-3333-3333-3333-3333333333ff', false);
select assert((select count(*) from notifications) = 0,
  'a tenant sees none of the landlord''s notifications');

-- And the other landlord sees nothing at all.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-2222222222ff', false);
select assert((select count(*) from notifications) = 0,
  'another organization sees none of them either');

-- ------------------------------------------------------ marking read --

select set_config('request.jwt.uid', '11111111-1111-1111-1111-1111111111ff', false);
select assert((select count(*) from notifications where read_at is null) = 3,
  'they start unread');
select assert(mark_notifications_read(:'org') = 3, 'marking read covers all three');
select assert((select count(*) from notifications where read_at is null) = 0,
  'and none are left unread');
select assert(mark_notifications_read(:'org') = 0,
  'marking read again changes nothing');

reset role;

-- A browser must not be able to invent a notification — the same reasoning
-- that keeps `payments` closed to clients. There is no insert policy at
-- all; these are raised by triggers.
select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          insert into notifications (organization_id, kind, title)
          values (%L, ''other'', ''Fake'')',
         '11111111-1111-1111-1111-1111111111ff', :'org'),
  'nobody can insert a notification from the client');

reset role;
select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          select mark_notifications_read(%L)',
         '22222222-2222-2222-2222-2222222222ff', :'org'),
  'and cannot mark another organization''s notifications read');

reset role;
select assert(true, 'notification tests completed');

-- ------------------------------------------------------ recent activity --
--
-- Derived from the records rather than an audit log, so it cannot drift
-- from what actually happened. These check it reports the right events, in
-- the right order, and stays inside the organization.

select set_config('request.jwt.uid', '11111111-1111-1111-1111-1111111111ff', false);

select assert((select count(*) from recent_activity(:'org', 20)) >= 3,
  'the feed reports what has happened, got '
  || (select count(*)::text from recent_activity(:'org', 20)));

select assert(
  (select count(*) from recent_activity(:'org', 20) where kind = 'payment') = 1,
  'the cheque shows as a payment');
select assert(
  (select count(*) from recent_activity(:'org', 20) where kind = 'request') = 2,
  'both repair reports show');
select assert(
  (select count(*) from recent_activity(:'org', 20) where kind = 'lease') = 1,
  'and the lease being created');

-- Newest first: the feed is read from the top.
select assert(
  (select happened_at from recent_activity(:'org', 20) limit 1)
    >= (select happened_at from recent_activity(:'org', 20) offset 1 limit 1),
  'newest first');

-- The payment names who paid, not just how much — the point of an activity
-- feed is who did what.
select assert(
  (select detail from recent_activity(:'org', 20) where kind = 'payment')
    like 'A Tenant%',
  'a payment says who made it, got '
  || (select detail from recent_activity(:'org', 20) where kind = 'payment'));

-- A voided payment did not happen, so it drops out rather than showing
-- struck through.
select id as paid_id from payments where rent_charge_id = :'charge' limit 1 \gset
update payments set status = 'refunded' where id = :'paid_id';
select assert(
  (select count(*) from recent_activity(:'org', 20) where kind = 'payment') = 0,
  'a voided payment leaves the feed');

select assert((select count(*) from recent_activity(:'org', 2)) = 2,
  'the limit is respected');
select assert_rejected(
  format('select * from recent_activity(%L, 500)', :'org'),
  'an absurd limit is refused rather than scanned');

select assert_rejected(
  format('select * from recent_activity(%L, 20)', :'org2'),
  'and one landlord cannot read another organization''s activity');

select assert(true, 'activity tests completed');
