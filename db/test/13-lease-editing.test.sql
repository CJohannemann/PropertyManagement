-- Correcting a lease before anyone signs it.
--
-- The thing under test is not the UPDATE — RLS always allowed that — but
-- whether the charges the lease already generated follow it. See
-- db/migrations/028_editable_draft_leases.sql for why that is gated on
-- nobody having signed and nobody having paid.

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

-- The reported case: rent typed as 1025, actually 1250.
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status,
                    deposit_amount, prorated_rent_amount)
values (:'unit_a', date_trunc('month', current_date)::date, 1025, 1, 'active', 1000, 270)
returning id as lease_a \gset

select generate_rent_charges();

-- ------------------------------------------------- the rent was wrong --

update leases set rent_amount = 1250 where id = :'lease_a';

select assert(
  (select amount from rent_charges
    where lease_id = :'lease_a' and charge_type = 'rent') = 1250,
  'correcting the rent restates the rent charge already generated');
select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_a' and charge_type = 'rent') = 1,
  'and does not bill a second one');

-- Pet rent recurs and is folded into the rent charge (007), so the resync
-- has to produce the same total generation does, not just rent_amount.
update leases set pets_allowed = true, pet_rent_amount = 25 where id = :'lease_a';
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_a' and charge_type = 'rent') = 1275,
  'pet rent is folded into the restated rent charge, not dropped from it');

-- ------------------------------------------------ the move-in money --

update leases set prorated_rent_amount = 300 where id = :'lease_a';
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_a' and charge_type = 'prorated_rent') = 300,
  'correcting the prorated rent restates its charge');

-- Remembered after the fact. 006's trigger only fires on insert and on the
-- move into 'active', so before this a deposit added later was never owed.
update leases set pet_deposit_amount = 250 where id = :'lease_a';
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_a' and charge_type = 'pet_deposit') = 250,
  'a deposit added while editing is billed');

-- And taken back off.
update leases set pet_deposit_amount = null where id = :'lease_a';
select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_a' and charge_type = 'pet_deposit') = 0,
  'removing it takes the charge away again');

-- ---------------------------------------- money already paid is a fact --

update rent_charges set amount_paid = 100, status = 'partial'
 where lease_id = :'lease_a' and charge_type = 'prorated_rent';
update leases set prorated_rent_amount = 999 where id = :'lease_a';
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_a' and charge_type = 'prorated_rent') = 300,
  'a charge somebody has paid against is not restated');

-- Nor deleted, when the figure is taken off the lease entirely.
update leases set prorated_rent_amount = null where id = :'lease_a';
select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_a' and charge_type = 'prorated_rent') = 1,
  'nor is it deleted out from under the payment');

-- -------------------------------------------- the due day, and lateness --

-- Two months, one behind and one ahead, so what counts as late is decided
-- by the calendar rather than by whatever day the suite happens to run.
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', (date_trunc('month', current_date) - interval '3 months')::date,
        800, 1, 'active')
returning id as lease_b \gset

select generate_rent_charges((date_trunc('month', current_date) - interval '2 months')::date);
select generate_rent_charges((date_trunc('month', current_date) + interval '1 month')::date);
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_b' and charge_type = 'rent') = 2,
  'two months of rent stand ready to be restated');

update leases set rent_amount = 850, rent_due_day = 15 where id = :'lease_b';

select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_b' and charge_type = 'rent'
      and extract(day from due_date) = 15) = 2,
  'both charges move to the corrected due day');
select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_b' and charge_type = 'rent' and amount = 850) = 2,
  'and both carry the corrected rent');
select assert(
  (select status from rent_charges
    where lease_id = :'lease_b' and charge_type = 'rent'
      and due_date < current_date) = 'late',
  'the month already past reads as late');
select assert(
  (select status from rent_charges
    where lease_id = :'lease_b' and charge_type = 'rent'
      and due_date > current_date) = 'pending',
  'the month still ahead does not');

-- Shortening the term stops billing months the tenant will not be there
-- for. Generation already skips them; what had been generated stayed owed.
update leases set end_date = (date_trunc('month', current_date) - interval '1 day')::date
 where id = :'lease_b';
select assert(
  (select count(*) from rent_charges
    where lease_id = :'lease_b' and charge_type = 'rent'
      and due_date > current_date) = 0,
  'a month billed beyond the shortened term is no longer owed');

-- ------------------------------------------------ once it is signed --

insert into lease_templates (organization_id, name, is_default)
values (:'org', 'Standard', true) returning id as tpl \gset
insert into lease_template_clauses (template_id, position, heading, body)
values (:'tpl', 0, 'Rent', 'Tenant shall pay {rentAmount} per month.');

insert into leases (unit_id, start_date, rent_amount, rent_due_day, status, deposit_amount)
values (:'unit_c', date_trunc('month', current_date)::date, 700, 1, 'active', 700)
returning id as lease_c \gset
select generate_rent_charges();

select assert(lease_is_signed(:'lease_c') = false, 'nobody has signed it yet');
select sign_lease(:'lease_c', 'The Landlord', true);
select assert(lease_is_signed(:'lease_c'), 'one signature is enough to make it signed');

update leases set rent_amount = 2500, deposit_amount = 2500 where id = :'lease_c';
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_c' and charge_type = 'rent') = 700,
  'a signed lease keeps the rent charge that was agreed');
select assert(
  (select amount from rent_charges
    where lease_id = :'lease_c' and charge_type = 'security_deposit') = 700,
  'and the deposit that was agreed');
select assert(
  (select rent_amount from leases where id = :'lease_c') = 2500,
  'while the lease row itself still takes the edit');

select assert(true, 'lease editing tests completed');
