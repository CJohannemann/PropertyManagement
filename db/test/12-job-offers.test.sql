-- Offering work rather than assigning it, and taking access away.
--
-- Both from db/migrations/027_test_plan_gaps.sql. Kept separate from
-- 05-maintenance.test.sql, which tests the workflow that exists once a job
-- has been accepted — this is the step before that one.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'tech@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'tenant@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'pm@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select id as tech from org_members
 where user_id = '22222222-2222-2222-2222-222222222222' \gset
insert into technician_property_access (org_member_id, property_id)
values (:'tech', :'prop');

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select id as pm from org_members
 where user_id = '44444444-4444-4444-4444-444444444444' \gset

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select id as tenant_member from org_members
 where user_id = '33333333-3333-3333-3333-333333333333' \gset

insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'plumbing', 'Kitchen tap drips', 'normal')
returning id as req \gset

-- --------------------------------------------------- offering a job --

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_job_from_request(:'req', :'tech', current_date) as job \gset

select assert((select status from maintenance_jobs where id = :'job') = 'offered',
  'assigning to a named technician offers the job rather than booking it');

-- The tenant is not shown the difference: from their side the repair has
-- been given to someone either way.
select assert((select status from maintenance_requests where id = :'req') = 'assigned',
  'the request still reads as assigned while the offer is unanswered');

select assert((select count(*) from notifications
                where org_member_id = :'tech' and title like '%offered%') = 1,
  'the technician is told there is work waiting');

-- An unassigned job has nobody to accept it, so it is booked directly.
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'electrical', 'Hall light out', 'low')
returning id as req2 \gset
select create_job_from_request(:'req2', null, null) as job2 \gset
select assert((select status from maintenance_jobs where id = :'job2') = 'scheduled',
  'a job with no technician on it is scheduled, not left waiting for an answer');

-- ------------------------------------------------- answering the offer --

-- Only the technician it was offered to may answer it.
set role authenticated;
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select assert_rejected(
  format('select respond_to_job(%L, true)', :'job'),
  'someone else''s job cannot be accepted out from under them');

select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select respond_to_job(:'job', true);
reset role;

select assert((select status from maintenance_jobs where id = :'job') = 'scheduled',
  'accepting books the job in');
select assert(
  (select assigned_technician_id from maintenance_jobs where id = :'job') = :'tech',
  'and the technician keeps it');

-- Work already under way cannot be handed back: the hours logged against
-- it would be stranded on a job nobody owns.
update maintenance_jobs set status = 'in_progress' where id = :'job';
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('select respond_to_job(%L, false, %L)', :'job', 'changed my mind'),
  'a job that has been started cannot be declined');
reset role;

-- ------------------------------------------------------- declining --

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'hvac', 'No heat upstairs', 'high')
returning id as req3 \gset
select create_job_from_request(:'req3', :'tech', null) as job3 \gset

set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select respond_to_job(:'job3', false, 'Booked up until Thursday');
reset role;

select assert((select status from maintenance_jobs where id = :'job3') = 'declined',
  'declining marks the job declined');
select assert(
  (select assigned_technician_id from maintenance_jobs where id = :'job3') is null,
  'and takes it off the technician who said no, so it is genuinely back in the queue');
select assert(
  (select notes from maintenance_jobs where id = :'job3') like '%Booked up until Thursday%',
  'the reason is kept where whoever reassigns it will read it');
select assert((select status from maintenance_requests where id = :'req3') = 'open',
  'the tenant''s request goes back to open rather than showing a status they cannot act on');

-- --------------------------------------------- telling the tenant --

-- The request status trigger addresses the person who reported it.
select assert((select count(*) from notifications
                where org_member_id = :'tenant_member') > 0,
  'the tenant is notified when their request changes status');

-- And finishing the work tells the office, not only the tenant.
update maintenance_jobs set status = 'completed' where id = :'job';
select assert((select count(*) from notifications
                where org_member_id is null
                  and title = 'A repair has been completed') = 1,
  'completing a job notifies whoever manages the organization');
select assert((select count(*) from notifications
                where org_member_id = :'tenant_member'
                  and title like '%completed%') = 1,
  'and the tenant who reported it');

-- ------------------------------------------------ taking access away --

set role authenticated;

-- A property manager may remove a tenant and no more.
select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);
select set_member_status(:'tenant_member', 'disabled');
reset role;
select assert((select status from org_members where id = :'tenant_member') = 'disabled',
  'a property manager can take a tenant''s access away');

set role authenticated;
select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);
select assert_rejected(
  format('select set_member_status(%L, %L)', :'tech', 'disabled'),
  'a property manager cannot disable staff');

-- The last active admin cannot lock themselves out: nobody could then
-- administer the organization, and there is no way back in from the app.
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select id as owner_member from org_members
 where user_id = '11111111-1111-1111-1111-111111111111' \gset
select assert_rejected(
  format('select set_member_status(%L, %L)', :'owner_member', 'disabled'),
  'the last active admin cannot be disabled');
reset role;

-- Restoring puts them back.
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select set_member_status(:'tenant_member', 'active');
select assert((select status from org_members where id = :'tenant_member') = 'active',
  'access can be given back');

select assert(true, 'job offer and access tests completed');
