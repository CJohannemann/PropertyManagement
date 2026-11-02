-- Ending a lease, the lease record, and the deposit wrap-up (033).
--
-- Ending stops billing and frees the unit, keeps what was owed by the
-- move-out, drops unpaid charges for after it, and either keeps or removes
-- the tenant's sign-in. The record and the deposit are office-only. The
-- deposit can pay down what's owed — through the ledger — and a refund
-- can't exceed what's left.

insert into storage.buckets (id, name) values ('lease-files', 'lease-files')
on conflict (id) do nothing;

insert into auth.users (id, email) values
  ('c3000000-0000-0000-0000-000000000001', 'owner@example.com'),
  ('c3000000-0000-0000-0000-000000000002', 'pm@example.com'),
  ('c3000000-0000-0000-0000-000000000003', 'evicted@example.com'),
  ('c3000000-0000-0000-0000-000000000004', 'mover@example.com'),
  ('c3000000-0000-0000-0000-000000000005', 'tech@example.com'),
  ('d3000000-0000-0000-0000-000000000001', 'stranger@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com'), ('stranger@example.com');

select set_config('request.jwt.uid', 'd3000000-0000-0000-0000-000000000001', false);
select create_organization('Other Org') as org_b \gset

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000001', false);
select create_organization('Test Org') as org \gset

insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Duplex', '1 St', 'Newport', 'KY', '41071') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit_a \gset
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset

-- Unit A: started four months ago, $1,000 deposit (billed by 006's trigger).
insert into leases (unit_id, start_date, rent_amount, rent_due_day, deposit_amount, status)
values (:'unit_a', current_date - 120, 1200, 1, 1000, 'active') returning id as lease_a \gset
-- Unit B: $500 deposit.
insert into leases (unit_id, start_date, rent_amount, rent_due_day, deposit_amount, status)
values (:'unit_b', current_date - 120, 900, 1, 500, 'active') returning id as lease_b \gset

select token from create_invite('pm@example.com', 'property_manager') \gset
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000002', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000001', false);
select token from create_invite('evicted@example.com', 'tenant', :'lease_a', 'Evicted') \gset
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000003', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000001', false);
select token from create_invite('mover@example.com', 'tenant', :'lease_b', 'Mover') \gset
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000004', false);
select accept_invite(:'token');
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000001', false);
select token from create_invite('tech@example.com', 'technician') \gset
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000005', false);
select accept_invite(:'token');

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000001', false);
select id as evicted from org_members where user_id = 'c3000000-0000-0000-0000-000000000003' \gset
select id as mover from org_members where user_id = 'c3000000-0000-0000-0000-000000000004' \gset
select id as tech from org_members where user_id = 'c3000000-0000-0000-0000-000000000005' \gset
select set_technician_access(:'tech', true);

-- The mover also has a running lease on unit B — and, for the access
-- test, is co-tenant on A as well.
insert into lease_tenants (lease_id, org_member_id, is_primary) values (:'lease_a', :'mover', false);

-- Both deposits paid.
select record_manual_payment(id, amount, 'check') from rent_charges
 where lease_id in (:'lease_a', :'lease_b') and charge_type = 'security_deposit';

-- Unit A's rent: two months ago unpaid, last month paid, and next month
-- already billed in advance and unpaid.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a', 'rent', current_date - 60, 1200) returning id as old_rent \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a', 'rent', current_date - 30, 1200) returning id as paid_rent \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease_a', 'rent', current_date + 25, 1200) returning id as future_rent \gset
insert into rent_charges (lease_id, charge_type, due_date, amount, parent_charge_id)
values (:'lease_a', 'late_fee', current_date + 30, 50, :'future_rent');
select record_manual_payment(:'paid_rent', 1200, 'cash');

set role authenticated;

-- ---------------------------------------------------------- ending --

-- Not the tenant's, the technician's, or another landlord's to do.
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000003', false);
select assert_rejected(
  format($$select end_lease(%L, current_date, 'moved_out_early')$$, :'lease_a'),
  'a tenant cannot end their own lease');
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000005', false);
select assert_rejected(
  format($$select end_lease(%L, current_date, 'eviction')$$, :'lease_a'),
  'a technician cannot end a lease');
select set_config('request.jwt.uid', 'd3000000-0000-0000-0000-000000000001', false);
select assert_rejected(
  format($$select end_lease(%L, current_date, 'eviction')$$, :'lease_a'),
  'another landlord cannot end this lease');

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000002', false);
select assert_rejected(
  format($$select end_lease(%L, current_date + 10, 'eviction')$$, :'lease_a'),
  'a move-out in the future is refused');
select assert_rejected(
  format($$select end_lease(%L, current_date - 365, 'eviction')$$, :'lease_a'),
  'a move-out before the lease started is refused');
select assert_rejected(
  format($$select end_lease(%L, current_date, 'vanished')$$, :'lease_a'),
  'an unknown reason is refused');

-- The property manager records the eviction, removing access.
select end_lease(:'lease_a', current_date, 'eviction', 'Judgment for possession', false) as result \gset

reset role;
select assert(
  (select status = 'ended' and end_date = current_date and ended_on = current_date
          and end_reason = 'eviction' and end_note = 'Judgment for possession'
     from leases where id = :'lease_a'),
  'the lease is ended, dated, and the reason kept');
select assert(not exists (select 1 from rent_charges where id = :'future_rent'),
  'unpaid rent billed for after the move-out is removed');
select assert(not exists (select 1 from rent_charges where parent_charge_id = :'future_rent'),
  'and the late fee on it');
select assert(exists (select 1 from rent_charges where id = :'old_rent'),
  'rent owed from before the move-out stays owed');
select assert(exists (select 1 from rent_charges where id = :'paid_rent'),
  'paid rent is untouched');
select assert((:'result'::jsonb ->> 'still_owed')::numeric = 1200,
  'end_lease reports what is still owed');
select assert(
  (select status from org_members where id = :'evicted') = 'disabled',
  'the evicted tenant''s sign-in is removed');
select assert(
  (select status from org_members where id = :'mover') = 'active',
  'a co-tenant with another running lease keeps theirs');
select assert(
  exists (select 1 from lease_events where lease_id = :'lease_a'
           and event_type = 'move_out' and title = 'Ended by eviction'),
  'the move-out is written to the lease record');

select assert(generate_rent_charges((date_trunc('month', current_date) + interval '1 month')::date) = 1,
  'next month bills the running lease only');
select assert(
  not exists (select 1 from rent_charges where lease_id = :'lease_a' and charge_type = 'rent'
                and due_date > current_date),
  'and nothing for the ended one');

-- Late fees stop growing on an ended lease, though they keep applying to
-- a running one.
update leases set late_fee_auto_apply = true, late_fee_type = 'flat',
                  late_fee_amount = 25, late_fee_grace_days = 5
 where id = :'lease_a';
select apply_late_fees();
select assert(not exists (select 1 from rent_charges where parent_charge_id = :'old_rent'),
  'no new late fee accrues on an ended lease');

set role authenticated;
select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000002', false);
select assert_rejected(
  format($$select end_lease(%L, current_date, 'eviction')$$, :'lease_a'),
  'a lease can only be ended once');

-- A second move-out, keeping access so the tenant can see what they owe.
select end_lease(:'lease_b', current_date - 2, 'moved_out_early', null, true);

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000004', false);
select assert(
  (select count(*) from rent_charges where lease_id = :'lease_b') >= 1,
  'a former tenant who kept access still sees their charges');
select assert_rejected(
  format($$insert into maintenance_requests (unit_id, submitted_by, category, description, priority)
           values (%L, %L, 'plumbing', 'leak', 'normal')$$, :'unit_b', :'mover'),
  'but cannot report a repair in a unit they left');
select assert((select count(*) from lease_events) = 0,
  'and cannot read the lease record');

-- ------------------------------------------------------ the record --

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000002', false);
insert into lease_events (lease_id, event_type, event_date, title, details)
values (:'lease_a', 'notice_served', current_date - 20, '7-day pay or quit notice', 'Posted on door')
returning id as notice \gset
select assert((select count(*) from lease_events where lease_id = :'lease_a') = 2,
  'the office adds to the record');

insert into storage.objects (bucket_id, name)
values ('lease-files', :'lease_a' || '/' || :'notice' || '/notice.pdf');
select assert((select count(*) from storage.objects where bucket_id = 'lease-files') = 1,
  'and attaches a copy of the notice');

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000005', false);
select assert((select count(*) from lease_events) = 0, 'a technician cannot read the record');
select assert((select count(*) from storage.objects where bucket_id = 'lease-files') = 0,
  'or its files');
select assert_rejected(
  format($$insert into storage.objects (bucket_id, name) values ('lease-files', %L)$$,
         :'lease_a' || '/x/y.pdf'),
  'or add to them');

select set_config('request.jwt.uid', 'd3000000-0000-0000-0000-000000000001', false);
select assert((select count(*) from lease_events) = 0, 'another landlord cannot read it');
select assert((select count(*) from storage.objects where bucket_id = 'lease-files') = 0,
  'or its files');

-- ----------------------------------------------------- the deposit --

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000003', false);
select assert_rejected(format($$select * from deposit_summary(%L)$$, :'lease_a'),
  'a tenant cannot read the deposit summary');

select set_config('request.jwt.uid', 'c3000000-0000-0000-0000-000000000002', false);
select assert(
  (select held = 1000 and deducted = 0 and remaining = 1000 and owed = 1200
     from deposit_summary(:'lease_a')),
  'the deposit held is what was paid, and what is owed excludes it');

insert into deposit_deductions (lease_id, description, amount)
values (:'lease_a', 'Carpet cleaning', 150) returning id as carpet \gset

select assert_rejected(
  format($$insert into deposit_deductions (lease_id, description, amount, applied_to_balance)
           values (%L, 'sneaky', 1, true)$$, :'lease_a'),
  'an applied-to-balance deduction can only come from the function');

select assert(apply_deposit_to_balance(:'lease_a') = 850,
  'what is left of the deposit (1000 - 150) pays down the balance');
select assert(
  (select held = 1000 and deducted = 1000 and remaining = 0 and owed = 350
     from deposit_summary(:'lease_a')),
  'the deposit is used up and the balance owed drops to 350');
select assert(
  exists (select 1 from payments where rent_charge_id = :'old_rent'
            and amount = 850 and note = 'Applied from security deposit'),
  'through a real payment against the oldest charge');

delete from deposit_deductions where lease_id = :'lease_a' and applied_to_balance;
select assert(exists (select 1 from deposit_deductions where lease_id = :'lease_a' and applied_to_balance),
  'the applied deduction cannot be deleted on its own');

select assert_rejected(format($$select apply_deposit_to_balance(%L)$$, :'lease_a'),
  'an empty deposit cannot be applied again');
select assert_rejected(format($$select record_deposit_return(%L, 10, current_date)$$, :'lease_a'),
  'nor refunded');

-- Unit B: nothing owed, $500 held.
select assert_rejected(format($$select record_deposit_return(%L, 600, current_date)$$, :'lease_b'),
  'a refund larger than the deposit is refused');
select record_deposit_return(:'lease_b', 500, current_date, 'check', 'Check #1042');
select assert(
  (select remaining = 0 and returned = 500 from deposit_summary(:'lease_b')),
  'the refund is recorded');
select assert(
  exists (select 1 from lease_events where lease_id = :'lease_b' and event_type = 'deposit'),
  'and written to the lease record');
select assert_rejected(format($$select record_deposit_return(%L, 0, current_date)$$, :'lease_b'),
  'only one refund per lease');

-- Undoing a mistaken refund is allowed.
delete from deposit_returns where lease_id = :'lease_b';
select assert((select returned = 0 from deposit_summary(:'lease_b')),
  'a recorded refund can be undone');

reset role;
select assert(true, 'lease ending tests completed');
