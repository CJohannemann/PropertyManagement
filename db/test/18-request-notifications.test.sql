-- Who hears about a new repair request.
--
-- The office always does (one notification addressed to nobody in
-- particular). So does every active technician who services that property
-- — by name, linked to the property — and nobody else: not a technician
-- scoped elsewhere, not one whose access was removed. Each one starts
-- un-emailed, which is what the email sender picks up.

insert into auth.users (id, email) values
  ('a1000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('a1000000-0000-0000-0000-000000000002', 'here@example.com'),
  ('a1000000-0000-0000-0000-000000000003', 'everywhere@example.com'),
  ('a1000000-0000-0000-0000-000000000004', 'elsewhere@example.com'),
  ('a1000000-0000-0000-0000-000000000005', 'gone@example.com'),
  ('a1000000-0000-0000-0000-000000000006', 'tenant@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Duplex', '1 St', 'Covington', 'KY', '41051') returning id as duplex \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'House', '2 St', 'Covington', 'KY', '41051') returning id as house \gset
insert into units (property_id, label) values (:'duplex', 'Up') returning id as up \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'up', '2026-01-01', 1200, 1, 'active') returning id as lease_up \gset

-- Four technicians and a tenant, each joined through an invite.
select token from create_invite('here@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select token from create_invite('everywhere@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000003', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select token from create_invite('elsewhere@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000004', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select token from create_invite('gone@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000005', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select token from create_invite('tenant@example.com', 'tenant', :'lease_up', 'Renter') \gset
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000006', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000001', false);
select id as here from org_members where user_id = 'a1000000-0000-0000-0000-000000000002' \gset
select id as everywhere from org_members where user_id = 'a1000000-0000-0000-0000-000000000003' \gset
select id as elsewhere from org_members where user_id = 'a1000000-0000-0000-0000-000000000004' \gset
select id as gone from org_members where user_id = 'a1000000-0000-0000-0000-000000000005' \gset
select id as renter from org_members where user_id = 'a1000000-0000-0000-0000-000000000006' \gset

select set_technician_access(:'here', false, array[:'duplex']::uuid[]);
select set_technician_access(:'everywhere', true);
select set_technician_access(:'elsewhere', false, array[:'house']::uuid[]);
select set_technician_access(:'gone', false, array[:'duplex']::uuid[]);
select set_member_status(:'gone', 'disabled');

-- The tenant reports a problem.
set role authenticated;
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000006', false);
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'up', :'renter', 'plumbing', 'Water heater leaking', 'urgent');
reset role;

select assert(
  (select count(*) from notifications where org_member_id is null and kind = 'maintenance_request') = 1,
  'the office is told once');
select assert(
  exists (select 1 from notifications where org_member_id = :'here'
            and link = '/properties/' || :'duplex' and urgency = 'high'
            and title = 'Urgent repair reported'),
  'a technician scoped to the property is told, linked to it, with the urgency');
select assert(
  exists (select 1 from notifications where org_member_id = :'everywhere'),
  'a technician with access to every property is told');
select assert(
  not exists (select 1 from notifications where org_member_id = :'elsewhere'),
  'a technician who services other properties is not');
select assert(
  not exists (select 1 from notifications where org_member_id = :'gone'),
  'a technician whose access was removed is not');
select assert(
  (select count(*) from notifications where org_member_id = :'here') = 1,
  'and nobody is told twice');
select assert(
  not exists (select 1 from notifications where emailed_at is not null),
  'every new notification is waiting to be emailed');

-- The technician sees their own in the bell; another technician does not.
set role authenticated;
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000002', false);
select assert((select count(*) from notifications) = 1,
  'a technician sees the notification addressed to them, and only that');
select set_config('request.jwt.uid', 'a1000000-0000-0000-0000-000000000004', false);
select assert((select count(*) from notifications) = 0,
  'a technician elsewhere sees none');
reset role;

select assert(true, 'request notification tests completed');
