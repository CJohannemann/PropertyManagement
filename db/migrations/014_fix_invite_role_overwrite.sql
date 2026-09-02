-- accept_invite() demoted existing members.
--
-- Reported from real use: the owner opened a tenant invite link himself to
-- see what a tenant would see, and became a tenant of his own
-- organization — losing admin, gaining a lease, and being billed rent.
--
-- The cause was the upsert's conflict clause. org_members is unique on
-- (organization_id, user_id), so accepting any invite as an existing
-- member hit the conflict and ran `do update set role = excluded.role`,
-- overwriting whatever role they already had. Opening an invite link to
-- check it is an obvious thing to do, and the app answered by silently
-- taking away the owner's access to their own data.
--
-- An invite now never changes an existing member's role. It is not a
-- role-change mechanism — update_org_member_role() is, and it is
-- admin-only and refuses to let an admin demote themselves. This closes
-- the same door from the other side.
--
-- Idempotent, safe to re-run.

create or replace function accept_invite(invite_token text)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  inv                 invites%rowtype;
  existing            org_members%rowtype;
  new_member_id       uuid;
  already_has_primary boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into inv from invites
   where token = invite_token and status = 'pending' and expires_at > now()
   for update;
  if inv.id is null then
    raise exception 'that invite is invalid, expired, or already used';
  end if;

  select * into existing from org_members
   where organization_id = inv.organization_id and user_id = auth.uid();

  -- Already in this organization as something else. Refuse rather than
  -- convert: the overwhelmingly likely case is a manager opening an
  -- invite to check it, and the cost of guessing wrong is that they lose
  -- their own access. The invite stays pending so the person it was meant
  -- for can still use it.
  if existing.id is not null and existing.role <> inv.role then
    raise exception
      'You are already % in this organization, so this invite cannot be accepted here. Open it in the account it was sent to, or in a private window.',
      case existing.role
        when 'admin' then 'an admin'
        when 'property_manager' then 'a property manager'
        when 'technician' then 'a technician'
        else 'a tenant'
      end;
  end if;

  insert into org_members (organization_id, user_id, role, status, invited_by, full_name)
  values (inv.organization_id, auth.uid(), inv.role, 'active', inv.created_by, inv.full_name)
  on conflict (organization_id, user_id)
    -- Reactivates a disabled member and fills in a missing name. Notably
    -- does NOT touch role: reaching here means the role already matches.
    do update set status = 'active',
                  full_name = coalesce(org_members.full_name, excluded.full_name)
  returning id into new_member_id;

  if inv.role = 'tenant' and inv.lease_id is not null then
    select exists(select 1 from lease_tenants where lease_id = inv.lease_id and is_primary)
      into already_has_primary;
    insert into lease_tenants (lease_id, org_member_id, is_primary)
    values (inv.lease_id, new_member_id, not already_has_primary)
    on conflict (lease_id, org_member_id) do nothing;
  end if;

  update invites set status = 'accepted' where id = inv.id;

  return inv.organization_id;
end;
$fn$;
revoke all on function accept_invite(text) from public;
grant execute on function accept_invite(text) to authenticated;

-- ------------------------------------------------------------- repair --

-- Put back what the bug took away, for anyone already affected.
--
-- An organization with no active admin is the signature of this: every
-- organization is created with one, by create_organization(), and nothing
-- else demotes them. The earliest member is the person who created it.
do $$
declare
  org_row      record;
  restored     uuid;
  detached     int;
begin
  for org_row in
    select o.id, o.name from organizations o
     where not exists (
       select 1 from org_members m
        where m.organization_id = o.id and m.role = 'admin' and m.status = 'active')
  loop
    update org_members
       set role = 'admin', status = 'active'
     where id = (
       select id from org_members
        where organization_id = org_row.id
        order by created_at
        limit 1)
    returning id into restored;

    if restored is not null then
      raise notice 'Restored admin on organization "%" (member %)', org_row.name, restored;
    end if;
  end loop;

  -- And take them back off any lease they were attached to by accepting a
  -- tenant invite. An admin is not a tenant of their own lease; the rent
  -- charges themselves are left alone, since they belong to the lease and
  -- are owed by whoever actually moves in.
  delete from lease_tenants lt
   using org_members m
   where m.id = lt.org_member_id and m.role = 'admin';
  get diagnostics detached = row_count;
  if detached > 0 then
    raise notice 'Removed % admin(s) from leases they were wrongly attached to', detached;
  end if;
end $$;
