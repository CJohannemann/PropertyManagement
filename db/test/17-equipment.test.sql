-- Equipment inventory, and who can grant a technician access to it.
--
-- A technician sees the make and model of what is installed at the
-- properties they service, and can record what a data plate says. They
-- cannot see equipment anywhere else, cannot delete it, and cannot give
-- themselves access. set_technician_access is the only way the app writes
-- that scope.

insert into auth.users (id, email) values
  ('e0000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('e0000000-0000-0000-0000-000000000002', 'pm@example.com'),
  ('e0000000-0000-0000-0000-000000000003', 'tech@example.com'),
  ('e0000000-0000-0000-0000-000000000004', 'othertech@example.com'),
  ('e0000000-0000-0000-0000-000000000005', 'tenant@example.com'),
  ('f0000000-0000-0000-0000-000000000001', 'stranger@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('stranger@example.com');

select set_config('request.jwt.uid', 'f0000000-0000-0000-0000-000000000001', false);
select create_organization('Other Org') as org_b \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_b', 'Elsewhere', '9 Rd', 'Dayton', 'OH', '45402') returning id as prop_b \gset

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset
select id as owner_member from org_members
 where user_id = 'e0000000-0000-0000-0000-000000000001' \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Duplex', '1 St', 'Covington', 'KY', '41051') returning id as duplex \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'House', '2 St', 'Covington', 'KY', '41051') returning id as house \gset
insert into units (property_id, label) values (:'duplex', 'Up') returning id as up \gset
insert into units (property_id, label) values (:'duplex', 'Down') returning id as down \gset
insert into units (property_id, label) values (:'house', 'Main') returning id as main \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'up', '2026-01-01', 1200, 1, 'active') returning id as lease_up \gset

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000003', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
select token from create_invite('othertech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000004', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
select token from create_invite('tenant@example.com', 'tenant', :'lease_up', 'Up Tenant') \gset
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000005', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
select id as tech from org_members where user_id = 'e0000000-0000-0000-0000-000000000003' \gset
select id as othertech from org_members where user_id = 'e0000000-0000-0000-0000-000000000004' \gset
select id as pm from org_members where user_id = 'e0000000-0000-0000-0000-000000000002' \gset
select id as tenant_member from org_members where user_id = 'e0000000-0000-0000-0000-000000000005' \gset

set role authenticated;

-- ------------------------------------------ granting technician access --

-- Owner scopes the tech to the duplex only.
select set_technician_access(:'tech', false, array[:'duplex']::uuid[]);
select assert(
  (select count(*) from technician_property_access where org_member_id = :'tech') = 1,
  'a technician can be scoped to one property');

-- A property manager can change it too, and switching to "all" replaces
-- the specific rows rather than piling on top of them.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000002', false);
select set_technician_access(:'othertech', true);
select assert(
  (select count(*) from technician_property_access
    where org_member_id = :'othertech' and property_id is null) = 1,
  'a property manager can give a technician every property');
select set_technician_access(:'othertech', false, array[:'duplex', :'house']::uuid[]);
select assert(
  (select count(*) from technician_property_access where org_member_id = :'othertech') = 2
  and not exists (select 1 from technician_property_access
                   where org_member_id = :'othertech' and property_id is null),
  'switching from all to a list replaces the all row');
select set_technician_access(:'othertech', false, '{}');
select assert(
  not exists (select 1 from technician_property_access where org_member_id = :'othertech'),
  'an empty list removes all access');

select assert_rejected(
  format($$select set_technician_access(%L, false, array[%L]::uuid[])$$, :'othertech', :'prop_b'),
  'another organization''s property cannot be granted');
select assert_rejected(
  format($$select set_technician_access(%L, true)$$, :'pm'),
  'property access is for technicians, not other roles');

-- A technician cannot widen their own access.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000003', false);
select assert_rejected(
  format($$select set_technician_access(%L, true)$$, :'tech'),
  'a technician cannot grant themselves every property');

-- Nor can another organization's admin touch it.
select set_config('request.jwt.uid', 'f0000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format($$select set_technician_access(%L, true)$$, :'tech'),
  'a stranger cannot change this organization''s technician access');

-- ------------------------------------------------------- equipment --

select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000001', false);
insert into equipment (property_id, unit_id, category, make, model, serial_number)
values (:'duplex', :'up', 'water_heater', 'Rheem', 'XE50T06ST45U1', 'Q1234') returning id as wh \gset
insert into equipment (property_id, unit_id, category, make, model)
values (:'duplex', null, 'boiler', 'Weil-McLain', 'CGa-4') returning id as boiler \gset
insert into equipment (property_id, unit_id, category, make, model)
values (:'house', :'main', 'dishwasher', 'Bosch', 'SHX878WD5N') returning id as dw \gset

select assert_rejected(
  format($$insert into equipment (property_id, unit_id, category) values (%L, %L, 'dryer')$$,
         :'house', :'up'),
  'a unit''s equipment must be in that unit''s property');
select assert_rejected(
  format($$insert into equipment (property_id, category) values (%L, 'toaster')$$, :'duplex'),
  'category is one of the known kinds');

-- The scoped technician sees the duplex — both units' and the shared
-- boiler — and nothing at the house.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000003', false);
select assert((select count(*) from equipment) = 2,
  'a technician sees equipment only at properties they service');
select assert((select count(*) from properties) = 1,
  'and only those properties');
select assert((select count(*) from units) = 2,
  'and every unit at them');

-- They can record what they find, and correct it.
insert into equipment (property_id, unit_id, category, make, model, created_by)
values (:'duplex', :'down', 'air_conditioner', 'Carrier', '24ACC636A003', :'tech');
update equipment set serial_number = 'Q9999' where id = :'wh';
select assert(
  (select serial_number from equipment where id = :'wh') = 'Q9999',
  'a technician can correct equipment at a property they service');

select assert_rejected(
  format($$insert into equipment (property_id, unit_id, category) values (%L, %L, 'range')$$,
         :'house', :'main'),
  'a technician cannot add equipment at a property they do not service');

-- Moving a row to a property they cannot see is the same as adding there.
select assert_rejected(
  format($$update equipment set property_id = %L, unit_id = %L where id = %L$$,
         :'house', :'main', :'wh'),
  'a technician cannot move equipment to a property they do not service');

-- Delete is office-only. RLS filters a disallowed delete to zero rows
-- rather than raising, so check the row survived.
delete from equipment where id = :'boiler';
select assert(exists (select 1 from equipment where id = :'boiler'),
  'a technician cannot delete equipment');

-- Unscoped technician sees nothing.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000004', false);
select assert((select count(*) from equipment) = 0,
  'a technician with no access sees no equipment');

-- Tenants do not see the inventory, even in their own unit.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000005', false);
select assert((select count(*) from equipment) = 0,
  'a tenant does not see equipment');

-- Another organization sees nothing and cannot write here.
select set_config('request.jwt.uid', 'f0000000-0000-0000-0000-000000000001', false);
select assert((select count(*) from equipment) = 0,
  'another organization sees no equipment');
select assert_rejected(
  format($$insert into equipment (property_id, category) values (%L, 'other')$$, :'duplex'),
  'another organization cannot add equipment here');

-- The property manager sees all of it and can delete.
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000002', false);
select assert((select count(*) from equipment) = 4,
  'a property manager sees every property''s equipment');
delete from equipment where id = :'dw';
select assert(not exists (select 1 from equipment where id = :'dw'),
  'a property manager can delete equipment');

-- Access removed takes the inventory with it.
select set_technician_access(:'tech', false, '{}');
select set_config('request.jwt.uid', 'e0000000-0000-0000-0000-000000000003', false);
select assert((select count(*) from equipment) = 0,
  'removing a technician''s access hides the equipment again');

reset role;

-- Removing a unit removes its equipment, but not the building's.
delete from units where id = :'up';
select assert(not exists (select 1 from equipment where id = :'wh'),
  'deleting a unit deletes its equipment');
select assert(exists (select 1 from equipment where id = :'boiler'),
  'building-wide equipment survives a unit being deleted');

select assert(true, 'equipment tests completed');
