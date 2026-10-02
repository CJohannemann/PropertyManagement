-- Message threads: who can read and post in them.
--
-- A thread hangs off a lease (office <-> tenant) or a job (office <->
-- technician), and can_access_thread decides who is in it. Nothing in the
-- app sends messages yet, but the table and its policies are live, so a
-- client could use them today — which is reason enough to know they hold.

insert into auth.users (id, email) values
  ('c0000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('c0000000-0000-0000-0000-000000000002', 'pm@example.com'),
  ('c0000000-0000-0000-0000-000000000003', 'tech@example.com'),
  ('c0000000-0000-0000-0000-000000000004', 'othertech@example.com'),
  ('c0000000-0000-0000-0000-000000000005', 'tenant@example.com'),
  ('c0000000-0000-0000-0000-000000000006', 'neighbour@example.com'),
  ('d0000000-0000-0000-0000-000000000001', 'stranger@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('stranger@example.com');

select set_config('request.jwt.uid', 'd0000000-0000-0000-0000-000000000001', false);
select create_organization('Other Org') as org_b \gset
select id as stranger from org_members
 where user_id = 'd0000000-0000-0000-0000-000000000001' \gset

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset
select id as owner_member from org_members
 where user_id = 'c0000000-0000-0000-0000-000000000001' \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit_a \gset
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a', '2026-01-01', 1200, 1, 'active') returning id as lease_a \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', '2026-01-01', 1200, 1, 'active') returning id as lease_b \gset

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000003', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select token from create_invite('othertech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000004', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tenant@example.com', 'tenant', :'lease_a', 'A Tenant') \gset
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select token from create_invite('neighbour@example.com', 'tenant', :'lease_b', 'Next Door') \gset
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000006', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select id as tech from org_members
 where user_id = 'c0000000-0000-0000-0000-000000000003' \gset
select id as othertech from org_members
 where user_id = 'c0000000-0000-0000-0000-000000000004' \gset
select id as tenant_member from org_members
 where user_id = 'c0000000-0000-0000-0000-000000000005' \gset
select id as neighbour from org_members
 where user_id = 'c0000000-0000-0000-0000-000000000006' \gset

insert into technician_property_access (org_member_id, property_id)
values (:'tech', :'prop'), (:'othertech', :'prop');
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit_a', :'tenant_member', 'plumbing', 'Leak', 'normal') returning id as req \gset
select create_job_from_request(:'req', :'tech', current_date) as job \gset

-- -------------------------------------------------- a lease thread --

set role authenticated;

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
values (:'org', 'lease', :'lease_a', :'tenant_member', 'When is the inspection?');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000002', false);
select get_my_member_id(:'org') as pm \gset
insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
values (:'org', 'lease', :'lease_a', :'pm', 'Thursday at 10.');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
select assert((select count(*) from messages) = 2,
  'the tenant sees both sides of their own lease thread');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select assert((select count(*) from messages) = 2, 'the owner sees it');
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000002', false);
select assert((select count(*) from messages) = 2, 'a property manager sees it');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000006', false);
select assert((select count(*) from messages) = 0,
  'a tenant of another unit cannot read it');
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'lease', %L, %L, 'hello')$$, :'org', :'lease_a', :'neighbour'),
  'or post in it');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000003', false);
select assert((select count(*) from messages) = 0,
  'a technician cannot read a tenant''s lease thread');

select set_config('request.jwt.uid', 'd0000000-0000-0000-0000-000000000001', false);
select assert((select count(*) from messages) = 0, 'another landlord cannot read it');

-- Posting as someone else.
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'lease', %L, %L, 'Rent is waived this month.')$$,
         :'org', :'lease_a', :'owner_member'),
  'a tenant cannot post a message in the landlord''s name');

-- -------------------------------------------------- crossing orgs --

-- A thread's organization comes from the row being written, and the
-- thread it points at is a separate id. If the two are not checked
-- against each other, a landlord who is admin of their OWN organization
-- passes the office check and can drop a message into any other
-- landlord's lease — where that lease's tenant then reads it as coming
-- from their landlord's office.
select set_config('request.jwt.uid', 'd0000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'lease', %L, %L, 'Please pay rent to this new account.')$$,
         :'org_b', :'lease_a', :'stranger'),
  'another landlord cannot post into this landlord''s lease thread under their own organization');
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'job', %L, %L, 'Job cancelled.')$$,
         :'org_b', :'job', :'stranger'),
  'or into this landlord''s job thread');

-- ---------------------------------------------------- a job thread --

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000003', false);
insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
values (:'org', 'job', :'job', :'tech', 'Need to shut the water off for an hour.');
select assert(
  (select count(*) from messages where thread_type = 'job') = 1,
  'the technician on the job can post and read in its thread');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000004', false);
select assert((select count(*) from messages) = 0,
  'a technician not on the job cannot read its thread');
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'job', %L, %L, 'hi')$$, :'org', :'job', :'othertech'),
  'or post in it');

-- The office-technician thread is not the tenant's to read.
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
select assert(
  (select count(*) from messages where thread_type = 'job') = 0,
  'the tenant cannot read the job thread about their own repair');

select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select assert((select count(*) from messages) = 3,
  'the owner sees every thread in the organization');

-- ------------------------------------------------- access removed --

reset role;
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000001', false);
select set_member_status(:'tenant_member', 'disabled');

set role authenticated;
select set_config('request.jwt.uid', 'c0000000-0000-0000-0000-000000000005', false);
select assert((select count(*) from messages) = 0,
  'a disabled tenant can no longer read their old thread');
select assert_rejected(
  format($$insert into messages (organization_id, thread_type, thread_ref_id, sender_id, body)
           values (%L, 'lease', %L, %L, 'still here?')$$,
         :'org', :'lease_a', :'tenant_member'),
  'or post in it');
reset role;

select assert(true, 'message tests completed');
