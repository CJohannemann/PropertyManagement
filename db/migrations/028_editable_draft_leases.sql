-- Correcting a lease that nobody has signed yet.
--
-- RLS has allowed an admin or property manager to update a lease since the
-- schema was written (leases_update). Nothing in the app ever did, so a
-- lease typed with the wrong rent was permanent: the only way out was to
-- delete it, which takes the unit's whole history with it.
--
-- The blocker was never permission, it was the ledger. A lease inserted as
-- 'active' bills its move-in charges immediately (006) and its monthly rent
-- from the next billing run (002, 007). Change rent_amount afterwards and
-- the *next* month bills correctly while everything already generated still
-- says the old figure — the tenant's balance and the lease document
-- disagree, and nothing says which one is wrong.
--
-- So editing is made safe rather than merely allowed: when an UNSIGNED
-- lease's money changes, the charges it generated and nobody has paid are
-- brought back into line with it.
--
-- WHY ONLY UNSIGNED, AND ONLY UNPAID:
--
--   * A signature freezes the terms (013 — the snapshot is the point). A
--     signed lease is an agreement between two people; silently rewriting
--     what it billed is not a correction, it is a rent change, and it
--     belongs in a renewal or an explicit amendment, not in a trigger.
--   * A charge with money against it is a fact about what somebody paid.
--     Restating it would orphan the payment. Those are left exactly as
--     they are, whatever the lease now says.
--
-- Everything outside those two guards — the overwhelmingly common case of
-- "I typed 1025 and the rent is 1250, before anyone has seen it" — is
-- simply made right.
--
-- Idempotent, safe to re-run.

-- ------------------------------------------------------- has it been signed --

-- One answer to "is this lease still a draft", so the trigger below and any
-- later caller cannot drift apart on it. A lease counts as signed the
-- moment ANYONE signs: a tenant who has signed is owed the terms they saw,
-- even before the landlord countersigns.
create or replace function lease_is_signed(target_lease uuid)
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (select 1 from lease_signatures where lease_id = target_lease);
$fn$;

comment on function lease_is_signed(uuid) is
  'True once any party has signed. Draft leases may be corrected freely; signed ones may not.';

-- ------------------------------------------- what a lease says it charges --

-- The two shapes of money a lease generates, each as one expression used
-- everywhere that figure is needed. Extracted because the resync below has
-- to produce exactly what generation produces: any difference between them
-- is a lease whose charges drift every time it is edited, which is worse
-- than the bug this migration exists to fix.

-- What one month costs. Pet rent recurs, so 007 folds it into the rent
-- charge rather than billing a second line; that decision lives here now.
create or replace function monthly_rent_total(l leases)
returns numeric language sql immutable set search_path = public as $fn$
  select l.rent_amount + coalesce(l.pet_rent_amount, 0);
$fn$;

-- The one-off move-in items, as charge type -> amount. 006 has the same
-- list inline; it is restated as a function so the resync cannot bill a
-- deposit under a name generation never uses.
create or replace function move_in_charge_amounts(l leases)
returns table (charge_type text, amount numeric)
language sql immutable set search_path = public as $fn$
  select *
    from (values
      ('prorated_rent',     l.prorated_rent_amount),
      ('security_deposit',  l.deposit_amount),
      ('pet_deposit',       l.pet_deposit_amount),
      ('other_deposit',     l.other_deposit_amount),
      ('nonrefundable_fee', l.nonrefundable_fee_amount)
    ) as t(charge_type, amount);
$fn$;

-- Generation, restated over the helper. Behavior is identical to 007 — the
-- point is that it and the resync now read the same expression.
create or replace function generate_rent_charges(
  for_month date default date_trunc('month', current_date)::date
)
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  insert into rent_charges (lease_id, charge_type, due_date, amount)
  select l.id, 'rent', (for_month + (l.rent_due_day - 1))::date, monthly_rent_total(l)
    from leases l
   where l.status = 'active'
     and (for_month + (l.rent_due_day - 1))::date >= l.start_date
     and (l.end_date is null or (for_month + (l.rent_due_day - 1))::date <= l.end_date)
     -- "already billed anywhere this month", not "on this exact date":
     -- moving a lease's rent_due_day mid-month would otherwise bill the
     -- tenant a second time for the same month.
     and not exists (
       select 1 from rent_charges rc
        where rc.lease_id = l.id
          and rc.charge_type = 'rent'
          and rc.due_date >= for_month
          and rc.due_date < (for_month + interval '1 month')
     );
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function generate_rent_charges(date) from public, authenticated, anon;

-- ------------------------------------------------ bringing the ledger along --

create or replace function resync_draft_lease_charges()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  -- Nothing that bills moved, so there is nothing to reconcile. Most
  -- updates to a lease land here (status, document_url, the many terms that
  -- are printed but never charged) and do no work at all.
  if NEW.rent_amount              is not distinct from OLD.rent_amount
 and NEW.pet_rent_amount          is not distinct from OLD.pet_rent_amount
 and NEW.rent_due_day             is not distinct from OLD.rent_due_day
 and NEW.start_date               is not distinct from OLD.start_date
 and NEW.end_date                 is not distinct from OLD.end_date
 and NEW.prorated_rent_amount     is not distinct from OLD.prorated_rent_amount
 and NEW.deposit_amount           is not distinct from OLD.deposit_amount
 and NEW.pet_deposit_amount       is not distinct from OLD.pet_deposit_amount
 and NEW.other_deposit_amount     is not distinct from OLD.other_deposit_amount
 and NEW.nonrefundable_fee_amount is not distinct from OLD.nonrefundable_fee_amount then
    return NEW;
  end if;

  -- Signed: the charges are what the parties agreed to. Leave them.
  if lease_is_signed(NEW.id) then
    return NEW;
  end if;

  -- ---- the one-off move-in items ----

  -- Dropped when the figure is taken back off the lease. Only ever a
  -- charge nobody has paid against: `amount_paid = 0` is what keeps a
  -- recorded payment from being orphaned by a typo fix.
  delete from rent_charges rc
   using move_in_charge_amounts(NEW) m
   where rc.lease_id = NEW.id
     and rc.charge_type = m.charge_type
     and rc.amount_paid = 0
     and coalesce(m.amount, 0) <= 0;

  update rent_charges rc
     set amount = m.amount,
         due_date = NEW.start_date,
         updated_at = now()
    from move_in_charge_amounts(NEW) m
   where rc.lease_id = NEW.id
     and rc.charge_type = m.charge_type
     and rc.amount_paid = 0
     and m.amount > 0
     and (rc.amount <> m.amount or rc.due_date <> NEW.start_date);

  -- And billed if the edit ADDS one — a deposit remembered after the fact
  -- was previously uncollectable, because 006's trigger only fires on
  -- insert and on the move into 'active'.
  if NEW.status = 'active' then
    insert into rent_charges (lease_id, charge_type, due_date, amount)
    select NEW.id, m.charge_type, NEW.start_date, m.amount
      from move_in_charge_amounts(NEW) m
     where m.amount > 0
    on conflict do nothing;
  end if;

  -- ---- the monthly rent ----

  -- A month billed outside the corrected term should not be owed at all.
  -- Shortening a lease is the common way in: the tenant is leaving in
  -- March, and April's rent has already been generated.
  delete from rent_charges rc
   where rc.lease_id = NEW.id
     and rc.charge_type = 'rent'
     and rc.amount_paid = 0
     and (rc.due_date < NEW.start_date
          or (NEW.end_date is not null and rc.due_date > NEW.end_date));

  -- The rest are restated. A rent charge keeps its month and moves to the
  -- corrected day within it, matching how generate_rent_charges() dedupes
  -- by month — otherwise a due-day fix would leave this month billed on the
  -- old day and every later month on the new one.
  update rent_charges rc
     set amount = monthly_rent_total(NEW),
         due_date = (date_trunc('month', rc.due_date)::date + (NEW.rent_due_day - 1)),
         -- A charge dragged back into the future is no longer late, and one
         -- pushed into the past is — the same rule mark_overdue_charges()
         -- applies, applied now so the two never disagree.
         status = case
                    when (date_trunc('month', rc.due_date)::date + (NEW.rent_due_day - 1))
                         < current_date then 'late' else 'pending'
                  end,
         updated_at = now()
   where rc.lease_id = NEW.id
     and rc.charge_type = 'rent'
     and rc.amount_paid = 0
     and rc.status in ('pending', 'late');

  return NEW;
end;
$fn$;

drop trigger if exists leases_resync_draft_charges on leases;
create trigger leases_resync_draft_charges
  after update on leases
  for each row execute function resync_draft_lease_charges();

comment on function resync_draft_lease_charges() is
  'Keeps an unsigned lease''s unpaid charges equal to the lease. See 028.';
