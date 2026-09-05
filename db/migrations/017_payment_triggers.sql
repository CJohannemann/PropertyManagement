-- Makes the rent ledger correct for asynchronous (ACH) payments, and adds
-- the fields Stripe's webhook needs to record what happened.
--
-- The bug this fixes:
--
--   apply_payment_to_charge() was wired `after insert` only. That is right
--   for a card, which arrives as one INSERT already 'succeeded'. An ACH
--   debit does not: it is INSERTed as 'processing' when the bank is asked
--   for the money, then UPDATEd to 'succeeded' days later when it actually
--   settles. No trigger fired on that update, so rent_charges.amount_paid
--   never moved — the tenant's money left their account, the landlord
--   received it, and the app still showed the rent as owed (and, with
--   late_fee_auto_apply on, billed a late fee for it).
--
-- Idempotent, safe to re-run.

-- 'processing' is a real and long-lived state for ACH — days, not the
-- moment between creating a row and confirming it. Calling that 'pending'
-- would conflate "we have asked the bank" with "nothing has happened".
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'payments_status_check') then
    alter table payments drop constraint payments_status_check;
  end if;
  alter table payments add constraint payments_status_check
    check (status in ('pending', 'processing', 'succeeded', 'failed', 'refunded'));
end $$;

-- Why a payment did not land. ACH returns come back as codes (R01
-- insufficient funds, R02 account closed); without this a tenant is told
-- only that it failed, which they can do nothing with.
alter table payments add column if not exists failure_reason text;

-- Stripe's charge id, distinct from the payment intent already stored.
-- Refunds and disputes are reported against the charge, so reconciling
-- one without this means a lookup round-trip to Stripe.
alter table payments add column if not exists stripe_charge_id text;

-- Connect state, cached from Stripe's account.updated webhook so the
-- admin dashboard can say whether payouts actually work without calling
-- Stripe on every render. Nullable: unknown until an account exists.
alter table organizations add column if not exists stripe_charges_enabled boolean;
alter table organizations add column if not exists stripe_payouts_enabled boolean;
alter table organizations add column if not exists stripe_requirements_due text[];

comment on column organizations.stripe_charges_enabled is
  'Cached from Stripe. Null until the org has a Connect account.';
comment on column organizations.stripe_requirements_due is
  'What Stripe still needs before this landlord can be paid.';

-- ------------------------------------------------------ the ledger fix --

-- Credits a charge when, and only when, a payment *becomes* succeeded.
--
-- The transition is what matters, not the state: Stripe retries a webhook
-- for days, so the same settlement can arrive many times. Crediting on
-- "is succeeded" rather than "just became succeeded" would credit the
-- rent again on every retry.
create or replace function apply_payment_to_charge()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.rent_charge_id is null then
    return NEW;
  end if;

  -- On INSERT there is no prior row, so an already-succeeded insert (a
  -- card, or a manually recorded payment) is itself the transition. On
  -- UPDATE the row must not already have been counted.
  if NEW.status = 'succeeded'
     and (TG_OP = 'INSERT' or OLD.status is distinct from 'succeeded') then
    update rent_charges
       set amount_paid = amount_paid + NEW.amount,
           status = case when amount_paid + NEW.amount >= amount then 'paid' else 'partial' end
     where id = NEW.rent_charge_id;
  end if;

  return NEW;
end;
$fn$;

-- `update of status` rather than plain `update`: a webhook writing only
-- paid_at or stripe_charge_id has nothing to do with the ledger.
drop trigger if exists payments_apply_to_charge on payments;
create trigger payments_apply_to_charge after insert or update of status on payments
  for each row execute function apply_payment_to_charge();

-- Gives the credit back when a payment is reversed — an ACH debit can be
-- returned days after it looked successful.
create or replace function reverse_refunded_payment()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- Only reverse a credit that was actually applied. Previously this
  -- fired for any status that was not already 'refunded', so a payment
  -- going straight from 'processing' to 'refunded' — one that never
  -- credited anything — would subtract its amount anyway, silently eating
  -- a *different* payment's credit against the same charge.
  if NEW.status = 'refunded' and OLD.status = 'succeeded'
     and NEW.rent_charge_id is not null then
    update rent_charges
       set amount_paid = greatest(amount_paid - NEW.amount, 0),
           status = case
                       when amount_paid - NEW.amount <= 0 then 'pending'
                       when amount_paid - NEW.amount < amount then 'partial'
                       else 'paid'
                     end
     where id = NEW.rent_charge_id;
  end if;
  return NEW;
end;
$fn$;
