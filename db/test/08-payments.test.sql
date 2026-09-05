-- The rent ledger under real payment flows.
--
-- These matter more than most: every assertion here is the difference
-- between a tenant's money arriving and the app agreeing that it did. A
-- ledger that silently under-credits looks like a tenant who didn't pay,
-- and (with late_fee_auto_apply on) bills them for it.
--
-- ACH is the case the original triggers missed. A card payment is one
-- INSERT that is already 'succeeded'; an ACH payment is an INSERT that is
-- only 'processing', UPDATEd to 'succeeded' days later when the bank
-- actually settles. See db/migrations/017_payment_triggers.sql.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'tenant@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset

select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select accept_invite(:'token');
select id as tenant_member from org_members
 where user_id = '33333333-3333-3333-3333-333333333333' \gset
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);

-- ------------------------------------------------- an ACH rent payment --

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-02-01', 1200) returning id as charge \gset

-- The bank has been asked for the money; it has not arrived.
insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge', 1200, 6, 1206, 'ach', 'processing',
        'pi_ach_test_1')
returning id as ach_payment \gset

select assert((select amount_paid from rent_charges where id = :'charge') = 0,
  'money still in transit credits nothing to the ledger');
select assert((select status from rent_charges where id = :'charge') = 'pending',
  'and the charge stays pending');

-- Days later, the bank settles. THIS is the case the insert-only trigger
-- missed: without an update trigger the tenant's money has moved and the
-- ledger still says they owe 1200.
update payments set status = 'succeeded', paid_at = now() where id = :'ach_payment';

select assert((select amount_paid from rent_charges where id = :'charge') = 1200,
  'a settled ACH payment credits the ledger, got '
  || (select amount_paid::text from rent_charges where id = :'charge'));
select assert((select status from rent_charges where id = :'charge') = 'paid',
  'and marks the charge paid');

-- Stripe retries webhooks for days; the same settlement arriving twice
-- must not credit twice. The unique constraint on
-- stripe_payment_intent_id stops a duplicate INSERT; this covers a
-- duplicate UPDATE of the row that is already there.
update payments set status = 'succeeded', paid_at = now() where id = :'ach_payment';

select assert((select amount_paid from rent_charges where id = :'charge') = 1200,
  'a replayed settlement credits nothing further, got '
  || (select amount_paid::text from rent_charges where id = :'charge'));

-- ------------------------------------------------------- ACH reversal --

-- An ACH debit can be returned after it looked successful (insufficient
-- funds, closed account). The ledger has to give the credit back.
update payments set status = 'refunded' where id = :'ach_payment';

select assert((select amount_paid from rent_charges where id = :'charge') = 0,
  'a returned payment reverses its credit, got '
  || (select amount_paid::text from rent_charges where id = :'charge'));
select assert((select status from rent_charges where id = :'charge') = 'pending',
  'and the charge is owed again');

-- --------------------------------------------- a payment that never lands --

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-03-01', 1200) returning id as charge2 \gset

insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge2', 1200, 6, 1206, 'ach', 'processing',
        'pi_ach_test_2')
returning id as failed_payment \gset

update payments set status = 'failed', failure_reason = 'R01 insufficient funds'
 where id = :'failed_payment';

select assert((select amount_paid from rent_charges where id = :'charge2') = 0,
  'a failed payment credits nothing');
select assert((select status from rent_charges where id = :'charge2') = 'pending',
  'and leaves the charge owed');

-- ------------------------------------------------- partial payments --

insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-04-01', 1000) returning id as charge3 \gset

insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge3', 400, 3.20, 403.20, 'ach', 'processing',
        'pi_ach_test_3')
returning id as part1 \gset
update payments set status = 'succeeded', paid_at = now() where id = :'part1';

select assert((select amount_paid from rent_charges where id = :'charge3') = 400,
  'a part payment credits what it was for');
select assert((select status from rent_charges where id = :'charge3') = 'partial',
  'and leaves the charge partial');

-- The rest, settling the same way.
insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge3', 600, 4.80, 604.80, 'ach', 'processing',
        'pi_ach_test_4')
returning id as part2 \gset
update payments set status = 'succeeded', paid_at = now() where id = :'part2';

select assert((select amount_paid from rent_charges where id = :'charge3') = 1000,
  'the balance settles the charge, got '
  || (select amount_paid::text from rent_charges where id = :'charge3'));
select assert((select status from rent_charges where id = :'charge3') = 'paid',
  'and marks it paid');

-- ------------------------- reversing something that never credited --

-- Two payments against one charge: one settled, one still in flight. If
-- the in-flight one is reversed it must not touch the ledger — it never
-- credited anything, and subtracting it would eat the settled payment's
-- credit instead.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-06-01', 1000) returning id as charge5 \gset

insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      paid_at, stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge5', 400, 3.20, 403.20, 'ach', 'succeeded',
        now(), 'pi_ach_test_6');

insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge5', 600, 4.80, 604.80, 'ach', 'processing',
        'pi_ach_test_7')
returning id as inflight \gset

select assert((select amount_paid from rent_charges where id = :'charge5') = 400,
  'only the settled payment counts so far');

update payments set status = 'refunded' where id = :'inflight';

select assert((select amount_paid from rent_charges where id = :'charge5') = 400,
  'reversing a payment that never credited leaves the ledger alone, got '
  || (select amount_paid::text from rent_charges where id = :'charge5'));

-- ------------------------------------------------------ overpayment --

-- rent_charges_paid_not_over_check (009_lease_constraints.sql) refuses to
-- credit more than the charge is for. The API must cap a payment at what
-- is outstanding; this proves the database is the backstop if it doesn't.
insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge3', 50, 0.40, 50.40, 'ach', 'processing',
        'pi_ach_test_5')
returning id as overpay \gset

select assert_rejected(
  format('update payments set status = ''succeeded'' where id = %L', :'overpay'),
  'crediting more than a charge is for is refused by the database');

-- --------------------------------------------------- a card payment --

-- The original single-INSERT shape still has to work: one row, already
-- succeeded, credited exactly once.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', '2026-05-01', 900) returning id as charge4 \gset

insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                      processing_fee_amount, total_charged, method, status,
                      paid_at, stripe_payment_intent_id)
values (:'lease', :'tenant_member', :'charge4', 900, 0, 900, 'card', 'succeeded',
        now(), 'pi_card_test_1');

select assert((select amount_paid from rent_charges where id = :'charge4') = 900,
  'a payment inserted already-succeeded credits once');
select assert((select status from rent_charges where id = :'charge4') = 'paid',
  'and marks the charge paid');

-- ------------------------------------------- tenants cannot fake a payment --

-- The whole reason payments has no client-facing insert policy: a
-- compromised browser must not be able to declare its own rent paid.
-- Counted here, unrestricted, so the tenant's own count below is compared
-- against the truth rather than against itself.
select count(*) as all_payments from payments \gset

set role authenticated;
select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);

-- Every payment above is against this tenant's own lease, so they should
-- see all of them — a tenant who cannot see their own payment history has
-- no way to tell whether the rent they sent actually arrived.
select assert((select count(*) from payments) = :'all_payments'::bigint,
  'a tenant sees their own payment history in full, got '
  || (select count(*)::text from payments) || ' of ' || :'all_payments');

reset role;
select assert_rejected(
  format('set role authenticated;
          select set_config(''request.jwt.uid'', %L, false);
          insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                                processing_fee_amount, total_charged, method, status)
          values (%L, %L, %L, 1200, 0, 1200, ''ach'', ''succeeded'')',
         '33333333-3333-3333-3333-333333333333',
         :'lease', :'tenant_member', :'charge2'),
  'a tenant cannot write their own payment record');

reset role;
select assert(true, 'payment tests completed');
