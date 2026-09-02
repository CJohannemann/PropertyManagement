-- Money owed at move-in, which the model had no way to express.
--
-- A real lease bills more than monthly rent: a prorated first month, a
-- security deposit, sometimes a pet deposit or a non-refundable fee. The
-- schema had a single `deposit_amount` and nothing else, so a tenant
-- signing a lease starting mid-month saw a balance of $0 until the first
-- full month came round — while actually owing the prorated rent and the
-- deposit that day.
--
-- These are billed as ordinary rent_charges rather than as separate
-- concepts, so they flow through the existing ledger, the tenant balance,
-- and (later) the payment flow without any of those needing to learn
-- about a second kind of money.
--
-- Idempotent, safe to re-run.

-- ------------------------------------------------------- lease columns --

-- deposit_amount keeps its meaning and is the security deposit.
alter table leases add column if not exists pet_deposit_amount       numeric(10,2);
alter table leases add column if not exists other_deposit_amount     numeric(10,2);
alter table leases add column if not exists other_deposit_label      text;
alter table leases add column if not exists nonrefundable_fee_amount numeric(10,2);
alter table leases add column if not exists nonrefundable_fee_label  text;
alter table leases add column if not exists prorated_rent_amount     numeric(10,2);
-- Stored so the lease document can state the figure and so a returned
-- payment can be charged at the agreed rate. Not applied automatically:
-- that needs a failed payment to react to, which arrives with Stripe.
alter table leases add column if not exists nsf_fee_amount           numeric(10,2);

comment on column leases.deposit_amount is 'Security deposit. See pet_/other_deposit_amount for the rest.';
comment on column leases.prorated_rent_amount is 'One-off rent for a partial first month, billed at start_date.';

-- --------------------------------------------------------- charge types --

-- Each move-in item gets its own charge_type rather than sharing 'other'
-- with a label, because "has this lease already been billed its security
-- deposit?" then has an exact answer, which is what makes the trigger
-- below safe to re-run.
alter table rent_charges drop constraint if exists rent_charges_charge_type_check;
alter table rent_charges add constraint rent_charges_charge_type_check
  check (charge_type in (
    'rent', 'late_fee', 'prorated_rent',
    'security_deposit', 'pet_deposit', 'other_deposit',
    'nonrefundable_fee', 'nsf_fee', 'other'
  ));

-- The one-time-per-lease charges. 'rent' is excluded (monthly), as are
-- 'late_fee' (once per rent charge, guarded separately), 'nsf_fee' and
-- 'other' (both can legitimately recur).
create unique index if not exists rent_charges_one_per_lease_per_type
  on rent_charges (lease_id, charge_type)
  where charge_type in ('prorated_rent', 'security_deposit', 'pet_deposit',
                        'other_deposit', 'nonrefundable_fee');

-- ------------------------------------------------------ the move-in bill --

-- Bills whatever move-in amounts the lease carries, once, dated at the
-- start of the term. Runs on insert and on the transition into 'active',
-- so a lease drafted as 'pending' bills when it actually starts, not when
-- it was typed up.
create or replace function generate_move_in_charges()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.status <> 'active' then
    return NEW;
  end if;

  insert into rent_charges (lease_id, charge_type, due_date, amount)
  select NEW.id, t.charge_type, NEW.start_date, t.amount
    from (values
      ('prorated_rent',     NEW.prorated_rent_amount),
      ('security_deposit',  NEW.deposit_amount),
      ('pet_deposit',       NEW.pet_deposit_amount),
      ('other_deposit',     NEW.other_deposit_amount),
      ('nonrefundable_fee', NEW.nonrefundable_fee_amount)
    ) as t(charge_type, amount)
   where t.amount is not null and t.amount > 0
  -- The partial unique index above is what makes re-running harmless:
  -- editing a lease cannot re-bill a deposit the tenant already owes.
  on conflict do nothing;

  return NEW;
end;
$fn$;

drop trigger if exists leases_generate_move_in_charges on leases;
create trigger leases_generate_move_in_charges
  after insert or update of status on leases
  for each row execute function generate_move_in_charges();
