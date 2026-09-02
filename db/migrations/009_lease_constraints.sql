-- Constraints that were missing, found by writing tests that tried to
-- break things rather than tests that confirmed things work.
--
-- Every one of these accepted nonsense before: a lease ending before it
-- began, a negative deposit, a pet rent of minus fifty dollars, a daily
-- late fee starting on day -3. None would have been caught until the
-- money came out wrong.
--
-- Idempotent, safe to re-run. Written as DO blocks because
-- `alter table ... add constraint` has no IF NOT EXISTS.

do $$
begin
  -- A term that ends before it starts is never a typo worth honouring.
  -- end_date stays nullable: null means month-to-month.
  if not exists (select 1 from pg_constraint where conname = 'leases_term_order_check') then
    alter table leases add constraint leases_term_order_check
      check (end_date is null or end_date >= start_date);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_pet_deposit_check') then
    alter table leases add constraint leases_pet_deposit_check
      check (pet_deposit_amount is null or pet_deposit_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_other_deposit_check') then
    alter table leases add constraint leases_other_deposit_check
      check (other_deposit_amount is null or other_deposit_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_nonrefundable_fee_check') then
    alter table leases add constraint leases_nonrefundable_fee_check
      check (nonrefundable_fee_amount is null or nonrefundable_fee_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_prorated_rent_check') then
    alter table leases add constraint leases_prorated_rent_check
      check (prorated_rent_amount is null or prorated_rent_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_nsf_fee_check') then
    alter table leases add constraint leases_nsf_fee_check
      check (nsf_fee_amount is null or nsf_fee_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_pet_rent_check') then
    alter table leases add constraint leases_pet_rent_check
      check (pet_rent_amount is null or pet_rent_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_daily_late_fee_check') then
    alter table leases add constraint leases_daily_late_fee_check
      check (late_fee_daily_amount is null or late_fee_daily_amount >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'leases_daily_start_check') then
    alter table leases add constraint leases_daily_start_check
      check (late_fee_daily_start_days is null or late_fee_daily_start_days >= 0);
  end if;

  -- A daily amount with no start day would accrue from an undefined
  -- point; a start day with no amount is a rule that charges nothing.
  -- Both are half-configured rather than meaningful.
  if not exists (select 1 from pg_constraint where conname = 'leases_daily_fee_pair_check') then
    alter table leases add constraint leases_daily_fee_pair_check
      check ((late_fee_daily_amount is null) = (late_fee_daily_start_days is null));
  end if;

  -- Charges: an amount paid greater than the amount owed means money was
  -- applied that nobody billed.
  if not exists (select 1 from pg_constraint where conname = 'rent_charges_paid_not_over_check') then
    alter table rent_charges add constraint rent_charges_paid_not_over_check
      check (amount_paid <= amount);
  end if;

  -- Payments: the total debited must be the rent proceeds plus the
  -- processing fee. Anything else means the tenant was charged an amount
  -- that does not correspond to what was recorded against their ledger.
  if not exists (select 1 from pg_constraint where conname = 'payments_total_matches_check') then
    alter table payments add constraint payments_total_matches_check
      check (total_charged = amount + processing_fee_amount);
  end if;
end $$;
