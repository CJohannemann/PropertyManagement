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

-- 40 parts + (20 x 0.70) mileage + 75 labor = 129
select assert(
  (select spent from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 129,
  'spend counts parts, mileage at the org rate, and the labor invoice, got '
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

-- ------------------------------------------------ the dashboard summary --

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);
select dashboard_summary(:'org_a') as dash \gset

-- Occupancy comes from active leases, never from units.status — nothing has
-- ever written that column, so it says 'vacant' for every unit ever created
-- however many tenants are in it.
select assert((:'dash'::jsonb #>> '{portfolio,units}')::int = 1,
  'the portfolio counts its units');
select assert((:'dash'::jsonb #>> '{portfolio,occupied}')::int = 1,
  'a unit with an active lease counts as occupied, got '
  || (:'dash'::jsonb #>> '{portfolio,occupied}'));
select assert((:'dash'::jsonb #>> '{portfolio,vacant}')::int = 0,
  'and not also as vacant');
select assert((:'dash'::jsonb #>> '{portfolio,monthly_rent}')::numeric = 1000,
  'monthly rent sums the active leases');

-- Landlord B's 5000 lease must not appear anywhere in A's dashboard.
select assert((:'dash'::jsonb #>> '{portfolio,properties}')::int = 1,
  'the dashboard sees only this organization''s properties');

-- Two charges are past due (this month's is due on the 1st, plus the two
-- older ones); the summary counts what is actually late.
select assert((:'dash'::jsonb #>> '{rent,overdue}')::numeric > 0,
  'overdue rent is reported');
select assert(
  (:'dash'::jsonb #>> '{rent,outstanding}')::numeric
    >= (:'dash'::jsonb #>> '{rent,overdue}')::numeric,
  'outstanding is never less than the overdue part of it');

-- The repair logged earlier is complete, so nothing is open.
select assert((:'dash'::jsonb #>> '{maintenance,open}')::int = 0,
  'no open requests when none were made');
select assert((:'dash'::jsonb -> 'top_request') is null
              or (:'dash'::jsonb ->> 'top_request') is null,
  'and no request is singled out');

-- A real one, urgent, to prove it surfaces.
insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
values (:'unit_a', :'member_a', 'plumbing', 'No hot water', 'urgent');
select dashboard_summary(:'org_a') as dash2 \gset

select assert((:'dash2'::jsonb #>> '{maintenance,open}')::int = 1,
  'an open request is counted');
select assert((:'dash2'::jsonb #>> '{maintenance,urgent}')::int = 1,
  'and counted as urgent');
select assert((:'dash2'::jsonb #>> '{top_request,description}') = 'No hot water',
  'the most urgent request is named, not just counted');
select assert((:'dash2'::jsonb #>> '{properties,0,urgent_maintenance}')::int = 1,
  'and attributed to its property');

-- A lease ending inside the notice window should be flagged; one ending
-- next year should not.
update leases set end_date = current_date + 30 where id = :'lease_a';
select dashboard_summary(:'org_a') as dash3 \gset
select assert(jsonb_array_length(:'dash3'::jsonb -> 'expiring_leases') = 1,
  'a lease ending within 60 days is flagged');

update leases set end_date = current_date + 400 where id = :'lease_a';
select dashboard_summary(:'org_a') as dash4 \gset
select assert(jsonb_array_length(:'dash4'::jsonb -> 'expiring_leases') = 0,
  'a lease ending next year is not');

-- ----------------------------------------------- and the boundary again --

select assert_rejected(
  format('select dashboard_summary(%L)', :'org_b'),
  'a landlord cannot open another organization''s dashboard');

select set_config('request.jwt.uid', 'cccccccc-0000-0000-0000-00000000c001', false);
select assert_rejected(
  format('select dashboard_summary(%L)', :'org_a'),
  'someone with no membership cannot open a dashboard at all');

select assert(true, 'analytics tests completed');

-- ---------------------------------------------- filtering by property --

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);

-- A second building for landlord A, with its own rent.
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_a', 'A Cottage', '2 A St', 'Covington', 'KY', '41051') returning id as prop_a2 \gset
insert into units (property_id, label) values (:'prop_a2', 'C1') returning id as unit_a2 \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a2', '2026-01-01', 700, 1, 'active') returning id as lease_a2 \gset
insert into rent_charges (lease_id, charge_type, due_date, amount, amount_paid, status)
values (:'lease_a2', 'rent', date_trunc('month', current_date)::date, 700, 700, 'paid');

-- Unfiltered, both buildings count.
select assert(
  (select billed from rent_summary(:'org_a', 12)
    where month = date_trunc('month', current_date)::date) = 1700,
  'unfiltered totals cover every building, got '
  || (select billed::text from rent_summary(:'org_a', 12)
       where month = date_trunc('month', current_date)::date));

-- Filtered, only the one asked for.
select assert(
  (select billed from rent_summary(:'org_a', 12, :'prop_a2')
    where month = date_trunc('month', current_date)::date) = 700,
  'filtering to a building reports only its rent, got '
  || (select billed::text from rent_summary(:'org_a', 12, :'prop_a2')
       where month = date_trunc('month', current_date)::date));
select assert(
  (select collected from rent_summary(:'org_a', 12, :'prop_a2')
    where month = date_trunc('month', current_date)::date) = 700,
  'and only its collections');

-- The original building is unaffected by the new one existing.
select assert(
  (select billed from rent_summary(:'org_a', 12, :'prop_a')
    where month = date_trunc('month', current_date)::date) = 1000,
  'the other building still reports its own');

-- The repair logged earlier was on the first property, so a filter to the
-- second must not pick up its cost.
select assert(
  (select spent from rent_summary(:'org_a', 12, :'prop_a2')
    where month = date_trunc('month', current_date)::date) = 0,
  'spend is filtered too, got '
  || (select spent::text from rent_summary(:'org_a', 12, :'prop_a2')
       where month = date_trunc('month', current_date)::date));
select assert(
  (select spent from rent_summary(:'org_a', 12, :'prop_a')
    where month = date_trunc('month', current_date)::date) = 129,
  'and the building that had the repair keeps it');

-- Asking about someone else's building is refused rather than answered
-- with zeros, which would read as "that building earns nothing".
select assert_rejected(
  format('select * from rent_summary(%L, 12, %L)', :'org_a', :'prop_b'),
  'a property from another organization is refused');

select assert(true, 'filter tests completed');

-- ------------------------------------------- the financial snapshot --
--
-- "Expected" must mean what the leases say is due, not what the billing job
-- has got round to writing. Rent is generated by a scheduled job; between
-- the 1st of a month and that job running, no charge rows exist yet, and
-- the figure this replaces reported $0 expected while every lease in the
-- building said otherwise.

select set_config('request.jwt.uid', 'aaaaaaaa-0000-0000-0000-00000000a001', false);

select date_trunc('month', current_date)::date as m_start \gset
select (date_trunc('month', current_date) + interval '1 month' - interval '1 day')::date
  as m_end \gset

-- As things stand: A House billed 1000 (400 paid), A Cottage billed 700
-- (700 paid). Both have charges, so expected equals billed.
select assert(
  (select billed from rent_totals(:'org_a', :'m_start', :'m_end')) = 1700,
  'billed is what was actually charged, got '
  || (select billed::text from rent_totals(:'org_a', :'m_start', :'m_end')));
select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end')) = 1700,
  'and expected matches it while every lease has been billed');
select assert(
  (select collected from rent_totals(:'org_a', :'m_start', :'m_end')) = 1100,
  'collected is what came in');
select assert(
  (select outstanding from rent_totals(:'org_a', :'m_start', :'m_end')) = 600,
  'and outstanding is the difference');

-- Now a lease that is running but has NOT been billed this month — the
-- state a landlord is in on the 1st, before the job runs.
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org_a', 'A Unbilled', '3 A St', 'Covington', 'KY', '41051')
returning id as prop_a3 \gset
insert into units (property_id, label) values (:'prop_a3', 'U1') returning id as unit_a3 \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a3', '2026-01-01', 850, 1, 'active') returning id as lease_a3 \gset

select assert(
  (select billed from rent_totals(:'org_a', :'m_start', :'m_end')) = 1700,
  'an unbilled lease adds nothing to billed — nothing was charged');
select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end')) = 2550,
  'but it IS expected, because the lease says so, got '
  || (select expected::text from rent_totals(:'org_a', :'m_start', :'m_end')));
select assert(
  (select outstanding from rent_totals(:'org_a', :'m_start', :'m_end')) = 1450,
  'and it is owed, got '
  || (select outstanding::text from rent_totals(:'org_a', :'m_start', :'m_end')));

-- Once billed, it must not be counted twice.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a3', 'rent', :'m_start', 850);
select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end')) = 2550,
  'billing it changes nothing — expected already included it, got '
  || (select expected::text from rent_totals(:'org_a', :'m_start', :'m_end')));
select assert(
  (select billed from rent_totals(:'org_a', :'m_start', :'m_end')) = 2550,
  'and now billed has caught up with expected');

-- A lease billed a PRORATED amount must be trusted over its rent_amount:
-- a tenancy starting mid-month owes less than a full month, and the charge
-- is the truthful figure.
insert into units (property_id, label) values (:'prop_a3', 'U2') returning id as unit_a4 \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_a4', :'m_start', 900, 1, 'active') returning id as lease_a4 \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a4', 'prorated_rent', :'m_start', 450);

select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end')) = 3000,
  'a prorated charge counts as 450, not the lease''s 900, got '
  || (select expected::text from rent_totals(:'org_a', :'m_start', :'m_end')));

-- A late fee is money owed and belongs in billed, but must not make the
-- rent look "already billed" for the unbilled check.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a', 'late_fee', :'m_start', 50);
select assert(
  (select billed from rent_totals(:'org_a', :'m_start', :'m_end')) = 3050,
  'late fees count towards billed');

-- An ended lease is not expected, however recently it ended.
update leases set status = 'ended' where id = :'lease_a3';
select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end')) = 3050,
  'an ended lease stops being expected but its charge still stands');
update leases set status = 'active' where id = :'lease_a3';

-- ------------------------------------------------- ranges and limits --

select assert(
  (select expected from rent_totals(:'org_a', :'m_start', :'m_end', :'prop_a3')) = 1300,
  'filtering to one building covers only its leases, got '
  || (select expected::text from rent_totals(:'org_a', :'m_start', :'m_end', :'prop_a3')));

select assert_rejected(
  format('select * from rent_totals(%L, %L, %L)', :'org_a', :'m_end', :'m_start'),
  'a range that runs backwards is refused');
select assert_rejected(
  format('select * from rent_totals(%L, %L, %L)', :'org_a', '1990-01-01', :'m_end'),
  'an absurdly long range is refused rather than scanned');
select assert_rejected(
  format('select * from rent_totals(%L, %L, %L)', :'org_b', :'m_start', :'m_end'),
  'and one landlord cannot read another''s snapshot');

select assert(true, 'snapshot tests completed');
