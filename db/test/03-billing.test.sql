-- Rent billing: generation, late fee accrual, and move-in charges.
-- Covers the behaviour verified by hand when each was built, so a future
-- change that breaks it fails here instead of in someone's rent.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit_a \gset
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset
insert into units (property_id, label) values (:'prop', 'C') returning id as unit_c \gset

-- ------------------------------------------------- move-in charges --

-- Chris's real terms: $1200 rent, $1200 deposit, $270 prorated,
-- $25 late fee after 5 days plus $5/day from day 6.
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status,
                    deposit_amount, prorated_rent_amount,
                    late_fee_auto_apply, late_fee_type, late_fee_amount,
                    late_fee_grace_days, late_fee_daily_amount, late_fee_daily_start_days)
values (:'unit_a', '2026-01-01', 1200, 1, 'active', 1200, 270,
        true, 'flat', 25, 5, 5, 6)
returning id as lease_a \gset

select assert(
  (select count(*) from rent_charges where lease_id = :'lease_a'
     and charge_type = 'security_deposit') = 1,
  'activating a lease bills the security deposit');
select assert(
  (select amount from rent_charges where lease_id = :'lease_a'
     and charge_type = 'prorated_rent') = 270,
  'activating a lease bills the prorated rent');

-- Editing a lease must not re-bill move-in money already owed.
update leases set rent_amount = 1250 where id = :'lease_a';
update leases set status = 'active' where id = :'lease_a';
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_a'
     and charge_type = 'security_deposit') = 1,
  'editing a lease does not re-bill the deposit');

-- A lease not yet started bills nothing.
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status, deposit_amount)
values (:'unit_b', '2026-01-01', 900, 1, 'pending', 900) returning id as lease_b \gset
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_b') = 0,
  'a pending lease bills nothing');
update leases set status = 'active' where id = :'lease_b';
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_b') = 1,
  'activating it bills the deposit');

-- ------------------------------------------------ rent generation --

select assert(generate_rent_charges() >= 2, 'active leases generate rent charges');
select assert(generate_rent_charges() = 0, 'running billing twice does not double-bill');

-- Changing the due day mid-month must not bill the month again: deduping
-- on the exact due date rather than the month caused exactly that, and
-- charged a tenant twice.
update leases set rent_due_day = 15 where id = :'lease_a';
select assert(generate_rent_charges() = 0,
  'moving the rent due day mid-month does not re-bill that month');
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_a' and charge_type = 'rent') = 1,
  'still exactly one rent charge for the month');

-- An ended lease stops being billed.
insert into leases (unit_id, start_date, end_date, rent_amount, rent_due_day, status)
values (:'unit_c', '2025-01-01', '2025-06-30', 800, 1, 'ended') returning id as lease_c \gset
select generate_rent_charges();
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_c' and charge_type = 'rent') = 0,
  'an ended lease is not billed');

-- Pet rent is folded into the rent charge rather than billed separately,
-- so the tenant sees one figure matching the lease.
insert into units (property_id, label) values (:'prop', 'D') returning id as unit_d \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status,
                    pets_allowed, pet_rent_amount)
values (:'unit_d', '2026-01-01', 1000, 1, 'active', true, 25) returning id as lease_d \gset
select generate_rent_charges();
select assert(
  (select amount from rent_charges where lease_id = :'lease_d' and charge_type = 'rent') = 1025,
  'pet rent is added into the monthly rent charge');

-- ---------------------------------------------------- late fees --

-- Backdate lease A's rent charge to 10 days overdue: $25 initial plus
-- $5/day from day 6 = 25 + 5*5 = $50.
update rent_charges set due_date = current_date - 10
 where lease_id = :'lease_a' and charge_type = 'rent';
select apply_late_fees();
select assert(
  (select amount from rent_charges where parent_charge_id in
     (select id from rent_charges where lease_id = :'lease_a' and charge_type = 'rent')) = 50,
  'ten days late: $25 initial + 5 days at $5 = $50, got '
  || coalesce((select amount::text from rent_charges where charge_type = 'late_fee'
                and lease_id = :'lease_a'), 'none'));

-- Re-running revises one row rather than adding another per day.
select apply_late_fees();
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_a'
     and charge_type = 'late_fee') = 1,
  'late fees never produce a second row for the same charge');

-- Within the grace period, nothing is charged.
update rent_charges set due_date = current_date - 2
 where lease_id = :'lease_a' and charge_type = 'rent';
delete from rent_charges where charge_type = 'late_fee';
select apply_late_fees();
select assert(
  (select count(*) from rent_charges where charge_type = 'late_fee') = 0,
  'no late fee inside the grace period');

-- A lease that did not opt in is never charged one.
update rent_charges set due_date = current_date - 30
 where lease_id = :'lease_b' and charge_type = 'rent';
select apply_late_fees();
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_b'
     and charge_type = 'late_fee') = 0,
  'a lease without auto late fees is never charged one');

-- ------------------------------------------------- overdue status --

-- A part-paid charge keeps 'partial' rather than being flattened to
-- 'late': how much is outstanding is more useful than the calendar, which
-- the due date already records.
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_b', 'other', current_date - 5, 500, 200, 'partial')
returning id as partial_charge \gset
select mark_overdue_charges();
select assert(
  (select status from rent_charges where id = :'partial_charge') = 'partial',
  'a partly paid charge is not overwritten to late');

select assert(true, 'billing tests completed');
