-- An invite must never change an existing member's role.
--
-- This is a regression test for a bug found in real use: the owner opened
-- a tenant invite link to see what a tenant would see, and the upsert in
-- accept_invite overwrote his admin role with 'tenant'. He lost access to
-- his own organization and was billed rent on a lease he owned.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'tenant@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'manager@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select assert(
  (select role from org_members where user_id = '11111111-1111-1111-1111-111111111111')
    = 'admin',
  'the organization creator starts as admin');

-- ---------------------------------- the exact reported scenario --

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset

-- The owner opens the invite link himself, still signed in as himself.
select assert_rejected(
  format('select accept_invite(%L)', :'token'),
  'an admin opening a tenant invite is refused, not converted');

select assert(
  (select role from org_members where user_id = '11111111-1111-1111-1111-111111111111')
    = 'admin',
  'and keeps their admin role');
select assert(
  (select count(*) from lease_tenants) = 0,
  'and is not attached to the lease');

-- The invite must survive, so the person it was for can still use it.
select assert(
  (select status from invites where token = :'token') = 'pending',
  'the invite is still usable by its intended recipient');

-- ------------------------------------- the invite still works --

select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');
select assert(
  (select role from org_members where user_id = '22222222-2222-2222-2222-222222222222')
    = 'tenant',
  'the intended recipient becomes a tenant');
select assert((select count(*) from lease_tenants) = 1,
  'and is attached to the lease');
select assert(
  (select is_primary from lease_tenants) = true,
  'as the primary tenant, being the first on it');

-- ------------------------------- other roles are protected too --

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select token from create_invite('manager@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select assert(
  (select role from org_members where user_id = '33333333-3333-3333-3333-333333333333')
    = 'property_manager',
  'a property manager joins as one');

-- A property manager opening a tenant invite is refused the same way.
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', '2026-01-01', 900, 1, 'active') returning id as lease_b \gset
select token from create_invite('someone@example.com', 'tenant', :'lease_b', 'Someone') \gset

select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select assert_rejected(
  format('select accept_invite(%L)', :'token'),
  'a property manager opening a tenant invite is refused');
select assert(
  (select role from org_members where user_id = '33333333-3333-3333-3333-333333333333')
    = 'property_manager',
  'and keeps their role');

-- --------------------------------- re-accepting your own role --

-- Accepting an invite for the role you already hold is harmless; the
-- guard is about role CHANGES, not about being strict for its own sake.
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select token from create_invite('tenant@example.com', 'tenant', :'lease_b', 'A Tenant') \gset
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');
select assert(
  (select count(*) from lease_tenants) = 2,
  'an existing tenant can be added to a second lease');
select assert(
  (select role from org_members where user_id = '22222222-2222-2222-2222-222222222222')
    = 'tenant',
  'and is still a tenant');

select assert(true, 'invite role tests completed');
