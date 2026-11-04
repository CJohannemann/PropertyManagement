-- Year-end finances (037): income sorted into income and deposits held,
-- vendors and their 1099 totals, depreciation inputs kept private, and
-- expenses counted in the Rent tab's net.

insert into auth.users (id, email) values
  ('f1111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('f2222222-2222-2222-2222-222222222222', 'other@example.com'),
  ('f3333333-3333-3333-3333-333333333333', 'tenant@example.com'),
  ('f4444444-4444-4444-4444-444444444444', 'tech@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('other@example.com');

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select create_organization('Owner Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Central', '807', 'Newport', 'KY', '41071') returning id as prop \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Forrest', '12', 'Newport', 'KY', '41071') returning id as prop2 \gset
insert into units (property_id, label) values (:'prop', '1') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'Denia') \gset
select set_config('request.jwt.uid', 'f3333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select token as tech_token from create_invite('tech@example.com', 'technician', null, 'Tech') \gset
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select accept_invite(:'tech_token');
select id as tech_member from org_members
 where user_id = 'f4444444-4444-4444-4444-444444444444' \gset

select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select create_organization('Other Org') as org2 \gset

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);

-- ============================================================== income ==

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-02-01', 1200) returning id as rent_feb \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'late_fee', '2026-02-06', 50) returning id as late \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'security_deposit', '2026-01-01', 1200) returning id as dep \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-03-01', 1200) returning id as rent_mar \gset

select record_manual_payment(:'rent_feb', 1200, 'check', '2026-02-03');
select record_manual_payment(:'late', 50, 'cash', '2026-02-10');
select record_manual_payment(:'dep', 1200, 'check', '2026-01-01');
-- Paid in December for January: cash basis counts it in the year it came.
select record_manual_payment(:'rent_mar', 600, 'check', '2025-12-30');
select record_manual_payment(:'rent_mar', 600, 'check', '2026-03-01') as voided \gset
select void_manual_payment(:'voided');

insert into deposit_deductions (lease_id, description, amount, applied_to_balance)
values (:'lease', 'Carpet cleaning', 150, false),
       (:'lease', 'Applied to unpaid rent and fees', 300, true);

set role authenticated;

select assert(
  (select sum(amount) from income_lines(:'org', '2026-01-01', '2026-12-31')
    where kind = 'rent') = 1200,
  'rent counts once, in the year it arrived, and a voided payment not at all');
select assert(
  (select sum(amount) from income_lines(:'org', '2026-01-01', '2026-12-31')
    where kind = 'fees') = 50,
  'a late fee is income');
select assert(
  (select sum(amount) from income_lines(:'org', '2026-01-01', '2026-12-31')
    where kind = 'deposit_received') = 1200,
  'a deposit paid in is listed as held, not income');
select assert(
  (select sum(amount) from income_lines(:'org', '2026-01-01', '2026-12-31')
    where kind = 'deposit_kept') = 150,
  'deposit kept for damage is income; deposit applied to rent is not counted twice');
select assert(
  (select sum(amount) from income_lines(:'org', '2025-01-01', '2025-12-31')) = 600,
  'December''s early payment is in December''s year');
select assert(
  (select tenant_name from income_lines(:'org', '2026-01-01', '2026-12-31')
    where kind = 'rent' limit 1) = 'Denia',
  'income says who paid');
select assert(
  (select count(*) from income_lines(:'org', '2026-01-01', '2026-12-31', :'prop2')) = 0,
  'a property''s income is only its own');

select set_config('request.jwt.uid', 'f3333333-3333-3333-3333-333333333333', false);
select assert_rejected(
  format('select * from income_lines(%L, %L, %L)', :'org', '2026-01-01', '2026-12-31'),
  'a tenant cannot read the landlord''s income');
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('select * from income_lines(%L, %L, %L)', :'org', '2026-01-01', '2026-12-31'),
  'another landlord cannot read it either');

-- ============================================================= vendors ==

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
insert into vendors (organization_id, name, tin_last4, member_id)
values (:'org', 'Tech', '1234', :'tech_member') returning id as v_tech \gset
insert into vendors (organization_id, name, business_name)
values (:'org', 'Joe', 'Joe''s Plumbing') returning id as v_plumber \gset

select assert_rejected(
  format('insert into vendors (organization_id, name, tin_last4) values (%L, %L, %L)',
         :'org', 'Bad', '123-45-6789'),
  'only the last four digits of a tax id are kept');

insert into expenses (organization_id, property_id, category, spent_on, amount, vendor_id, paid_by)
values (:'org', :'prop', 'repairs', '2026-04-01', 1500, :'v_plumber', 'check'),
       (:'org', :'prop', 'repairs', '2026-05-01', 900, :'v_plumber', 'card'),
       (:'org', :'prop', 'supplies', '2026-05-02', 300, :'v_plumber', 'check'),
       (:'org', :'prop', 'repairs', '2025-06-01', 5000, :'v_plumber', 'check');

reset role;
insert into maintenance_jobs (organization_id, property_id, unit_id, status)
values (:'org', :'prop', :'unit', 'completed') returning id as job \gset
insert into job_entries (job_id, technician_id, entry_type, hours, cost, created_at)
values (:'job', :'tech_member', 'labor', 10, 2200, '2026-06-01'),
       (:'job', :'tech_member', 'material', null, 400, '2026-06-01');
set role authenticated;

select assert(
  (select reportable from vendor_totals(:'org', 2026) where vendor_id = :'v_plumber') = 1500,
  'card payments, supplies and other years are left out of a vendor''s 1099 total');
select assert(
  (select card_payments from vendor_totals(:'org', 2026) where vendor_id = :'v_plumber') = 900,
  'card payments are shown separately');
select assert(
  (select reportable from vendor_totals(:'org', 2026) where vendor_id = :'v_tech') = 2200,
  'a technician''s paid labor counts toward their total; materials they bought do not');
select assert(
  (select name from vendor_totals(:'org', 2026) where vendor_id = :'v_plumber') = 'Joe''s Plumbing',
  'a vendor is listed under their business name');

-- Another organization's vendor cannot be put on this organization's bill.
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
insert into vendors (organization_id, name) values (:'org2', 'Theirs') returning id as v_other \gset
select assert((select count(*) from vendors) = 1, 'another landlord sees only their own vendors');
select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
select assert_rejected(
  format('insert into expenses (organization_id, category, spent_on, amount, vendor_id)
          values (%L, %L, %L, %s, %L)', :'org', 'repairs', '2026-01-01', 10, :'v_other'),
  'a bill cannot name another organization''s vendor');

select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select assert((select count(*) from vendors) = 0, 'a technician cannot see the vendor list');

-- ======================================================== depreciation ==

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
insert into property_financials (property_id, purchase_price, land_value, placed_in_service)
values (:'prop', 250000, 50000, '2024-03-15');
insert into capital_improvements (property_id, description, cost, placed_in_service, recovery_years)
values (:'prop', 'New roof', 12000, '2026-07-01', 27.5);

select assert_rejected(
  format('insert into capital_improvements (property_id, description, cost, placed_in_service, recovery_years)
          values (%L, %L, %s, %L, %s)', :'prop', 'Odd', 100, '2026-01-01', 10),
  'only IRS recovery periods are accepted');

select set_config('request.jwt.uid', 'f3333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from property_financials) = 0,
  'a tenant cannot see what the building cost');
select assert((select count(*) from capital_improvements) = 0,
  'or what was spent improving it');
select set_config('request.jwt.uid', 'f4444444-4444-4444-4444-444444444444', false);
select assert((select count(*) from property_financials) = 0,
  'nor can a technician');
select set_config('request.jwt.uid', 'f2222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from property_financials) = 0,
  'nor another landlord');

-- ================================================= net includes bills ==

select set_config('request.jwt.uid', 'f1111111-1111-1111-1111-111111111111', false);
-- 2026 at Central: 1500 + 900 + 300 entered, 2200 + 400 from the job.
select assert(
  (select spent from rent_totals(:'org', '2026-01-01', '2026-12-31', :'prop')) = 5300,
  'rent totals count entered expenses as well as repair jobs');
insert into expenses (organization_id, property_id, category, spent_on, amount)
values (:'org', null, 'insurance', '2026-02-01', 700);
select assert(
  (select spent from rent_totals(:'org', '2026-01-01', '2026-12-31')) = 6000,
  'shared bills count toward the whole portfolio');
select assert(
  (select spent from rent_totals(:'org', '2026-01-01', '2026-12-31', :'prop')) = 5300,
  'but not toward one property');

select assert(
  (select payee from expense_lines(:'org', '2026-04-01', '2026-04-01')) = 'Joe''s Plumbing',
  'the expense list names the vendor when no payee was typed');

reset role;
