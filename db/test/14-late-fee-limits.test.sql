-- State late-fee rules: what a lease is not allowed to say.
--
-- enforce_late_fee_limits is the "fail safe on unverified state" rule from
-- docs/domain-model.md. It is the only thing standing between a landlord
-- and a lease that bills a fee the state does not allow — and like every
-- check of this kind, breaking it changes nothing visible until a tenant
-- is charged money they did not owe.
--
-- The states here are invented (ZP, ZF, ZN, ZU) so the tests do not depend
-- on what seed.sql currently believes about any real state.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset

insert into state_rent_regulations
  (state_code, max_late_fee_type, max_late_fee_value, min_grace_days,
   tenant_paid_processing_fee_allowed)
values
  ('ZP', 'percent', 10, 5, true),   -- 10% of rent, 5 days' grace
  ('ZF', 'flat',    50, 0, false),  -- $50, processing fees not allowed
  ('ZN', 'none',  null, 3, null);   -- no cap, allowance unknown

insert into properties (organization_id, name, address_line1, city, state, zip) values
  (:'org', 'Percent', '1 St', 'X', 'ZP', '00001') returning id as p_pct \gset
insert into properties (organization_id, name, address_line1, city, state, zip) values
  (:'org', 'Flat', '2 St', 'X', 'ZF', '00002') returning id as p_flat \gset
insert into properties (organization_id, name, address_line1, city, state, zip) values
  (:'org', 'None', '3 St', 'X', 'ZN', '00003') returning id as p_none \gset
insert into properties (organization_id, name, address_line1, city, state, zip) values
  (:'org', 'Unverified', '4 St', 'X', 'ZU', '00004') returning id as p_unv \gset

insert into units (property_id, label) values (:'p_pct', 'A') returning id as u_pct \gset
insert into units (property_id, label) values (:'p_flat', 'A') returning id as u_flat \gset
insert into units (property_id, label) values (:'p_none', 'A') returning id as u_none \gset
insert into units (property_id, label) values (:'p_unv', 'A') returning id as u_unv \gset

-- ---------------------------------------------- an unverified state --

-- Nothing on file means nothing is known, so nothing that bills the tenant
-- automatically is allowed.
select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_auto_apply, late_fee_type, late_fee_amount)
           values (%L, '2026-01-01', 1200, 1, true, 'flat', 25)$$, :'u_unv'),
  'auto-applied late fees are refused in a state with no regulations on file');

select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day, fee_payer)
           values (%L, '2026-01-01', 1200, 1, 'tenant')$$, :'u_unv'),
  'tenant-paid processing fees are refused in a state with no regulations on file');

-- A lease that bills nothing automatically is still fine there: the rule
-- is about fees, not about whether the landlord can use the app at all.
insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                    late_fee_type, late_fee_amount)
values (:'u_unv', '2026-01-01', 1200, 1, 'flat', 25)
returning id as l_unv \gset
select assert(:'l_unv' is not null,
  'a lease without auto-applied fees is accepted in an unverified state');

-- And it cannot be switched on afterwards. The trigger runs on UPDATE as
-- well, or a lease written legally could be edited into one that is not.
select assert_rejected(
  format('update leases set late_fee_auto_apply = true where id = %L', :'l_unv'),
  'auto-apply cannot be turned on later in an unverified state');

-- ------------------------------------------------------ grace days --

select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_type, late_fee_amount, late_fee_grace_days)
           values (%L, '2026-01-01', 1200, 1, 'flat', 25, 4)$$, :'u_pct'),
  'a grace period shorter than the state minimum is refused');

insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                    late_fee_auto_apply, late_fee_type, late_fee_amount, late_fee_grace_days)
values (:'u_pct', '2026-01-01', 1200, 1, true, 'flat', 25, 5)
returning id as l_pct \gset
select assert(:'l_pct' is not null, 'exactly the minimum grace period is accepted');

-- ----------------------------------------------------- percent caps --

-- 10% of $1,200 is $120.
select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_type, late_fee_amount, late_fee_grace_days)
           values (%L, '2026-02-01', 1200, 1, 'percent', 10.5, 5)$$, :'u_pct'),
  'a percent fee above a percent cap is refused');

-- The reason the trigger normalizes to dollars: the same fee written as a
-- flat amount must not slip past a percent cap.
select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_type, late_fee_amount, late_fee_grace_days)
           values (%L, '2026-02-01', 1200, 1, 'flat', 121, 5)$$, :'u_pct'),
  'a flat fee worth more than a percent cap is refused');

insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                    late_fee_type, late_fee_amount, late_fee_grace_days)
values (:'u_pct', '2026-03-01', 1200, 1, 'flat', 120, 5)
returning id as l_pct_edge \gset
select assert(:'l_pct_edge' is not null, 'a fee exactly at the cap is accepted');

-- A percent cap moves with the rent, so lowering the rent under an
-- existing fee has to re-check it.
select assert_rejected(
  format('update leases set rent_amount = 1000 where id = %L', :'l_pct_edge'),
  'cutting the rent below what the existing fee is allowed against is refused');

-- -------------------------------------------------------- flat caps --

select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_type, late_fee_amount)
           values (%L, '2026-01-01', 1200, 1, 'flat', 51)$$, :'u_flat'),
  'a flat fee above a flat cap is refused');

-- 5% of $1,200 is $60: over the $50 cap, though "5" looks small.
select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day,
             late_fee_type, late_fee_amount)
           values (%L, '2026-01-01', 1200, 1, 'percent', 5)$$, :'u_flat'),
  'a percent fee worth more than a flat cap is refused');

insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                    late_fee_type, late_fee_amount)
values (:'u_flat', '2026-01-01', 1200, 1, 'flat', 50)
returning id as l_flat \gset
select assert(:'l_flat' is not null, 'a flat fee at the flat cap is accepted');

-- --------------------------------------------- processing fees --

select assert_rejected(
  format('update leases set fee_payer = %L where id = %L', 'tenant', :'l_flat'),
  'tenant-paid processing fees are refused where the state says they are not allowed');

-- Unknown is not the same as allowed.
select assert_rejected(
  format($$insert into leases (unit_id, start_date, rent_amount, rent_due_day, fee_payer)
           values (%L, '2026-01-01', 1200, 1, 'tenant')$$, :'u_none'),
  'tenant-paid processing fees are refused where the allowance is unknown');

update leases set fee_payer = 'tenant' where id = :'l_pct';
select assert((select fee_payer from leases where id = :'l_pct') = 'tenant',
  'tenant-paid processing fees are accepted where the state allows them');

-- ---------------------------------------------------- no cap at all --

insert into leases (unit_id, start_date, rent_amount, rent_due_day,
                    late_fee_auto_apply, late_fee_type, late_fee_amount, late_fee_grace_days)
values (:'u_none', '2026-01-01', 1200, 1, true, 'flat', 500, 3)
returning id as l_none \gset
select assert(:'l_none' is not null,
  'a state recorded as having no cap does not invent one');

-- But its grace minimum still applies.
select assert_rejected(
  format('update leases set late_fee_grace_days = 2 where id = %L', :'l_none'),
  'a state with no cap still enforces its minimum grace period');

select assert(true, 'late fee limit tests completed');
