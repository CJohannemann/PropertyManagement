-- A message thread must belong to the organization the message claims.
--
-- can_access_thread took the organization from the row being written and
-- the thread (a lease or job id) as a separate argument, and never checked
-- that the one belonged to the other. The office check passed for anyone
-- who was admin or property manager of the organization named on the row —
-- so a landlord could write a message with their OWN organization_id and
-- another landlord's lease as the thread. The other landlord's tenant then
-- saw it in their lease thread, because is_tenant_of_lease looks only at
-- the lease: a stranger able to post "pay rent to this new account" into
-- a tenant's conversation with their landlord.
--
-- Found by db/test/16-messages.test.sql. Nothing in the app sends messages
-- yet, but the table and its policies are reachable from any client.
--
-- The thread's own organization is checked first, before any role check,
-- so no role in a different organization can reach it.

create or replace function can_access_thread(t_type text, ref uuid, org_id uuid)
returns boolean language plpgsql stable security definer set search_path = public as $fn$
begin
  if t_type = 'lease' then
    if org_id_for_lease(ref) is distinct from org_id then
      return false;
    end if;
  elsif t_type = 'job' then
    if org_id_for_job(ref) is distinct from org_id then
      return false;
    end if;
  else
    return false;
  end if;

  if has_org_role(org_id, array['admin','property_manager']::org_role[]) then
    return true;
  end if;
  if t_type = 'lease' then
    return is_tenant_of_lease(ref);
  end if;
  return is_assigned_technician(ref);
end;
$fn$;
