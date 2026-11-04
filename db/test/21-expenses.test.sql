-- The expense log (036): bills a landlord pays, by Schedule E category,
-- plus the repair-job costs already in the app, in one list.
--
-- Checks that the office can record and read expenses, that nobody else
-- can, that a bill cannot be filed against another landlord's property,
-- and that expense_lines() adds up entered expenses and job costs
-- without counting anything twice.

insert into auth.users (id, email) values
  ('e1111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('e2222222-2222-2222-2222-222222222222', 'other@example.com'),
  ('e3333333-3333-3333-3333-333333333333', 'tech@example.com'),
  ('e4444444-4444-4444-4444-444444444444', 'pm@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('other@example.com');

select set_config('request.jwt.uid', 'e1111111-1111-1111-1111-111111111111', false);
select create_organization('Owner Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Central', '807', 'Newport', 'KY', '41071') returning id as prop \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Forrest', '12', 'Newport', 'KY', '41071') returning id as prop2 \gset
insert into units (property_id, label) values (:'prop', '1') returning id as unit \gset
select id as owner_member from org_members
 where user_id = 'e1111111-1111-1111-1111-111111111111' \gset

select token as tech_token from create_invite('tech@example.com', 'technician', null, 'Tech') \gset
select token as pm_token from create_invite('pm@example.com', 'property_manager', null, 'PM') \gset
select set_config('request.jwt.uid', 'e3333333-3333-3333-3333-333333333333', false);
select accept_invite(:'tech_token');
select set_config('request.jwt.uid', 'e4444444-4444-4444-4444-444444444444', false);
select accept_invite(:'pm_token');

select set_config('request.jwt.uid', 'e2222222-2222-2222-2222-222222222222', false);
select create_organization('Other Org') as org2 \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org2', 'Theirs', '1', 'Newport', 'KY', '41071') returning id as prop_other \gset

-- ------------------------------------------------ recording a bill --

set role authenticated;
select set_config('request.jwt.uid', 'e1111111-1111-1111-1111-111111111111', false);

insert into expenses (organization_id, property_id, category, spent_on, amount, payee)
values (:'org', :'prop', 'taxes', '2026-03-01', 1800, 'Campbell County');
-- Shared across the portfolio: one policy covering every building.
insert into expenses (organization_id, property_id, category, spent_on, amount, payee)
values (:'org', null, 'insurance', '2026-02-01', 1200, 'State Farm');
-- Last year's, which a 2026 report must leave out.
insert into expenses (organization_id, property_id, category, spent_on, amount)
values (:'org', :'prop', 'utilities', '2025-12-31', 90);

select assert(
  (select recorded_by from expenses where payee = 'Campbell County') = :'owner_member',
  'who recorded a bill is filled in by the database');

select assert_rejected(
  format('insert into expenses (organization_id, property_id, category, spent_on, amount)
          values (%L, %L, %L, %L, %s)', :'org', :'prop', 'taxes', '2026-01-01', 0),
  'a bill of nothing is refused');

select assert_rejected(
  format('insert into expenses (organization_id, property_id, category, spent_on, amount)
          values (%L, %L, %L, %L, %s)', :'org', :'prop', 'depreciation', '2026-01-01', 10),
  'depreciation is not something you enter as a bill');

select assert_rejected(
  format('insert into expenses (organization_id, property_id, category, spent_on, amount)
          values (%L, %L, %L, %L, %s)', :'org', :'prop_other', 'repairs', '2026-01-01', 10),
  'a bill cannot be filed against another landlord''s property');

-- A property manager does the books too.
select set_config('request.jwt.uid', 'e4444444-4444-4444-4444-444444444444', false);
insert into expenses (organization_id, property_id, category, spent_on, amount, payee)
values (:'org', :'prop2', 'legal_professional', '2026-04-15', 300, 'Accountant');
select assert((select count(*) from expenses) = 4,
  'a property manager sees the organization''s expenses');

-- ------------------------------------------------ who cannot see them --

select set_config('request.jwt.uid', 'e3333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from expenses) = 0, 'a technician sees no expenses');
select assert_rejected(
  format('insert into expenses (organization_id, category, spent_on, amount)
          values (%L, %L, %L, %s)', :'org', 'supplies', '2026-01-01', 10),
  'a technician cannot record an expense');
select assert_rejected(
  format('select * from expense_lines(%L, %L, %L)', :'org', '2026-01-01', '2026-12-31'),
  'a technician cannot list expenses');

select set_config('request.jwt.uid', 'e2222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from expenses) = 0, 'another landlord sees none of them');
update expenses set amount = 1 where organization_id = :'org';
delete from expenses where organization_id = :'org';
select set_config('request.jwt.uid', 'e1111111-1111-1111-1111-111111111111', false);
select assert((select sum(amount) from expenses) = 3390,
  'another landlord can neither change nor delete them');

-- Moving a bill to another organization is not possible by editing it.
update expenses set organization_id = :'org2' where payee = 'State Farm';
select assert((select organization_id from expenses where payee = 'State Farm') = :'org',
  'an expense cannot be moved to another organization');

-- ------------------------------------------------ receipts --

insert into storage.objects (bucket_id, name)
values ('expense-receipts', :'org' || '/tax-bill.pdf');
select set_config('request.jwt.uid', 'e2222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from storage.objects where bucket_id = 'expense-receipts') = 0,
  'another landlord cannot see this landlord''s receipts');
select assert_rejected(
  format('insert into storage.objects (bucket_id, name) values (%L, %L)',
         'expense-receipts', :'org' || '/planted.pdf'),
  'another landlord cannot file a receipt under this organization');
select set_config('request.jwt.uid', 'e3333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from storage.objects where bucket_id = 'expense-receipts') = 0,
  'a technician cannot see expense receipts');

-- ------------------------------------------------ the full list --

reset role;
select set_config('request.jwt.uid', 'e1111111-1111-1111-1111-111111111111', false);
update organizations set mileage_rate = 0.70 where id = :'org';
insert into maintenance_jobs (organization_id, property_id, unit_id, status)
values (:'org', :'prop', :'unit', 'completed') returning id as job \gset
insert into job_entries (job_id, technician_id, entry_type, description, cost, vendor, created_at)
values (:'job', :'owner_member', 'material', 'Tap cartridge', 40, 'Lowe''s', '2026-05-01');
insert into job_entries (job_id, technician_id, entry_type, miles, created_at)
values (:'job', :'owner_member', 'mileage', 20, '2026-05-01');
insert into job_entries (job_id, technician_id, entry_type, hours, cost, created_at)
values (:'job', :'owner_member', 'labor', 1.5, 75, '2026-05-01');
-- Hours nobody was paid for, and a note: neither is a cost.
insert into job_entries (job_id, technician_id, entry_type, hours, created_at)
values (:'job', :'owner_member', 'labor', 2, '2026-05-01');
insert into job_entries (job_id, technician_id, entry_type, description, created_at)
values (:'job', :'owner_member', 'note', 'Tenant was home', '2026-05-01');

set role authenticated;

-- 2026: 1800 tax + 1200 insurance + 300 accountant
--       + 40 parts + 75 labor (repairs) + 20 x 0.70 = 14 mileage
select assert(
  (select sum(amount) from expense_lines(:'org', '2026-01-01', '2026-12-31')) = 3429,
  'the year''s total is entered expenses plus job costs, and nothing from 2025');
select assert(
  (select count(*) from expense_lines(:'org', '2026-01-01', '2026-12-31')) = 6,
  'unpaid hours and notes are not listed as costs');
select assert(
  (select sum(amount) from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where category = 'repairs') = 115,
  'parts and paid labor count as repairs');
select assert(
  (select amount from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where category = 'auto_travel') = 14,
  'mileage counts as auto and travel at the organization''s rate');

-- One property: its own bills and jobs, not the shared policy.
select assert(
  (select sum(amount) from expense_lines(:'org', '2026-01-01', '2026-12-31', :'prop')) = 1929,
  'a property''s list leaves out shared expenses and other properties');

select set_config('request.jwt.uid', 'e2222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('select * from expense_lines(%L, %L, %L)', :'org', '2026-01-01', '2026-12-31'),
  'another landlord cannot list this landlord''s expenses');

-- With no mileage rate, miles are logged but not costed rather than free.
reset role;
update organizations set mileage_rate = null where id = :'org';
set role authenticated;
select set_config('request.jwt.uid', 'e1111111-1111-1111-1111-111111111111', false);
select assert(
  (select count(*) from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where category = 'auto_travel') = 0,
  'without a per-mile rate, mileage is left out rather than listed at $0');

reset role;
