-- Negative tests: what the database must REFUSE.
--
-- These matter more than the happy path. A missing NOT NULL or check
-- constraint doesn't announce itself — it shows up months later as a
-- lease that ended before it started, or rent billed as a negative
-- number, and by then there is data to clean up as well as a bug to fix.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset

-- ---------------------------------------------------------- properties --

select assert_rejected(
  format('insert into properties (organization_id, address_line1, city, state, zip)
          values (%L, %L, %L, %L, %L)', :'org', '1 St', 'Covington', 'KY', '41051'),
  'property requires a name');

select assert_rejected(
  format('insert into properties (organization_id, name, city, state, zip)
          values (%L, %L, %L, %L, %L)', :'org', 'H', 'Covington', 'KY', '41051'),
  'property requires an address');

select assert_rejected(
  format('insert into properties (organization_id, name, address_line1, city, state, zip)
          values (%L, %L, %L, %L, %L, %L)', :'org', 'H', '1 St', 'Covington', 'Kentucky', '41051'),
  'property state must be the 2-letter code, not the full name');

select assert_rejected(
  format('insert into properties (organization_id, name, address_line1, city, state, zip)
          values (%L, %L, %L, %L, %L, %L)', :'org', 'H', '1 St', 'Covington', 'ky', '41051'),
  'property state must be uppercase');

-- --------------------------------------------------------------- units --

select assert_rejected(
  format('insert into units (property_id) values (%L)', :'prop'),
  'unit requires a label');

select assert_rejected(
  format('insert into units (property_id, label) values (%L, %L)', :'prop', 'A'),
  'two units on one property cannot share a label');

-- -------------------------------------------------------------- leases --

select assert_rejected(
  format('insert into leases (start_date, rent_amount, rent_due_day)
          values (%L, 1200, 1)', '2026-01-01'),
  'lease requires a unit');

select assert_rejected(
  format('insert into leases (unit_id, rent_amount, rent_due_day)
          values (%L, 1200, 1)', :'unit'),
  'lease requires a start date');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_due_day)
          values (%L, %L, 1)', :'unit', '2026-01-01'),
  'lease requires a rent amount');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount)
          values (%L, %L, 1200)', :'unit', '2026-01-01'),
  'lease requires a rent due day');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day)
          values (%L, %L, 0, 1)', :'unit', '2026-01-01'),
  'rent must be greater than zero');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day)
          values (%L, %L, -500, 1)', :'unit', '2026-01-01'),
  'rent cannot be negative');

-- 29-31 are excluded because they do not exist in every month; a lease due
-- on the 31st would skip February entirely.
select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day)
          values (%L, %L, 1200, 0)', :'unit', '2026-01-01'),
  'rent due day 0 is not a day');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day)
          values (%L, %L, 1200, 31)', :'unit', '2026-01-01'),
  'rent due day 31 does not exist in every month');

select assert_rejected(
  format('insert into leases (unit_id, start_date, end_date, rent_amount, rent_due_day)
          values (%L, %L, %L, 1200, 1)', :'unit', '2026-06-01', '2026-01-01'),
  'lease cannot end before it starts');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, deposit_amount)
          values (%L, %L, 1200, 1, -100)', :'unit', '2026-01-01'),
  'deposit cannot be negative');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, pet_rent_amount)
          values (%L, %L, 1200, 1, -25)', :'unit', '2026-01-01'),
  'pet rent cannot be negative');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, prorated_rent_amount)
          values (%L, %L, 1200, 1, -270)', :'unit', '2026-01-01'),
  'prorated rent cannot be negative');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
          values (%L, %L, 1200, 1, %L)', :'unit', '2026-01-01', 'whatever'),
  'lease status must be one of the known values');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, fee_payer)
          values (%L, %L, 1200, 1, %L)', :'unit', '2026-01-01', 'somebody_else'),
  'fee payer must be landlord or tenant');

-- A daily fee with no start day accrues from an undefined point; a start
-- day with no amount is a rule that charges nothing. Both are
-- half-configured.
select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                              late_fee_daily_amount)
          values (%L, %L, 1200, 1, 5)', :'unit', '2026-01-01'),
  'daily late fee without a start day is half-configured');

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                              late_fee_daily_start_days)
          values (%L, %L, 1200, 1, 6)', :'unit', '2026-01-01'),
  'daily late fee start day without an amount is half-configured');

-- -------------------------------------------------------- rent charges --

insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select assert_rejected(
  format('insert into rent_charges (lease_id, charge_type, due_date, amount)
          values (%L, %L, %L, 100)', :'lease', 'nonsense', '2026-01-01'),
  'charge type must be one of the known values');

select assert_rejected(
  format('insert into rent_charges (lease_id, due_date, amount) values (%L, %L, -50)',
         :'lease', '2026-01-01'),
  'a charge cannot be for a negative amount');

select assert_rejected(
  format('insert into rent_charges (lease_id, due_date, amount, amount_paid)
          values (%L, %L, 100, 150)', :'lease', '2026-01-01'),
  'more cannot be paid against a charge than the charge is for');

-- ------------------------------------------------------------ payments --

select assert_rejected(
  format('insert into payments (lease_id, tenant_member_id, amount, processing_fee_amount,
                                total_charged, method)
          values (%L, (select id from org_members limit 1), 1200, 5, 1200, %L)',
         :'lease', 'ach'),
  'total charged must equal rent plus the processing fee');

select assert_rejected(
  format('insert into payments (lease_id, tenant_member_id, amount, total_charged, method)
          values (%L, (select id from org_members limit 1), 1200, 1200, %L)',
         :'lease', 'carrier_pigeon'),
  'payment method must be one of the known values');

select assert('true', 'required-field tests completed');
