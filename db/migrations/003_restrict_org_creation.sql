-- Locks down who may create an organization.
--
-- Until now any authenticated user could call create_organization() and
-- become the admin of a brand-new org on this server. With signup open,
-- that means anyone who finds the host can help themselves to storage and
-- a foothold — the account itself is harmless, the organization is not.
--
-- This is deliberately an allowlist rather than "only the first user":
-- when this becomes a product for other landlords, the allowlist is
-- replaced by whatever gates signup then (payment, approval, a sales
-- conversation). The boundary needs to exist from the start either way;
-- what changes later is what opens it, not whether it's there.
--
-- Idempotent, safe to re-run.

create table if not exists org_creation_allowlist (
  email      text primary key,
  note       text,
  created_at timestamptz not null default now()
);

-- Never read from a browser: create_organization() is security definer and
-- reads it as the table owner. RLS on with no policy means `authenticated`
-- and `anon` get nothing, which is the intent — knowing who is permitted
-- to create an organization isn't a client's business.
alter table org_creation_allowlist enable row level security;
revoke all on table org_creation_allowlist from public, anon, authenticated;

-- Everyone who is already an admin of an existing org keeps the ability —
-- otherwise this migration would lock the current owner out of their own
-- server. New admins have to be added deliberately, which is the point.
insert into org_creation_allowlist (email, note)
select distinct u.email, 'grandfathered: already an org admin when 003 ran'
  from auth.users u
  join org_members m on m.user_id = u.id
 where m.role = 'admin'
   and u.email is not null
on conflict (email) do nothing;

create or replace function create_organization(org_name text)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  new_id uuid;
  caller_email text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select email into caller_email from auth.users where id = auth.uid();

  if not exists (
    select 1 from org_creation_allowlist
     where lower(email) = lower(caller_email)
  ) then
    -- Deliberately vague to the caller: whether a given address is
    -- permitted isn't something an anonymous signup should be able to
    -- probe for.
    raise exception 'this account is not permitted to create an organization';
  end if;

  insert into organizations (name) values (org_name) returning id into new_id;
  insert into org_members (organization_id, user_id, role, status)
  values (new_id, auth.uid(), 'admin', 'active');

  return new_id;
end;
$fn$;
revoke all on function create_organization(text) from public;
grant execute on function create_organization(text) to authenticated;

-- To let someone new create an organization:
--   insert into org_creation_allowlist (email, note)
--   values ('them@example.com', 'why');
