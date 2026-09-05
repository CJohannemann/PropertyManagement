-- Rent totals by month.
--
-- These numbers are what a landlord reads to decide how the business is
-- doing, so the arithmetic is asserted rather than eyeballed — and so is
-- the boundary, because a function that returns money must never return
-- somebody else's.

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000a001', 'landlord.a@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000b001', 'landlord.b@example.com'),
  ('cccccccc-0000-0000-0000-00000000c001', 'tenant.a@example.com');
insert into org_creation_allowlist (email)
values ('landlord.a@example.com'), ('landlord.b@example.com');

-- Landlord A, with a unit and some billing history.
select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);
select create_organization('Landlord A') as org_a \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_a', 'A House', '1 A St', 'Covington', 'KY', '41051') returning id as prop_a \gset
insert into units (property_id, label) values (:'prop_a', 'A1') returning id as unit_a \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a', '2026-01-01', 1000, 1, 'active') returning id as lease_a \gset

-- Landlord B, entirely separate.
select set_config('request.jwt.uid', 'bbbbbbbb-0000-0000-0000-00000000b001', false);
select create_organization('Landlord B') as org_b \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_b', 'B House', '1 B St', 'Newport', 'KY', '41071') returning id as prop_b \gset
insert into units (property_id, label) values (:'prop_b', 'B1') returning id as unit_b \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', '2026-01-01', 5000, 1, 'active') returning id as lease_b \gset

-- ------------------------------------------------ what the months hold --

-- This month: 1000 billed, 400 of it paid.
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_a', 'rent', date_trunc('month', current_date)::date, 1000, 400, 'partial');

-- Last month: 1000 billed, settled in full.
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_a', 'rent',
        (date_trunc('month', current_date) - interval '1 month')::date, 1000, 1000, 'paid');

-- Two months back: 1000 billed, nothing paid, plus a 50 late fee.
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_a', 'rent',
        (date_trunc('month', current_date) - interval '2 months')::date, 1000, 0, 'late'),
       (:'lease_a', 'late_fee',
        (date_trunc('month', current_date) - interval '2 months')::date, 50, 0, 'late');

-- Landlord B's rent, which must never appear in A's totals.
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_b', 'rent', date_trunc('month', current_date)::date, 5000, 5000, 'paid');

-- ------------------------------------------------------- the totals --

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);

select assert((select count(*) from rent_summary(:'org_a', 12)) = 12,
  'a 12-month window returns 12 rows even where nothing was billed');

select assert(
  (select billed from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 1000,
  'this month bills what was charged');
select assert(
  (select collected from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 400,
  'and collects only what was paid');
select assert(
  (select outstanding from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 600,
  'leaving the remainder outstanding');

-- A late fee is money billed like any other charge, so it belongs in the
-- month's total rather than being quietly excluded.
select assert(
  (select billed from rent_summary(:'org_a', 12)
    where month = (date_trunc('month', current_date) - interval '2 months')::date) = 1050,
  'rent and late fees both count as billed, got '
  || (select billed::text from rent_summary(:'org_a', 12)
       where month = (date_trunc('month', current_date) - interval '2 months')::date));

select assert(
  (select collected from rent_summary(:'org_a', 12)
    where month = (date_trunc('month', current_date) - interval '1 month')::date) = 1000,
  'a fully settled month collects everything it billed');

-- A month nobody was billed in reads as zero, not as a missing row.
select assert(
  (select billed from rent_summary(:'org_a', 12)
    where month = (date_trunc('month', current_date) - interval '6 months')::date) = 0,
  'a quiet month is zero rather than absent');

-- ------------------------------------------- one landlord, one ledger --

select assert((select sum(billed) from rent_summary(:'org_a', 12)) = 3050,
  'the window totals only this organization''s charges, got '
  || (select coalesce(sum(billed), 0)::text from rent_summary(:'org_a', 12)));

-- The check that matters most: landlord B's 5000 is nowhere in A's
-- figures, and A cannot ask for B's.
select assert_rejected(
  format('select * from rent_summary(%L, 12)', :'org_b'),
  'a landlord cannot read another organization''s rent totals');

-- A tenant of the organization is not a manager of it.
select set_config('request.jwt.uid', 'cccccccc-0000-0000-0000-00000000c001', false);
select assert_rejected(
  format('select * from rent_summary(%L, 12)', :'org_a'),
  'someone with no membership cannot read rent totals');

-- ------------------------------------------------ maintenance spend --

-- The other half of "how is the business doing". A leaky tap: a $40 part,
-- 20 miles, and a $75 invoice from the technician who fitted it.

-- Back to landlord A: the block above left the session acting as a tenant
-- to prove they are refused.
select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);

update organizations set mileage_rate = 0.70 where id = :'org_a';

insert into maintenance_jobs (organization_id, property_id, unit_id, status)
values (:'org_a', :'prop_a', :'unit_a', 'completed') returning id as job_a \gset
select id as member_a from org_members
 where user_id = 'aaaaaaaa-0000-0000-0000-00000000a001' \gset

insert into job_entries (job_id, technician_id, entry_type, description, cost)
values (:'job_a', :'member_a', 'material', 'Tap cartridge', 40);
insert into job_entries (job_id, technician_id, entry_type, description, miles)
values (:'job_a', :'member_a', 'mileage', 'Trip for the part', 20);
-- The case the form could not previously record: hours worked AND what the
-- technician charged for them.
insert into job_entries (job_id, technician_id, entry_type, description, hours, cost)
values (:'job_a', :'member_a', 'labor', 'Fitted the tap', 1.5, 75);

-- 40 parts + (20 x 0.70) mileage + 75 labour = 129
select assert(
  (select spent from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 129,
  'spend counts parts, mileage at the org rate, and the labour invoice, got '
  || (select spent::text from rent_summary(:'org_a', 12)
       where month = date_trunc('month', current_date)::date));

-- The roll-up must agree with the job's own total, or two screens in this
-- app would quote different figures for the same repair.
select assert((select total_cost from job_totals(:'job_a')) = 129,
  'and matches what the job itself reports');

-- Hours with no cost are worked, not owed. Pricing them at an invented
-- rate would produce a net figure that looks authoritative and is wrong.
insert into job_entries (job_id, technician_id, entry_type, description, hours)
values (:'job_a', :'member_a', 'labor', 'My own time', 3);
select assert(
  (select spent from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 129,
  'unpaid hours add nothing to spend');

-- Charges and job entries are summed separately before being joined; done
-- in one pass each charge would be multiplied by the number of entries
-- that month, inflating both sides.
select assert(
  (select billed from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 1000,
  'billing is not multiplied by the number of job entries, got '
  || (select billed::text from rent_summary(:'org_a', 12)
       where month = date_trunc('month', current_date)::date));

select assert(
  (select spent from rent_summary(:'org_a', 12)
    where month = (date_trunc('month', current_date) - interval '4 months')::date) = 0,
  'a month with no repairs spent nothing');

-- ---------------------------------------------------- the window size --

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);
select assert((select count(*) from rent_summary(:'org_a', 1)) = 1,
  'a one-month window returns one row');
select assert_rejected(
  format('select * from rent_summary(%L, 0)', :'org_a'),
  'a window of no months is refused');
select assert_rejected(
  format('select * from rent_summary(%L, 500)', :'org_a'),
  'an absurd window is refused rather than scanned');

select assert(true, 'analytics tests completed');
