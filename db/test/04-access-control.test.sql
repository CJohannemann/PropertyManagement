-- Row-level security: who can see and change what.
--
-- These are the tests worth having most. A permission bug does not break
-- anything visibly — the app keeps working, and one landlord's tenant can
-- read another landlord's leases.

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'landlord.a@example.com'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'landlord.b@example.com'),
  ('cccccccc-0000-0000-0000-000000000003', 'tenant.a@example.com'),
  ('dddddddd-0000-0000-0000-000000000004', 'stranger@example.com');
insert into org_creation_allowlist (email)
values ('landlord.a@example.com'), ('landlord.b@example.com');

-- Two independent landlords.
select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select create_organization('Landlord A') as org_a \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_a', 'A House', '1 A St', 'Covington', 'KY', '41051') returning id as prop_a \gset
insert into units (property_id, label) values (:'prop_a', 'A1') returning id as unit_a \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a', '2026-01-01', 1200, 1, 'active') returning id as lease_a \gset

select set_config('request.jwt.uid', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select create_organization('Landlord B') as org_b \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_b', 'B House', '1 B St', 'Newport', 'KY', '41071') returning id as prop_b \gset

-- Landlord A invites a tenant onto their lease.
select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select token from create_invite('tenant.a@example.com', 'tenant', :'lease_a', 'Tenant A') \gset
select set_config('request.jwt.uid', 'cccccccc-0000-0000-0000-000000000003', false);
select accept_invite(:'token');

-- ------------------------------------------- organization isolation --

set role authenticated;

select set_config('request.jwt.uid', 'bbbbbbbb-0000-0000-0000-000000000002', false);
select assert((select count(*) from properties) = 1,
  'landlord B sees only their own property');
select assert((select name from properties) = 'B House',
  'and it is theirs, not landlord A''s');
select assert((select count(*) from leases) = 0,
  'landlord B sees none of landlord A''s leases');

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-000000000001', false);
select assert((select count(*) from properties) = 1, 'landlord A sees only their own');
select assert((select name from properties) = 'A House', 'and it is theirs');

-- ------------------------------------------------ a signed-in stranger --

select set_config('request.jwt.uid', 'dddddddd-0000-0000-0000-000000000004', false);
select assert((select count(*) from properties) = 0, 'a stranger sees no properties');
select assert((select count(*) from leases) = 0, 'a stranger sees no leases');
select assert((select count(*) from organizations) = 0, 'a stranger sees no organizations');
select assert((select count(*) from rent_charges) = 0, 'a stranger sees no charges');

reset role;
select assert_rejected(
  'select create_organization(''Squatter Org'')',
  'a user not on the allowlist cannot create an organization');

-- ---------------------------------------------------------- the tenant --

set role authenticated;
select set_config('request.jwt.uid', 'cccccccc-0000-0000-0000-000000000003', false);

select assert((select count(*) from leases) = 1, 'a tenant sees their own lease');
select assert((select count(*) from properties) = 1,
  'a tenant sees the property they live in');
select assert((select name from properties) = 'A House',
  'and only that one');

-- A tenant must not be able to write the things that decide what they owe.
reset role;
select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          insert into leases (unit_id, start_date, rent_amount, rent_due_day)
          values (%L, ''2026-01-01'', 1, 1)',
         'cccccccc-0000-0000-0000-000000000003', :'unit_a'),
  'a tenant cannot create a lease');

select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          insert into properties (organization_id, name, address_line1, city, state, zip)
          values (%L, ''X'', ''1 St'', ''Covington'', ''KY'', ''41051'')',
         'cccccccc-0000-0000-0000-000000000003', :'org_a'),
  'a tenant cannot add a property');

-- payments has no client-facing insert policy at all: a payment becomes
-- real only when the processor confirms it, written server-side. A
-- browser able to insert one could fake a rent payment.
select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          insert into payments (lease_id, tenant_member_id, amount, total_charged, method, status)
          values (%L, (select id from org_members
                        where user_id = %L), 1200, 1200, ''ach'', ''succeeded'')',
         'cccccccc-0000-0000-0000-000000000003', :'lease_a',
         'cccccccc-0000-0000-0000-000000000003'),
  'a tenant cannot record their own payment as succeeded');

-- Renaming yourself must not be a route to changing your own role.
set role authenticated;
select set_config('request.jwt.uid', 'cccccccc-0000-0000-0000-000000000003', false);
select set_my_full_name('Tenant A Renamed');
update org_members set role = 'admin'
 where user_id = 'cccccccc-0000-0000-0000-000000000003';
reset role;
select assert(
  (select role from org_members where user_id = 'cccccccc-0000-0000-0000-000000000003')
    = 'tenant',
  'a tenant cannot promote themselves to admin');
select assert(
  (select full_name from org_members where user_id = 'cccccccc-0000-0000-0000-000000000003')
    = 'Tenant A Renamed',
  'but they can correct their own name');

select assert(true, 'access control tests completed');
