-- "Rent payment received" says who paid, for what, and how.
--
-- 023's alert read "1160.00 by ach": no name, no unit, a bare number and
-- Stripe's internal method code. A landlord with several tenants had to go
-- and look up which one it was. Now it reads, for example:
--
--   Denia paid $1,160.00 by bank transfer · Forrest · Unit 2
--
-- The name is the tenant's org_members.full_name, falling back to their
-- sign-in email, then to "A tenant" — a payment is never left unattributed
-- just because a profile is incomplete.
--
-- Only the wording changes; when it fires (the transition into
-- 'succeeded', once per payment) is exactly as 023 set it.
--
-- Idempotent, safe to re-run.

create or replace function notify_payment_received()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  org    uuid;
  payer  text;
  place  text;
  how    text;
begin
  if NEW.status <> 'succeeded' then
    return NEW;
  end if;
  if TG_OP = 'UPDATE' and OLD.status = 'succeeded' then
    return NEW;
  end if;

  org := org_id_for_lease(NEW.lease_id);

  select coalesce(nullif(trim(om.full_name), ''), u.email, 'A tenant')
    into payer
    from org_members om
    left join auth.users u on u.id = om.user_id
   where om.id = NEW.tenant_member_id;

  select p.name || coalesce(' · ' || un.label, '')
    into place
    from leases l
    join units un on un.id = l.unit_id
    join properties p on p.id = un.property_id
   where l.id = NEW.lease_id;

  how := case NEW.method
           when 'ach'           then 'bank transfer'
           when 'bank_transfer' then 'bank transfer'
           when 'card'          then 'card'
           when 'cash'          then 'cash'
           when 'check'         then 'check'
           else 'other means'
         end;

  insert into notifications (organization_id, kind, urgency, title, body, link)
  values (org, 'payment_received', 'low', 'Rent payment received',
          coalesce(payer, 'A tenant') || ' paid '
            || to_char(NEW.amount, 'FM$999,999,990.00') || ' by ' || how
            || coalesce(' · ' || place, ''),
          '/rent');
  return NEW;
end;
$fn$;
