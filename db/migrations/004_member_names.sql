-- Nothing in the system stored a person's name until now: org_members
-- carries a user_id and a role, and auth.users (which has the email) is
-- not readable from a browser. That was survivable while the UI only ever
-- showed "1 tenant", and stops being survivable the moment a lease
-- document has to name the parties signing it.
--
-- Names live on org_members rather than on a global profile, for the same
-- reason roles do: this is per-organization. A landlord records the
-- tenant's name as it should appear on their lease; that's not a fact
-- about the person's account, and another organization has no business
-- reading it.
--
-- Idempotent, safe to re-run.

alter table org_members add column if not exists full_name text;
alter table invites     add column if not exists full_name text;

-- Carried through the invite so the landlord can type the tenant's name
-- once, when inviting, rather than the tenant having to supply it before
-- their lease can be drawn up. `coalesce` so re-accepting an invite never
-- blanks a name the member has since corrected themselves.
create or replace function accept_invite(invite_token text)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  inv invites%rowtype;
  new_member_id uuid;
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

  insert into org_members (organization_id, user_id, role, status, invited_by, full_name)
  values (inv.organization_id, auth.uid(), inv.role, 'active', inv.created_by, inv.full_name)
  on conflict (organization_id, user_id)
    do update set status = 'active',
                  role = excluded.role,
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

create or replace function create_invite(
  invite_email text,
  wanted_role org_role,
  wanted_lease_id uuid default null,
  invite_full_name text default null
)
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
    insert into invites (organization_id, email, role, lease_id, token, created_by, full_name)
    values (caller.organization_id, invite_email, wanted_role, wanted_lease_id, new_token,
            caller.id, nullif(btrim(coalesce(invite_full_name, '')), ''))
    returning invites.token, invites.expires_at;
end;
$fn$;
revoke all on function create_invite(text, org_role, uuid, text) from public;
grant execute on function create_invite(text, org_role, uuid, text) to authenticated;

-- The 3-argument version this replaces. Dropped rather than left in place:
-- PostgREST resolves overloads by the argument names it is given, and two
-- candidates differing only by a defaulted trailing parameter is exactly
-- the shape that produces an ambiguous-function error at runtime.
drop function if exists create_invite(text, org_role, uuid);

-- Correcting your own name. An RPC rather than an RLS policy because RLS
-- is row-level: a policy letting someone update their own org_members row
-- would also let them change their own role, which is a privilege
-- escalation, not a profile edit.
create or replace function set_my_full_name(new_name text)
returns void
language plpgsql security definer set search_path = public as $fn$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  update org_members
     set full_name = nullif(btrim(coalesce(new_name, '')), '')
   where user_id = auth.uid();
end;
$fn$;
revoke all on function set_my_full_name(text) from public;
grant execute on function set_my_full_name(text) to authenticated;

-- Admins and property managers naming someone in their own organization —
-- for a tenant who was added before names existed, or a typo on a lease.
create or replace function set_member_full_name(target_member_id uuid, new_name text)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  target org_members%rowtype;
begin
  select * into target from org_members where id = target_member_id;
  if target.id is null then
    raise exception 'no such member';
  end if;
  if not has_org_role(target.organization_id,
                      array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can rename a member';
  end if;

  update org_members
     set full_name = nullif(btrim(coalesce(new_name, '')), '')
   where id = target_member_id;
end;
$fn$;
revoke all on function set_member_full_name(uuid, text) from public;
grant execute on function set_member_full_name(uuid, text) to authenticated;
