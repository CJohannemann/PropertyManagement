-- create_invite() failed at runtime with:
--   function gen_random_bytes(integer) does not exist
--
-- gen_random_bytes comes from pgcrypto, and the supabase/postgres image
-- installs pgcrypto into an `extensions` schema rather than `public`.
-- The function declares `set search_path = public`, so pgcrypto's
-- functions were not on the path and token minting failed — while
-- gen_random_uuid() kept working throughout, because that one is built
-- into Postgres core (PG13+) rather than provided by pgcrypto, which is
-- why every table default was fine and only this broke.
--
-- Fixed by putting both schemas on the path: `extensions` for a Supabase
-- install, `public` for a plain Postgres one where pgcrypto lands there
-- instead. Naming both keeps this working on either.
--
-- Idempotent (create or replace), safe to run again.

create or replace function create_invite(invite_email text, wanted_role org_role, wanted_lease_id uuid default null)
returns table(token text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $fn$
declare
  caller org_members%rowtype;
  new_token text;
  lease_org uuid;
begin
  select * into caller from org_members
   where user_id = auth.uid() and status = 'active' and role in ('admin', 'property_manager')
   limit 1;
  if caller.id is null then
    raise exception 'only an admin or property manager can send invites';
  end if;

  -- A property manager may only invite tenants; admin can invite anyone.
  if caller.role = 'property_manager' and wanted_role <> 'tenant' then
    raise exception 'property managers can only invite tenants';
  end if;

  if wanted_role = 'tenant' then
    if wanted_lease_id is null then
      raise exception 'a tenant invite must be bound to a lease';
    end if;
    select org_id_for_lease(wanted_lease_id) into lease_org;
    if lease_org is distinct from caller.organization_id then
      raise exception 'that lease does not belong to your organization';
    end if;
  end if;

  new_token := encode(gen_random_bytes(16), 'hex');

  return query
    insert into invites (organization_id, email, role, lease_id, token, created_by)
    values (caller.organization_id, invite_email, wanted_role, wanted_lease_id, new_token, caller.id)
    returning invites.token, invites.expires_at;
end;
$fn$;
revoke all on function create_invite(text, org_role, uuid) from public;
grant execute on function create_invite(text, org_role, uuid) to authenticated;
