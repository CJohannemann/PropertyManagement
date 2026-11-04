-- The five fixes in 038: selling a property, partial refunds, mileage
-- rates per year, dates near midnight, and closing a year.

insert into auth.users (id, email) values
  ('a5111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('a5222222-2222-2222-2222-222222222222', 'pm@example.com'),
  ('a5333333-3333-3333-3333-333333333333', 'tenant@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
select create_organization('Owner Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Central', '807', 'Newport', 'KY', '41071') returning id as prop \gset
insert into units (property_id, label) values (:'prop', '1') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset
select token from create_invite('tenant@example.com', 'tenant', :'lease', 'Denia') \gset
select token as pm_token from create_invite('pm@example.com', 'property_manager', null, 'PM') \gset
select set_config('request.jwt.uid', 'a5333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'a5222222-2222-2222-2222-222222222222', false);
select accept_invite(:'pm_token');
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
select id as tenant_member from org_members
 where user_id = 'a5333333-3333-3333-3333-333333333333' \gset
select id as owner_member from org_members
 where user_id = 'a5111111-1111-1111-1111-111111111111' \gset

-- ====================================================== dates near midnight ==

update organizations set timezone = 'America/New_York' where id = :'org';
select assert_rejected(
  format('update organizations set timezone = %L where id = %L', 'Mars/Olympus', :'org'),
  'an unknown time zone is refused when it is saved');

insert into maintenance_jobs (organization_id, property_id, unit_id, status)
values (:'org', :'prop', :'unit', 'completed') returning id as job \gset
-- 9:30pm on December 31 in Kentucky is 02:30 UTC on January 1.
insert into job_entries (job_id, technician_id, entry_type, cost, created_at)
values (:'job', :'owner_member', 'material', 80, '2026-01-01 02:30:00+00');
select assert(
  (select spent_on from expense_lines(:'org', '2025-01-01', '2026-12-31')
    where amount = 80) = '2025-12-31',
  'a repair logged on New Year''s Eve evening is in the old year, where it was spent');

-- A check recorded for December 31 stays on December 31.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-01-01', 1200) returning id as jan \gset
select record_manual_payment(:'jan', 1200, 'check', '2025-12-31') as check_pay \gset
select assert(
  (select received_on from income_lines(:'org', '2025-01-01', '2026-12-31')
    where id = :'check_pay') = '2025-12-31',
  'a hand-recorded payment keeps the day it was recorded for');

-- ========================================================= mileage per year ==

insert into mileage_rates (organization_id, year, rate) values (:'org', 2025, 0.70);
insert into job_entries (job_id, technician_id, entry_type, miles, created_at)
values (:'job', :'owner_member', 'mileage', 100, '2025-06-01 15:00:00+00'),
       (:'job', :'owner_member', 'mileage', 100, '2026-06-01 15:00:00+00');
select assert(
  (select sum(amount) from expense_lines(:'org', '2025-01-01', '2026-12-31')
    where category = 'auto_travel') = 140,
  'a year with no rate of its own uses the latest earlier year''s');
-- Setting next year's rate changes next year, not last year.
insert into mileage_rates (organization_id, year, rate) values (:'org', 2026, 0.725);
select assert(
  (select amount from expense_lines(:'org', '2025-01-01', '2025-12-31')
    where category = 'auto_travel') = 70,
  'a new year''s rate does not rewrite an earlier year');
select assert(
  (select amount from expense_lines(:'org', '2026-01-01', '2026-12-31')
    where category = 'auto_travel') = 72.50,
  'and the new year uses its own rate');
select assert((select total_cost from job_totals(:'job')) = 80 + 70 + 72.50,
  'a job''s total costs each trip at its own year''s rate');

select set_config('request.jwt.uid', 'a5222222-2222-2222-2222-222222222222', false);
set role authenticated;
select assert_rejected(
  format('insert into mileage_rates (organization_id, year, rate) values (%L, 2027, 1)', :'org'),
  'only an admin sets mileage rates');
reset role;
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);

-- ========================================================== partial refunds ==

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-02-01', 1200) returning id as feb \gset
insert into payments (lease_id, tenant_member_id, rent_charge_id, amount, processing_fee_amount,
                      total_charged, method, status, stripe_payment_intent_id, paid_at)
values (:'lease', :'tenant_member', :'feb', 1200, 5, 1205, 'ach', 'succeeded', 'pi_partial',
        '2026-02-03 15:00:00+00') returning id as feb_pay \gset
select assert((select amount_paid from rent_charges where id = :'feb') = 1200, 'paid in full');

update payments set refunded_amount = 50 where id = :'feb_pay';
select assert((select amount_paid from rent_charges where id = :'feb') = 1150,
  'a $50 refund takes $50 off the charge, not the whole payment');
select assert((select status from rent_charges where id = :'feb') = 'partial',
  'and leaves it part-paid');
select assert(
  (select amount from income_lines(:'org', '2026-02-01', '2026-02-28') where id = :'feb_pay') = 1150,
  'income counts what was kept');

-- Refunds are cumulative, as Stripe reports them.
update payments set refunded_amount = 200 where id = :'feb_pay';
select assert((select amount_paid from rent_charges where id = :'feb') = 1000,
  'a second refund takes only the extra');

-- Then the rest goes back: the full reversal must not take the first
-- $200 a second time.
update payments set status = 'refunded' where id = :'feb_pay';
select assert((select amount_paid from rent_charges where id = :'feb') = 0,
  'a full refund after partial ones leaves exactly nothing paid');
select assert(
  (select count(*) from income_lines(:'org', '2026-02-01', '2026-02-28') where id = :'feb_pay') = 0,
  'and nothing in income');

select assert_rejected(
  format('update payments set refunded_amount = 5000 where id = %L', :'feb_pay'),
  'more cannot be refunded than was charged');

-- ========================================================= closing a year ==

insert into expenses (organization_id, property_id, category, spent_on, amount)
values (:'org', :'prop', 'taxes', '2025-11-01', 900) returning id as tax25 \gset

set role authenticated;
select set_config('request.jwt.uid', 'a5222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('insert into closed_years (organization_id, year) values (%L, 2025)', :'org'),
  'a property manager cannot close a year');
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
insert into closed_years (organization_id, year) values (:'org', 2025);
select assert((select closed_by from closed_years where year = 2025) = :'owner_member',
  'who closed it is recorded by the database');

-- The property manager is now kept out of 2025's money.
select set_config('request.jwt.uid', 'a5222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('update expenses set amount = 1 where id = %L', :'tax25'),
  'a property manager cannot change an expense in a closed year');
select assert_rejected(
  format('insert into expenses (organization_id, category, spent_on, amount) values (%L, %L, %L, 5)',
         :'org', 'supplies', '2025-03-01'),
  'or add one');
select assert_rejected(
  format('delete from expenses where id = %L', :'tax25'),
  'or delete one');
select assert_rejected(
  format('update expenses set spent_on = %L where id = %L', '2026-01-02', :'tax25'),
  'or move one out of it');
-- 2026 is open.
insert into expenses (organization_id, category, spent_on, amount)
values (:'org', 'supplies', '2026-03-01', 5);

-- An admin can, and it is written down.
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
update expenses set amount = 950 where id = :'tax25';
select assert((select amount from expenses where id = :'tax25') = 950, 'an admin can change a closed year');
select assert(
  (select count(*) from year_change_log where year = 2025 and changed_by = :'owner_member') = 1,
  'and the change is logged against the year, with who made it');
select assert(
  (select count(*) from year_change_log where year = 2026) = 0,
  'changes in an open year are not logged');
reset role;

-- A bank reversal arriving in January for a December payment: the system
-- (no signed-in user) must get through, and it is logged.
select set_config('request.jwt.uid', '', false);
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2025-12-01', 1200) returning id as dec \gset
-- Recorded before the year was closed would be the realistic order; the
-- insert itself is also a closed-year change and is logged too.
insert into payments (lease_id, tenant_member_id, rent_charge_id, amount, processing_fee_amount,
                      total_charged, method, status, stripe_payment_intent_id, paid_at)
values (:'lease', :'tenant_member', :'dec', 1200, 0, 1200, 'ach', 'succeeded', 'pi_dec',
        '2025-12-02 15:00:00+00') returning id as dec_pay \gset
update payments set status = 'refunded' where id = :'dec_pay';
select assert(
  (select count(*) from year_change_log where year = 2025 and changed_by is null) = 2,
  'the webhook''s changes to a closed year go through and are logged as the system''s');
-- A redelivered event that changes nothing is not noise in the log.
update payments set stripe_charge_id = 'ch_x' where id = :'dec_pay';
select assert(
  (select count(*) from year_change_log where year = 2025 and changed_by is null) = 2,
  'a redelivery that changes no money is not logged');

-- Reopening is an admin's call.
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
set role authenticated;
delete from closed_years where year = 2025;
select assert((select count(*) from closed_years) = 0, 'an admin can reopen a year');
reset role;

-- =========================================================== selling ==

select assert_rejected(
  format('delete from properties where id = %L', :'prop'),
  'a property with rent and expense history cannot be deleted');
select assert_rejected(
  format('delete from units where id = %L', :'unit'),
  'nor can a unit with rent history');
-- One with no history can.
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Typo', '1', 'Newport', 'KY', '41071') returning id as typo \gset
insert into units (property_id, label) values (:'typo', 'A');
delete from properties where id = :'typo';
select assert((select count(*) from properties where id = :'typo') = 0,
  'a property entered by mistake, with no history, can still be deleted');

set role authenticated;
select assert_rejected(
  format('select mark_property_sold(%L, %L, 300000, 18000)', :'prop', current_date),
  'a property with a lease still running cannot be marked sold');
reset role;
update leases set status = 'ended', ended_on = '2026-05-31' where id = :'lease';

set role authenticated;
select set_config('request.jwt.uid', 'a5222222-2222-2222-2222-222222222222', false);
select assert_rejected(
  format('select mark_property_sold(%L, %L, 300000, 18000)', :'prop', '2026-06-15'),
  'only an admin can mark a property sold');
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);
select assert_rejected(
  format('select mark_property_sold(%L, %L, 300000, 18000)', :'prop', current_date + 30),
  'a sale is recorded once it has closed, not ahead of it');
select mark_property_sold(:'prop', '2026-06-15', 300000, 18000);
select assert((select sold_on from properties where id = :'prop') = '2026-06-15', 'marked sold');
select assert((select sale_price from property_financials where property_id = :'prop') = 300000,
  'the sale price is kept with the purchase details');

-- The tenant can see the property but not what it sold for.
select set_config('request.jwt.uid', 'a5333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from property_financials) = 0,
  'a tenant cannot see the sale price');
select set_config('request.jwt.uid', 'a5111111-1111-1111-1111-111111111111', false);

select assert_rejected(
  format('insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
          values (%L, %L, 1200, 1, %L)', :'unit', '2026-07-01', 'pending'),
  'no new lease on a sold property');

-- History stays: the year of sale still has its income.
select assert(
  (select count(*) from income_lines(:'org', '2025-01-01', '2026-12-31')) > 0,
  'income from before the sale is still there');
select assert(
  (select (dashboard_summary(:'org') -> 'portfolio' ->> 'units')::int) = 0,
  'a sold building''s units leave the portfolio counts');

select unmark_property_sold(:'prop');
select assert((select sold_on from properties where id = :'prop') is null, 'a sale can be undone');
reset role;
