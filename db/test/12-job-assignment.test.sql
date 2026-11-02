-- Assigning work to a technician, and taking access away.
--
-- 027 made assigning a job an offer the technician had to accept; 034
-- took that step out — assigning gives them the job. Kept separate from
-- 05-maintenance.test.sql, which tests the workflow once a job exists.

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

-- ------------------------------------------------- assigning a job --

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_job_from_request(:'req', :'tech', current_date) as job \gset

select assert((select status from maintenance_jobs where id = :'job') = 'scheduled',
  'assigning to a named technician books the job — there is no offer to answer');
select assert(
  (select assigned_technician_id from maintenance_jobs where id = :'job') = :'tech',
  'and it is theirs');
select assert((select status from maintenance_requests where id = :'req') = 'assigned',
  'the tenant''s request reads as assigned');
select assert((select count(*) from notifications
                where org_member_id = :'tech' and title = 'A job has been assigned to you') = 1,
  'the technician is told the job is theirs');

-- An unassigned job has nobody to accept it, so it is booked directly.
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'electrical', 'Hall light out', 'low')
returning id as req2 \gset
select create_job_from_request(:'req2', null, null) as job2 \gset
select assert((select status from maintenance_jobs where id = :'job2') = 'scheduled',
  'a job with no technician on it is scheduled, not left waiting for an answer');

-- ------------------------------------- no accepting or declining --

-- respond_to_job() is retired: neither the technician nor anyone else can
-- accept or decline any more, and an old copy of the app gets told why.
set role authenticated;
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select assert_rejected(format('select respond_to_job(%L, true)', :'job'),
  'a job cannot be accepted — it is already theirs');
select assert_rejected(format('select respond_to_job(%L, false, %L)', :'job', 'busy'),
  'or declined');
reset role;
select assert(
  (select status = 'scheduled' and assigned_technician_id = :'tech'
     from maintenance_jobs where id = :'job'),
  'and the job is untouched by trying');

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
