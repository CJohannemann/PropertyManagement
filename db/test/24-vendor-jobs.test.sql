-- Hiring an outside vendor for a job, property managers logging job
-- costs, and what was done (039).

insert into storage.buckets (id, name) values ('receipts', 'receipts')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('f1111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('f2222222-2222-2222-2222-222222222222', 'tech@example.com'),
  ('f3333333-3333-3333-3333-333333333333', 'tenant@example.com'),
  ('f4444444-4444-4444-4444-444444444444', 'pm@example.com'),
  ('f5555555-5555-5555-5555-555555555555', 'other@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com'), ('other@example.com');

select set_config('request.jwt.uid', 'f5555555-5555-5555-5555-555555555555', false);
select create_organization('Other Org') as org2 \gset
insert into vendors (organization_id, name) values (:'org2', 'Not yours')
returning id as v_other \gset

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset
select id as owner_member from org_members
 where user_id = 'f1111111-1111-1111-1111-111111111111' \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select id as tech from org_members
 where user_id = 'f2222222-2222-2222-2222-222222222222' \gset
insert into technician_property_access (org_member_id, property_id) values (:'tech', :'prop');

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select id as pm from org_members
 where user_id = 'f4444444-4444-4444-4444-444444444444' \gset

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', 'f3333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select id as tenant_member from org_members
 where user_id = 'f3333333-3333-3333-3333-333333333333' \gset

insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'pest', 'Mice in the kitchen', 'high')
returning id as req \gset
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit', :'tenant_member', 'plumbing', 'Tap drips', 'normal')
returning id as req2 \gset

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
insert into vendors (organization_id, name, business_name)
values (:'org', 'Sam', 'ABC Pest Control') returning id as v_pest \gset

-- --------------------------------------------------- hiring a vendor --

set role authenticated;
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);

select assert_rejected(
  format('select create_job_from_request(%L, %L, null, %L)', :'req', :'tech', :'v_pest'),
  'a job cannot go to a technician and a vendor at once');
select assert_rejected(
  format('select create_job_from_request(%L, null, null, %L)', :'req', :'v_other'),
  'another organization''s vendor cannot be hired');

select create_job_from_request(:'req', null, '2026-11-10', :'v_pest') as job \gset

select assert((select vendor_id from maintenance_jobs where id = :'job') = :'v_pest',
  'a property manager can hire a vendor for a request');
select assert((select assigned_technician_id is null and status = 'scheduled'
                 from maintenance_jobs where id = :'job'),
  'the job is booked, with no technician on it');
reset role;

select assert((select status from maintenance_requests where id = :'req') = 'assigned',
  'the request reads as assigned');
select assert((select count(*) from notifications
                where org_member_id = :'tenant_member'
                  and title = 'Someone is booked in for your repair') = 1,
  'the tenant hears someone is booked in');
select assert((select count(*) from notifications
                where title = 'A job has been assigned to you') = 0,
  'nobody is told a job is theirs — the vendor has no login');

-- Three arguments still work, as an older copy of the app sends them.
set role authenticated;
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select create_job_from_request(:'req2', :'tech', null) as job2 \gset
reset role;
select assert((select assigned_technician_id from maintenance_jobs where id = :'job2') = :'tech',
  'assigning a technician works as before');

-- Updating who is on a job: the office can, a technician cannot.
select assert_rejected(
  format('update maintenance_jobs set vendor_id = %L where id = %L', :'v_pest', :'job2'),
  'a job with a technician cannot also have a vendor');

set role authenticated;
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('update maintenance_jobs set assigned_technician_id = null, vendor_id = %L where id = %L',
         :'v_pest', :'job2'),
  'a technician cannot hand their job to a vendor');
update maintenance_jobs set status = 'in_progress' where id = :'job2';
reset role;
select assert((select status from maintenance_jobs where id = :'job2') = 'in_progress',
  'and can still work it');

set role authenticated;
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select assert_rejected(
  format('update maintenance_jobs set vendor_id = %L where id = %L', :'v_other', :'job'),
  'a job cannot be moved to another organization''s vendor');

-- ------------------------------------------------ manager logs costs --

insert into job_entries (job_id, technician_id, entry_type, description, cost)
values (:'job', :'pm', 'labor', 'Inspection and treatment', 300)
returning id as invoice \gset
insert into job_entries (job_id, technician_id, entry_type, description, cost, vendor)
values (:'job', :'pm', 'material', 'Traps', 25, 'Hardware store');
insert into job_entries (job_id, technician_id, entry_type, description)
values (:'job', :'pm', 'note', 'Tenant let them in');
select assert((select count(*) from job_entries where job_id = :'job') = 3,
  'a property manager can log an invoice, materials and notes on a job');

select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, cost) values (%L, %L, %L, 1)',
         :'job', :'tech', 'labor'),
  'a manager cannot log costs in someone else''s name');

update job_entries set cost = 325 where id = :'invoice';
select assert((select cost from job_entries where id = :'invoice') = 325,
  'a property manager can correct a cost');

insert into storage.objects (bucket_id, name) values ('receipts', :'job' || '/invoice.pdf');
select assert((select count(*) from storage.objects
                where bucket_id = 'receipts' and name = :'job' || '/invoice.pdf') = 1,
  'a property manager can attach the invoice');
delete from storage.objects where bucket_id = 'receipts' and name = :'job' || '/invoice.pdf';
reset role;
select assert((select count(*) from storage.objects
                where bucket_id = 'receipts' and name = :'job' || '/invoice.pdf') = 1,
  'but cannot delete a stored receipt — it is the tax record');

-- A labor entry with neither hours nor a cost is still refused.
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type) values (%L, %L, %L)',
         :'job', :'pm', 'labor'),
  'a labor entry must carry hours or a cost');

-- The technician still cannot log on a job that is not theirs.
set role authenticated;
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('insert into job_entries (job_id, technician_id, entry_type, cost) values (%L, %L, %L, 1)',
         :'job', :'tech', 'material'),
  'a technician cannot log costs on a vendor''s job');
reset role;

-- -------------------------------------------------- what was done --

set role authenticated;
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
update maintenance_jobs
   set completion_notes = 'Treated kitchen and basement. Follow-up in 30 days.',
       status = 'completed', completed_date = current_date
 where id = :'job';
reset role;
select assert((select completion_notes from maintenance_jobs where id = :'job')
                like 'Treated kitchen%',
  'a property manager records what was done');
select assert((select status from maintenance_requests where id = :'req') = 'completed',
  'and completing the job completes the request');

-- -------------------------------------------------------------- books --

-- Entries dated into 2026 so the year is fixed.
update job_entries set created_at = '2026-06-15 12:00:00-04' where job_id = :'job';

set role authenticated;
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);

select assert(
  (select from_jobs from vendor_totals(:'org', 2026) where vendor_id = :'v_pest') = 325,
  'the invoice counts toward the vendor''s 1099 total, the store-bought traps do not');

select assert(
  (select category from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where id = :'invoice') = 'cleaning_maintenance',
  'pest control is filed under cleaning and maintenance');
select assert(
  (select payee from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where id = :'invoice') = 'ABC Pest Control',
  'the invoice shows the vendor as the payee');
select assert(
  (select vendor_id from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where id = :'invoice') = :'v_pest',
  'and is linked to the vendor');
select assert(
  (select payee from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where description = 'Traps') = 'Hardware store',
  'materials name the store they were bought from');
reset role;

-- A closed year keeps the category it was filed under.
insert into closed_years (organization_id, year) values (:'org', 2026);
set role authenticated;
select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select assert(
  (select category from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where id = :'invoice') = 'repairs',
  'in a closed year, pest jobs stay under repairs as filed');

-- And a manager cannot change costs in it.
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select assert_rejected(
  format('update job_entries set cost = 1 where id = %L', :'invoice'),
  'a property manager cannot change a job cost in a closed year');
reset role;

select assert(true, 'vendor job tests completed');
