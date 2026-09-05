-- The maintenance workflow: a tenant's request becoming a technician's
-- job, and the money that job accumulates.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'tech@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'tenant@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'othertech@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset
update organizations set mileage_rate = 0.70 where id = :'org';

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Other', '2 St', 'Newport', 'KY', '41071') returning id as prop2 \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

-- A technician scoped to the first property only, and one scoped nowhere.
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select id as tech from org_members
 where user_id = '22222222-2222-2222-2222-222222222222' \gset
insert into technician_property_access (org_member_id, property_id)
values (:'tech', :'prop');

select token from create_invite('othertech@example.com', 'technician') \gset
select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select id as tech2 from org_members
 where user_id = '44444444-4444-4444-4444-444444444444' \gset

-- The tenant who reports the problem.
select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select id as tenant_member from org_members
 where user_id = '33333333-3333-3333-3333-333333333333' \gset

-- ------------------------------------------- request becomes a job --

insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'plumbing', 'Kitchen tap drips constantly', 'normal')
returning id as req \gset

select assert((select status from maintenance_requests where id = :'req') = 'open',
  'a new request starts open');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_job_from_request(:'req', :'tech', current_date) as job \gset

select assert((select status from maintenance_requests where id = :'req') = 'assigned',
  'creating a job marks the request assigned');
select assert((select unit_id from maintenance_jobs where id = :'job') = :'unit',
  'the job inherits the unit from the request rather than trusting the caller');
select assert((select property_id from maintenance_jobs where id = :'job') = :'prop',
  'and the property it belongs to');

-- A technician cannot be sent to a property they have no access to: they
-- would be handed a job they then cannot open.
select assert_rejected(
  format('select create_job_from_request(%L, %L, null)', :'req', :'tech2'),
  'a technician without access to the property cannot be assigned');

-- ----------------------------------- request status follows the job --

update maintenance_jobs set status = 'in_progress' where id = :'job';
select assert((select status from maintenance_requests where id = :'req') = 'in_progress',
  'the tenant sees work has started without anyone updating two places');

update maintenance_jobs set status = 'completed' where id = :'job';
select assert((select status from maintenance_requests where id = :'req') = 'completed',
  'and sees it finished');

-- A request already closed is not reopened by later activity on the job.
update maintenance_requests set status = 'closed' where id = :'req';
update maintenance_jobs set status = 'in_progress' where id = :'job';
select assert((select status from maintenance_requests where id = :'req') = 'closed',
  'a closed request stays closed');

-- ------------------------------------------------------ job costs --

insert into job_entries (job_id, technician_id, entry_type, description, cost, vendor)
values (:'job', :'tech', 'material', 'Tap cartridge', 24.50, 'Hardware store');
insert into job_entries (job_id, technician_id, entry_type, description, miles)
values (:'job', :'tech', 'mileage', 'Round trip for the part', 18);
insert into job_entries (job_id, technician_id, entry_type, description, hours)
values (:'job', :'tech', 'labor', 'Replaced cartridge', 1.5);
insert into job_entries (job_id, technician_id, entry_type, description)
values (:'job', :'tech', 'note', 'Tenant mentioned the shower is slow too');

-- 24.50 of parts + 18 miles at 0.70 = 12.60 -> 37.10
select assert((select total_cost from job_totals(:'job')) = 37.10,
  'job cost is materials plus mileage at the org rate, got '
  || (select total_cost::text from job_totals(:'job')));
select assert((select total_hours from job_totals(:'job')) = 1.5,
  'hours are totalled');
select assert((select total_miles from job_totals(:'job')) = 18,
  'miles are totalled');

-- ----------------------------------------------- entry validation --

select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, hours)
          values (%L, %L, %L, -2)', :'job', :'tech', 'labor'),
  'hours cannot be negative');
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, miles)
          values (%L, %L, %L, -5)', :'job', :'tech', 'mileage'),
  'miles cannot be negative');
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, cost)
          values (%L, %L, %L, -10)', :'job', :'tech', 'material'),
  'a cost cannot be negative');

-- An entry must carry the figure its type exists to record.
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, description)
          values (%L, %L, %L, %L)', :'job', :'tech', 'mileage', 'drove somewhere'),
  'a mileage entry without miles records nothing');
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, description)
          values (%L, %L, %L, %L)', :'job', :'tech', 'material', 'bought something'),
  'a material entry without a cost records nothing');

-- ------------------------------------------------ who sees what --

set role authenticated;

-- The scoped technician sees the job; the unscoped one does not.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from maintenance_jobs) = 1,
  'the assigned technician sees their job');
select assert((select count(*) from job_entries) = 4,
  'and the entries on it');

select set_config('request.jwt.uid', '44444444-4444-4444-4444-444444444444', false);
select assert((select count(*) from maintenance_jobs) = 0,
  'a technician with no property access sees no jobs');
select assert((select count(*) from job_entries) = 0,
  'and no job entries');

-- A tenant sees their own request but not the job's cost entries: what
-- the landlord paid for the part is not part of the tenancy.
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from maintenance_requests) = 1,
  'a tenant sees their own request');
select assert((select count(*) from job_entries) = 0,
  'a tenant does not see what the repair cost the landlord');

-- ------------------------------------------------ push subscriptions --
-- send-request-notifications.mjs needs to read across a whole org's
-- admin/PM subscriptions, but it does that as the postgres superuser
-- (bypassing RLS entirely, like create-test-user.sh); what RLS actually
-- has to hold is that one member can never see or touch another's row.

select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
insert into push_subscriptions (org_member_id, endpoint, p256dh, auth)
values (:'tech', 'https://push.example.com/tech-endpoint', 'p256dh-key', 'auth-key')
returning id as tech_sub \gset

select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from push_subscriptions) = 0,
  'a member sees none of another member''s push subscriptions');
-- A row RLS hides isn't visible to DELETE either, so it matches nothing
-- and succeeds having done nothing — the check is that the row survives.
delete from push_subscriptions where id = :'tech_sub';
select assert_rejected(
  format('insert into push_subscriptions (org_member_id, endpoint, p256dh, auth)
          values (%L, %L, %L, %L)', :'tech', 'https://push.example.com/spoofed', 'k', 'a'),
  'a member cannot create a subscription under someone else''s org_member_id');

select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from push_subscriptions) = 1,
  'a member sees their own push subscription, undeleted by another member''s no-op attempt');

reset role;
select assert(true, 'maintenance tests completed');
