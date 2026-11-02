-- Who can see and add files: receipts and repair photos.
--
-- The buckets are private, so every read goes through the policies on
-- storage.objects in db/migrations/011_receipt_storage.sql and
-- 015_request_photo_storage.sql. Those key off the first segment of the
-- object's path — a job id or a request id — which src/lib/maintenance.ts
-- builds. A photo of the inside of someone's home is exactly what must
-- not leak between tenants, or between landlords.

-- The migrations create both buckets, but storage.buckets.owner references
-- auth.users, so the runner's `truncate auth.users cascade` between files
-- takes the buckets with it. Put them back as the migrations would.
insert into storage.buckets (id, name) values
  ('receipts', 'receipts'), ('request-photos', 'request-photos')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('a0000000-0000-0000-0000-000000000002', 'pm@example.com'),
  ('a0000000-0000-0000-0000-000000000003', 'tech@example.com'),
  ('a0000000-0000-0000-0000-000000000004', 'othertech@example.com'),
  ('a0000000-0000-0000-0000-000000000005', 'tenant@example.com'),
  ('a0000000-0000-0000-0000-000000000006', 'neighbour@example.com'),
  ('b0000000-0000-0000-0000-000000000001', 'stranger@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('stranger@example.com');

-- A second landlord, who must see none of the first one's files.
select set_config('request.jwt.uid', 'b0000000-0000-0000-0000-000000000001', false);
select create_organization('Other Org') as org_b \gset

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit_a \gset
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a', '2026-01-01', 1200, 1, 'active') returning id as lease_a \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', '2026-01-01', 1200, 1, 'active') returning id as lease_b \gset

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select token from create_invite('othertech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000004', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tenant@example.com', 'tenant', :'lease_a', 'A Tenant') \gset
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select token from create_invite('neighbour@example.com', 'tenant', :'lease_b', 'Next Door') \gset
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000006', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select id as tech from org_members
 where user_id = 'a0000000-0000-0000-0000-000000000003' \gset
select id as othertech from org_members
 where user_id = 'a0000000-0000-0000-0000-000000000004' \gset
select id as tenant_member from org_members
 where user_id = 'a0000000-0000-0000-0000-000000000005' \gset

-- Both technicians can work at this property; only one gets the job. The
-- point is that property access is not file access.
insert into technician_property_access (org_member_id, property_id)
values (:'tech', :'prop'), (:'othertech', :'prop');

insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit_a', :'tenant_member', 'plumbing', 'Leak under the sink', 'normal')
returning id as req \gset

-- ---------------------------------------------------- repair photos --

set role authenticated;

-- The tenant who reported it can attach photos.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
insert into storage.objects (bucket_id, name)
values ('request-photos', :'req' || '/leak.jpg'),
       ('request-photos', :'req' || '/mistake.jpg');

-- Nobody else outside the office can.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000006', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'request-photos', :'req' || '/neighbour.jpg'),
  'a tenant of another unit cannot add photos to someone else''s request');

select set_config('request.jwt.uid', 'b0000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'request-photos', :'req' || '/stranger.jpg'),
  'another landlord cannot add photos to this landlord''s request');

-- A path that is not keyed by a request belongs to nobody.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'request-photos', 'not-a-request/loose.jpg'),
  'a photo not filed under a request is refused, even for the owner');

-- While the request is still open, its reporter may take a photo back.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
delete from storage.objects
 where bucket_id = 'request-photos' and name = :'req' || '/mistake.jpg';
reset role;
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'the reporter can delete their own photo while the request is open');

-- Who can see it.
set role authenticated;
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'the tenant who reported it can see their photo');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'the owner can see it');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000002', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'a property manager can see it');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000006', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 0,
  'a tenant of another unit cannot');

select set_config('request.jwt.uid', 'b0000000-0000-0000-0000-000000000001', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 0,
  'another landlord cannot');

-- Before there is a job, no technician has any business with it.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 0,
  'a technician cannot see photos for work nobody has given them');
reset role;

-- Now it becomes a job, assigned to one technician.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select create_job_from_request(:'req', :'tech', current_date) as job \gset
set role authenticated;
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
-- Assigned directly (034): the job is the technician's with no accept step.

select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'the technician doing the job can see what they are walking into');

-- But they view the tenant's photos; they do not add to them.
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'request-photos', :'req' || '/tech.jpg'),
  'a technician cannot add photos to the tenant''s request');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000004', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 0,
  'a technician with access to the property but not the job cannot see them');

-- Once the request is being worked on, the photo is part of the record:
-- the reporter can no longer quietly remove it.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
delete from storage.objects
 where bucket_id = 'request-photos' and name = :'req' || '/leak.jpg';
reset role;
select assert(
  (select count(*) from storage.objects where bucket_id = 'request-photos') = 1,
  'the reporter cannot delete a photo once the request is no longer open');

-- --------------------------------------------------------- receipts --

set role authenticated;

-- The technician on the job files receipts against it.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
insert into storage.objects (bucket_id, name)
values ('receipts', :'job' || '/parts.jpg');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000004', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'receipts', :'job' || '/padding.jpg'),
  'a technician not on the job cannot file receipts against it');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'receipts', :'job' || '/tenant.jpg'),
  'a tenant cannot file receipts');

select set_config('request.jwt.uid', 'b0000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'receipts', :'job' || '/stranger.jpg'),
  'another landlord cannot file receipts against this landlord''s job');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
insert into storage.objects (bucket_id, name)
values ('receipts', :'job' || '/office.pdf');
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'receipts', 'loose/receipt.jpg'),
  'a receipt not filed under a job is refused, even for the owner');

-- Who can see them.
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 2,
  'the owner sees every receipt on the job');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000002', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 2,
  'a property manager sees them');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 2,
  'the technician on the job sees them');

select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000004', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 0,
  'another technician does not');

-- What the landlord paid for parts is the landlord's business.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 0,
  'the tenant does not');

select set_config('request.jwt.uid', 'b0000000-0000-0000-0000-000000000001', false);
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 0,
  'another landlord does not');

-- A receipt is evidence of money spent: the technician who filed it
-- cannot make it disappear.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
delete from storage.objects where bucket_id = 'receipts';
reset role;
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 2,
  'a technician cannot delete receipts');

set role authenticated;
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
delete from storage.objects
 where bucket_id = 'receipts' and name = :'job' || '/office.pdf';
reset role;
select assert(
  (select count(*) from storage.objects where bucket_id = 'receipts') = 1,
  'the owner can');

-- --------------------------------------------------- access removed --

-- Taking someone's access away has to take their files away with it.
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000001', false);
select set_member_status(:'tech', 'disabled');
select set_member_status(:'tenant_member', 'disabled');

set role authenticated;
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000003', false);
select assert(
  (select count(*) from storage.objects) = 0,
  'a disabled technician sees no receipts or photos');
select set_config('request.jwt.uid', 'a0000000-0000-0000-0000-000000000005', false);
select assert(
  (select count(*) from storage.objects) = 0,
  'a disabled tenant sees none of their old photos');
reset role;

select assert(true, 'file access tests completed');
