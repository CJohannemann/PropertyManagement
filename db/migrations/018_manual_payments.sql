-- Recording rent that arrived outside the app.
--
-- Until now nothing could tell this system a tenant had paid. `payments`
-- has no client-facing insert policy on purpose — only the Stripe webhook
-- writes it, so a compromised browser cannot declare its own rent paid —
-- and no other path existed. A landlord handed a cheque had no way to say
-- so: the charge stayed unpaid, went overdue, and on any lease with
-- late_fee_auto_apply on it started billing late fees for money already
-- in their hand.
--
-- That invariant is worth keeping, so this does NOT open `payments` to
-- client writes. It adds a security-definer function that checks the
-- caller is an admin or property manager of the organization that owns the
-- charge, and records the payment on their behalf. A tenant still cannot
-- mark their own rent paid; the landlord asserting they received money is
-- a different claim from the tenant asserting they sent it.
--
-- Idempotent, safe to re-run.

-- Methods money actually arrives by. 'ach' and 'card' stay reserved for
-- Stripe; everything else is something a person recorded by hand.
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'payments_method_check') then
    alter table payments drop constraint payments_method_check;
  end if;
  alter table payments add constraint payments_method_check
    check (method in ('ach', 'card', 'cash', 'check', 'bank_transfer', 'other'));
end $$;

-- Who paid becomes optional. A deposit is often handed over at signing,
-- before the tenant has accepted their invite and has an org_members row
-- to point at — requiring one would block recording money that has
-- genuinely arrived. The lease is what the charge hangs off; the person is
-- useful detail, not the identity of the payment.
alter table payments alter column tenant_member_id drop not null;

-- A cheque number, a Zelle reference, "left in the dropbox" — whatever
-- makes this findable again in six months.
alter table payments add column if not exists note text;

-- Who recorded it. A payment nobody wrote down is a payment nobody can be
-- asked about.
alter table payments add column if not exists recorded_by uuid references org_members(id);

comment on column payments.recorded_by is
  'The member who recorded this by hand. Null for Stripe payments, which nobody recorded.';

-- Records money received against a charge. Returns the new payment id.
create or replace function record_manual_payment(
  charge      uuid,
  amount      numeric,
  method      text,
  paid_on     date default current_date,
  note        text default null,
  tenant      uuid default null
)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  ch          rent_charges%rowtype;
  org         uuid;
  me          uuid;
  who         uuid;
  still_owed  numeric;
  new_payment uuid;
begin
  select * into ch from rent_charges where id = charge;
  if ch.id is null then
    raise exception 'no such charge';
  end if;

  org := org_id_for_lease(ch.lease_id);
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can record a payment';
  end if;

  -- Stripe owns its own method values; recording one by hand would put a
  -- payment in the ledger that no Stripe record backs.
  if method not in ('cash', 'check', 'bank_transfer', 'other') then
    raise exception 'method must be cash, check, bank_transfer or other';
  end if;

  if amount is null or amount <= 0 then
    raise exception 'a payment must be for more than zero';
  end if;

  still_owed := ch.amount - ch.amount_paid;
  if amount > still_owed then
    -- rent_charges_paid_not_over_check would refuse this anyway; saying
    -- what is actually owed is more use than a constraint name.
    raise exception 'that charge only has % outstanding', to_char(still_owed, 'FM999999990.00');
  end if;

  -- Attribute it to the tenant given, else the lease's primary tenant,
  -- else nobody.
  if tenant is not null then
    if not exists (select 1 from lease_tenants
                    where lease_id = ch.lease_id and org_member_id = tenant) then
      raise exception 'that person is not a tenant on this lease';
    end if;
    who := tenant;
  else
    select lt.org_member_id into who
      from lease_tenants lt
     where lt.lease_id = ch.lease_id
     order by lt.is_primary desc
     limit 1;
  end if;

  me := get_my_member_id(org);

  -- status 'succeeded' immediately: unlike a bank transfer in flight, the
  -- money is already in the landlord's hand when they record it. The
  -- insert trigger credits the charge (see 017_payment_triggers.sql).
  insert into payments (lease_id, tenant_member_id, rent_charge_id, amount,
                        processing_fee_amount, total_charged, method, status,
                        paid_at, note, recorded_by)
  values (ch.lease_id, who, ch.id, amount, 0, amount, method, 'succeeded',
          paid_on::timestamptz, note, me)
  returning id into new_payment;

  return new_payment;
end;
$fn$;
revoke all on function record_manual_payment(uuid, numeric, text, date, text, uuid) from public;
grant execute on function record_manual_payment(uuid, numeric, text, date, text, uuid) to authenticated;

-- Undoes one, for the inevitable typo. Reverses through the same path a
-- refund takes, so the charge gets its balance back.
create or replace function void_manual_payment(payment uuid)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  p   payments%rowtype;
  org uuid;
begin
  select * into p from payments where id = payment;
  if p.id is null then
    raise exception 'no such payment';
  end if;

  org := org_id_for_lease(p.lease_id);
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can void a payment';
  end if;

  -- A Stripe payment must be refunded at Stripe, which then tells us
  -- through the webhook. Voiding one here would credit the tenant back in
  -- this ledger while their money stayed moved, and the two would never
  -- agree again.
  if p.method in ('ach', 'card') then
    raise exception 'that payment came through Stripe — refund it in Stripe instead';
  end if;

  if p.status = 'refunded' then
    return; -- already undone; saying so twice helps nobody
  end if;

  update payments set status = 'refunded' where id = payment;
end;
$fn$;
revoke all on function void_manual_payment(uuid) from public;
grant execute on function void_manual_payment(uuid) to authenticated;
