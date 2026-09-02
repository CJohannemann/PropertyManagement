-- Property Management — initial Postgres schema
-- Targets Supabase (auth.users assumed present — GoTrue must have bootstrapped
-- the auth schema before this runs; see FarmHand's deploy/selfhost/README.md
-- for the self-hosted bring-up order, which this project will mirror).
--
-- Multi-tenant from day one: every table hangs off `organizations`, even
-- though there is exactly one organization at launch (Chris's own rentals).
-- Retrofitting multi-tenancy later is a bigger job than including it now.
-- See docs/domain-model.md for the design discussion behind every choice
-- below — this file is the implementation of that doc, not a new design.

create extension if not exists "pgcrypto";

-- ===================================================================
-- Enums
-- ===================================================================

-- Only the two truly closed, logic-driving sets get real enums. Everything
-- else (statuses, categories) is text + check, so adding a new category
-- later is a one-line ALTER instead of an ALTER TYPE.
create type org_role as enum ('admin', 'property_manager', 'technician', 'tenant');
create type member_status as enum ('invited', 'active', 'disabled');

-- ===================================================================
-- Tables
-- ===================================================================

-- ---------------------------------------------------------------- tenancy --

create table organizations (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  stripe_connect_account_id text,
  created_at               timestamptz not null default now()
);

-- Every person who logs in — including tenants — has a row here. Role and
-- status live on the membership, not the user, so the same person could
-- hold different roles in different organizations later, and removing
-- someone is a status flip (disabled), never a delete: their history
-- (payments, job entries, messages) all FKs to this row, not to
-- auth.users directly, and must survive them leaving.
create table org_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  role            org_role not null,
  status          member_status not null default 'invited',
  invited_by      uuid references org_members(id) on delete set null,
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index on org_members (organization_id, role);
create index on org_members (user_id);

-- ------------------------------------------------------------- properties --

create table properties (
  id             uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name           text not null,
  address_line1  text not null,
  city           text not null,
  state          text not null check (state = upper(state) and char_length(state) = 2),
  zip            text not null,
  purchase_date  date,
  notes          text,
  created_at     timestamptz not null default now()
);
create index on properties (organization_id);
create index on properties (state);

-- A property has 1..N units. 3 houses / 9 units is the normal case here,
-- not an edge case.
create table units (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null references properties(id) on delete cascade,
  label       text not null,
  bedrooms    numeric,
  bathrooms   numeric,
  sqft        numeric,
  status      text not null default 'vacant'
                check (status in ('vacant', 'occupied', 'maintenance')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (property_id, label)
);
create index on units (property_id);

-- ----------------------------------------------------------------- leases --

create table leases (
  id                   uuid primary key default gen_random_uuid(),
  unit_id              uuid not null references units(id) on delete cascade,
  start_date           date not null,
  end_date             date,
  rent_amount          numeric(10,2) not null check (rent_amount > 0),
  rent_due_day         int not null check (rent_due_day between 1 and 28),
  deposit_amount       numeric(10,2) not null default 0 check (deposit_amount >= 0),
  status               text not null default 'pending'
                         check (status in ('pending', 'active', 'ended')),
  document_url         text,
  -- Late-fee terms are per-lease, off by default. See the
  -- enforce_late_fee_limits trigger below — these fields are validated
  -- against state_rent_regulations, not trusted as free input.
  late_fee_auto_apply  boolean not null default false,
  late_fee_type        text check (late_fee_type in ('flat', 'percent')),
  late_fee_amount      numeric(10,2) check (late_fee_amount >= 0),
  late_fee_grace_days  int check (late_fee_grace_days >= 0),
  -- Who eats the Stripe processing fee at checkout. Defaults to the safe
  -- (landlord-pays) option; the trigger only allows 'tenant' once the
  -- property's state is verified to permit it.
  fee_payer            text not null default 'landlord'
                         check (fee_payer in ('landlord', 'tenant')),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on leases (unit_id);
create index on leases (status);

-- Join table — supports multiple tenants (roommates/spouses) on one lease.
create table lease_tenants (
  id            uuid primary key default gen_random_uuid(),
  lease_id      uuid not null references leases(id) on delete cascade,
  org_member_id uuid not null references org_members(id) on delete cascade,
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  unique (lease_id, org_member_id)
);
create index on lease_tenants (org_member_id);

-- --------------------------------------------------------------- billing --

-- The billing ledger — one row generated per lease per period (rent), plus
-- ad hoc rows for late fees / other charges.
create table rent_charges (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id) on delete cascade,
  charge_type text not null default 'rent'
                check (charge_type in ('rent', 'late_fee', 'other')),
  due_date    date not null,
  amount      numeric(10,2) not null check (amount >= 0),
  -- Accumulates as `payments` rows land against this charge (see the
  -- apply_payment_to_charge trigger below), so a tenant paying rent in
  -- two installments is a normal, supported case, not a workaround.
  amount_paid numeric(10,2) not null default 0 check (amount_paid >= 0),
  status      text not null default 'pending'
                check (status in ('pending', 'partial', 'paid', 'late')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on rent_charges (lease_id, due_date);
create index on rent_charges (status);

create table payments (
  id                     uuid primary key default gen_random_uuid(),
  lease_id               uuid not null references leases(id) on delete cascade,
  tenant_member_id       uuid not null references org_members(id),
  rent_charge_id         uuid references rent_charges(id) on delete set null,
  -- amount = landlord's rent proceeds; processing_fee_amount = Stripe's
  -- cut (passed to the tenant when the lease's fee_payer = 'tenant');
  -- total_charged = the two summed, what's actually debited from the
  -- tenant. Kept separate so the rent ledger above never gets polluted
  -- by the fee, and the tenant sees an itemized breakdown at checkout.
  amount                 numeric(10,2) not null check (amount >= 0),
  processing_fee_amount  numeric(10,2) not null default 0 check (processing_fee_amount >= 0),
  total_charged          numeric(10,2) not null check (total_charged >= 0),
  method                 text not null check (method in ('ach', 'card')),
  stripe_payment_intent_id text unique,
  status                 text not null default 'pending'
                           check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  paid_at                timestamptz,
  created_at             timestamptz not null default now()
);
create index on payments (lease_id);
create index on payments (tenant_member_id);

-- ------------------------------------------------------------ maintenance --

-- Tenant-initiated service requests.
create table maintenance_requests (
  id          uuid primary key default gen_random_uuid(),
  unit_id     uuid not null references units(id) on delete cascade,
  submitted_by uuid not null references org_members(id),
  category    text not null default 'other'
                check (category in ('plumbing', 'electrical', 'appliance',
                                     'hvac', 'pest', 'structural', 'other')),
  description text not null,
  priority    text not null default 'normal'
                check (priority in ('low', 'normal', 'high', 'urgent')),
  status      text not null default 'open'
                check (status in ('open', 'assigned', 'in_progress', 'completed', 'closed')),
  photo_urls  text[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index on maintenance_requests (unit_id);
create index on maintenance_requests (status);

-- Work orders — may originate from a tenant request or be created directly
-- (proactive maintenance, not tenant-initiated).
create table maintenance_jobs (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id) on delete cascade,
  property_id            uuid not null references properties(id) on delete cascade,
  unit_id                uuid references units(id) on delete cascade,
  request_id             uuid references maintenance_requests(id) on delete set null,
  assigned_technician_id uuid references org_members(id),
  status                 text not null default 'scheduled'
                           check (status in ('scheduled', 'in_progress', 'completed', 'canceled')),
  scheduled_date         date,
  completed_date         date,
  notes                  text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index on maintenance_jobs (organization_id);
create index on maintenance_jobs (assigned_technician_id);
create index on maintenance_jobs (property_id);

-- What the technician actually logs against a job: labor time, mileage,
-- materials.
create table job_entries (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references maintenance_jobs(id) on delete cascade,
  technician_id uuid not null references org_members(id),
  entry_type    text not null check (entry_type in ('labor', 'mileage', 'material', 'note')),
  description   text,
  hours         numeric(6,2),
  miles         numeric(8,2),
  cost          numeric(10,2),
  created_at    timestamptz not null default now()
);
create index on job_entries (job_id);

-- Photo capture of a purchase, tied to a job (and optionally a specific
-- entry).
create table receipts (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references maintenance_jobs(id) on delete cascade,
  entry_id    uuid references job_entries(id) on delete set null,
  uploaded_by uuid not null references org_members(id),
  image_url   text not null,
  vendor      text,
  amount      numeric(10,2),
  created_at  timestamptz not null default now()
);
create index on receipts (job_id);

-- Which properties a technician can see/be assigned jobs on. Zero rows for
-- a technician = no access (safe default); a row with property_id = null
-- means "all properties in the org." Admin/PM grants access explicitly —
-- some technicians handle everything, others only the property they
-- already know.
create table technician_property_access (
  id            uuid primary key default gen_random_uuid(),
  org_member_id uuid not null references org_members(id) on delete cascade,
  property_id   uuid references properties(id) on delete cascade,
  created_at    timestamptz not null default now()
);
-- A plain unique(org_member_id, property_id) would let multiple
-- property_id = null ("all properties") rows through, since standard
-- unique constraints treat nulls as distinct — these two partial indexes
-- close that gap instead.
create unique index technician_property_access_all_uidx
  on technician_property_access (org_member_id) where property_id is null;
create unique index technician_property_access_specific_uidx
  on technician_property_access (org_member_id, property_id) where property_id is not null;

-- -------------------------------------------------------- communication --

-- Threaded communication. Two thread types: PM<->tenant (scoped to a
-- lease) and PM<->technician (scoped to a job).
create table messages (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  thread_type     text not null check (thread_type in ('lease', 'job')),
  thread_ref_id   uuid not null,
  sender_id       uuid not null references org_members(id),
  body            text not null,
  created_at      timestamptz not null default now(),
  read_at         timestamptz
);
create index on messages (organization_id, thread_type, thread_ref_id);

-- ------------------------------------------------------- invites & files --

create table invites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email           text not null,
  role            org_role not null,
  -- Set when inviting a tenant, so the invite is pre-bound to their unit
  -- and accept_invite() can attach them to the right lease automatically.
  lease_id        uuid references leases(id) on delete cascade,
  token           text not null unique,
  status          text not null default 'pending'
                    check (status in ('pending', 'accepted', 'expired', 'revoked')),
  created_by      uuid not null references org_members(id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '7 days')
);
create index on invites (organization_id);
create index invites_pending_token_idx on invites (token) where status = 'pending';

-- Generic file attachments (signed leases, insurance, W9s).
create table documents (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  related_type    text not null check (related_type in ('lease', 'property', 'unit', 'job')),
  related_id      uuid not null,
  url             text not null,
  label           text,
  uploaded_by     uuid not null references org_members(id),
  created_at      timestamptz not null default now()
);
create index on documents (organization_id, related_type, related_id);

-- ------------------------------------------------------- legal reference --

-- Platform-wide reference data, not org-owned — one row per state, kept as
-- data so a new state is a seed insert, not a code change. Absence of a
-- row means "unverified": the enforce_late_fee_limits trigger below fails
-- safe (blocks auto late fees and tenant-paid processing fees) rather than
-- assuming Kentucky's numbers or assuming no limit applies. This is legal
-- reference data, not legal advice — a compliance pass is expected before
-- onboarding landlords in a newly-added state.
create table state_rent_regulations (
  id                                  uuid primary key default gen_random_uuid(),
  state_code                          text not null unique
                                        check (state_code = upper(state_code) and char_length(state_code) = 2),
  max_late_fee_type                   text check (max_late_fee_type in ('percent', 'flat', 'none')),
  max_late_fee_value                  numeric(10,2),
  min_grace_days                      int not null default 0,
  -- null = unknown/unverified, not "not allowed" — distinct from false.
  tenant_paid_processing_fee_allowed  boolean,
  source_citation                     text,
  last_verified_at                    date,
  created_at                          timestamptz not null default now()
);

-- ===================================================================
-- Helper functions (read-only, used throughout RLS policies below)
-- ===================================================================

create or replace function has_org_role(org_id uuid, roles org_role[])
returns boolean language sql stable security definer as $fn$
  select exists (
    select 1 from org_members
    where organization_id = org_id and user_id = auth.uid()
      and role = any(roles) and status = 'active'
  );
$fn$;

create or replace function is_org_member(org_id uuid)
returns boolean language sql stable security definer as $fn$
  select exists (
    select 1 from org_members
    where organization_id = org_id and user_id = auth.uid() and status = 'active'
  );
$fn$;

create or replace function get_my_member_id(org_id uuid)
returns uuid language sql stable security definer as $fn$
  select id from org_members
   where organization_id = org_id and user_id = auth.uid() and status = 'active'
   limit 1;
$fn$;

create or replace function org_id_for_property(p uuid)
returns uuid language sql stable security definer as $fn$
  select organization_id from properties where id = p;
$fn$;

create or replace function org_id_for_unit(u uuid)
returns uuid language sql stable security definer as $fn$
  select p.organization_id from units join properties p on p.id = units.property_id
   where units.id = u;
$fn$;

create or replace function org_id_for_lease(l uuid)
returns uuid language sql stable security definer as $fn$
  select p.organization_id
    from leases join units on units.id = leases.unit_id
                join properties p on p.id = units.property_id
   where leases.id = l;
$fn$;

create or replace function org_id_for_job(j uuid)
returns uuid language sql stable security definer as $fn$
  select organization_id from maintenance_jobs where id = j;
$fn$;

create or replace function org_id_for_member(m uuid)
returns uuid language sql stable security definer as $fn$
  select organization_id from org_members where id = m;
$fn$;

create or replace function technician_has_property_access(p uuid)
returns boolean language sql stable security definer as $fn$
  select exists (
    select 1 from org_members om
    join technician_property_access tpa on tpa.org_member_id = om.id
    where om.user_id = auth.uid() and om.status = 'active'
      and om.organization_id = org_id_for_property(p)
      and (tpa.property_id = p or tpa.property_id is null)
  );
$fn$;

create or replace function is_tenant_of_lease(l uuid)
returns boolean language sql stable security definer as $fn$
  select exists (
    select 1 from lease_tenants lt
    join org_members om on om.id = lt.org_member_id
    where lt.lease_id = l and om.user_id = auth.uid() and om.status = 'active'
  );
$fn$;

create or replace function is_assigned_technician(j uuid)
returns boolean language sql stable security definer as $fn$
  select exists (
    select 1 from maintenance_jobs mj
    join org_members om on om.id = mj.assigned_technician_id
    where mj.id = j and om.user_id = auth.uid() and om.status = 'active'
  );
$fn$;

create or replace function can_access_thread(t_type text, ref uuid, org_id uuid)
returns boolean language plpgsql stable security definer as $fn$
begin
  if has_org_role(org_id, array['admin','property_manager']::org_role[]) then
    return true;
  end if;
  if t_type = 'lease' then
    return is_tenant_of_lease(ref);
  elsif t_type = 'job' then
    return is_assigned_technician(ref);
  end if;
  return false;
end;
$fn$;

-- ===================================================================
-- Bootstrap & invite functions (security definer — see FarmHand's
-- create_farm/create_invite/redeem_invite for the same chicken-and-egg
-- reasoning: you can't satisfy an RLS policy that checks membership in an
-- org that doesn't exist yet, or join an org you're not a member of yet).
-- ===================================================================

create or replace function create_organization(org_name text)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  insert into organizations (name) values (org_name) returning id into new_id;
  insert into org_members (organization_id, user_id, role, status)
  values (new_id, auth.uid(), 'admin', 'active');

  return new_id;
end;
$fn$;
revoke all on function create_organization(text) from public;
grant execute on function create_organization(text) to authenticated;

-- search_path names `extensions` as well as `public` because this needs
-- pgcrypto's gen_random_bytes, and the supabase/postgres image installs
-- pgcrypto into an `extensions` schema while a plain Postgres install puts
-- it in `public`. Naming both works on either. (gen_random_uuid(), used
-- for every table default above, is Postgres core rather than pgcrypto and
-- needs none of this.) See db/migrations/001_invite_token_search_path.sql.
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

  insert into org_members (organization_id, user_id, role, status, invited_by)
  values (inv.organization_id, auth.uid(), inv.role, 'active', inv.created_by)
  on conflict (organization_id, user_id)
    do update set status = 'active', role = excluded.role
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

create or replace function revoke_invite(target_invite_id uuid)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  inv invites%rowtype;
  caller org_members%rowtype;
begin
  select * into inv from invites where id = target_invite_id;
  if inv.id is null then
    raise exception 'invite not found';
  end if;

  select * into caller from org_members
   where user_id = auth.uid() and organization_id = inv.organization_id
     and status = 'active' and role in ('admin', 'property_manager')
   limit 1;
  if caller.id is null then
    raise exception 'only an admin or property manager can revoke invites';
  end if;
  if caller.role = 'property_manager' and inv.role <> 'tenant' then
    raise exception 'property managers can only revoke tenant invites';
  end if;

  update invites set status = 'revoked' where id = inv.id;
end;
$fn$;
revoke all on function revoke_invite(uuid) from public;
grant execute on function revoke_invite(uuid) to authenticated;

create or replace function update_org_member_role(target_member_id uuid, new_role org_role)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  caller org_members%rowtype;
  target org_members%rowtype;
begin
  select * into target from org_members where id = target_member_id;
  select * into caller from org_members
   where user_id = auth.uid() and organization_id = target.organization_id
     and status = 'active' and role = 'admin'
   limit 1;
  if caller.id is null then
    raise exception 'only an admin can change member roles';
  end if;
  if target.id = caller.id then
    raise exception 'an admin cannot change their own role';
  end if;

  update org_members set role = new_role where id = target_member_id;
end;
$fn$;
revoke all on function update_org_member_role(uuid, org_role) from public;
grant execute on function update_org_member_role(uuid, org_role) to authenticated;

create or replace function set_org_member_status(target_member_id uuid, new_status member_status)
returns void
language plpgsql security definer set search_path = public as $fn$
declare
  caller org_members%rowtype;
  target org_members%rowtype;
begin
  select * into target from org_members where id = target_member_id;
  select * into caller from org_members
   where user_id = auth.uid() and organization_id = target.organization_id
     and status = 'active' and role = 'admin'
   limit 1;
  if caller.id is null then
    raise exception 'only an admin can change member status';
  end if;
  if target.id = caller.id then
    raise exception 'an admin cannot disable themself';
  end if;

  update org_members set status = new_status where id = target_member_id;
end;
$fn$;
revoke all on function set_org_member_status(uuid, member_status) from public;
grant execute on function set_org_member_status(uuid, member_status) to authenticated;

-- ===================================================================
-- Triggers
-- ===================================================================

create or replace function set_updated_at()
returns trigger language plpgsql as $fn$
begin
  NEW.updated_at = now();
  return NEW;
end;
$fn$;

create trigger units_set_updated_at before update on units
  for each row execute function set_updated_at();
create trigger leases_set_updated_at before update on leases
  for each row execute function set_updated_at();
create trigger rent_charges_set_updated_at before update on rent_charges
  for each row execute function set_updated_at();
create trigger maintenance_requests_set_updated_at before update on maintenance_requests
  for each row execute function set_updated_at();
create trigger maintenance_jobs_set_updated_at before update on maintenance_jobs
  for each row execute function set_updated_at();

-- Enforces docs/domain-model.md's "fail safe on unverified state" rule:
-- a lease can only turn on auto-applied late fees or tenant-paid
-- processing fees once its property's state has a verified row in
-- state_rent_regulations, and even then only within that state's caps.
-- Kentucky (KRS 383.565: max 10% of rent, 5-day grace minimum) is the
-- first verified row — see seed.sql.
create or replace function enforce_late_fee_limits()
returns trigger language plpgsql as $fn$
declare
  st               text;
  reg              state_rent_regulations%rowtype;
  effective_amount numeric;  -- this lease's late fee, normalized to dollars
begin
  select p.state into st
    from units u join properties p on p.id = u.property_id
   where u.id = NEW.unit_id;

  select * into reg from state_rent_regulations where state_code = st;

  if reg.id is null then
    if NEW.late_fee_auto_apply or NEW.fee_payer = 'tenant' then
      raise exception
        'auto-applied late fees and tenant-paid processing fees require verified rent regulations for state %; none on file yet — leave late_fee_auto_apply off and fee_payer as landlord until state_rent_regulations has a row for %',
        st, st;
    end if;
    return NEW;
  end if;

  if NEW.late_fee_grace_days is not null and NEW.late_fee_grace_days < reg.min_grace_days then
    raise exception '% requires at least % day(s) grace before a late fee applies', st, reg.min_grace_days;
  end if;

  -- Normalize both sides to a dollar amount before comparing, rather than
  -- requiring NEW.late_fee_type to literally match reg.max_late_fee_type —
  -- otherwise a landlord could dodge a state's percent-of-rent cap simply
  -- by choosing 'flat' as this lease's fee type (or vice versa).
  if reg.max_late_fee_type <> 'none' and NEW.late_fee_amount is not null and NEW.late_fee_type is not null then
    if NEW.late_fee_type = 'percent' then
      effective_amount := NEW.rent_amount * (NEW.late_fee_amount / 100.0);
    else
      effective_amount := NEW.late_fee_amount;
    end if;

    if reg.max_late_fee_type = 'percent'
       and effective_amount > NEW.rent_amount * (reg.max_late_fee_value / 100.0) then
      raise exception '% caps late fees at % percent of rent', st, reg.max_late_fee_value;
    elsif reg.max_late_fee_type = 'flat' and effective_amount > reg.max_late_fee_value then
      raise exception '% caps late fees at $%', st, reg.max_late_fee_value;
    end if;
  end if;

  if NEW.fee_payer = 'tenant' and reg.tenant_paid_processing_fee_allowed is distinct from true then
    raise exception 'tenant-paid processing fees are not confirmed allowed in % yet', st;
  end if;

  return NEW;
end;
$fn$;

create trigger leases_enforce_late_fee_limits before insert or update on leases
  for each row execute function enforce_late_fee_limits();

-- Keeps the rent ledger consistent in the database, not in application
-- code: a successful payment accumulates onto its rent_charge until it's
-- fully paid; a later refund reverses that accumulation. Payments are
-- only ever written by the backend (Stripe webhook handler) using the
-- service_role key, which bypasses RLS — see the payments policies below
-- for why there is deliberately no client-facing insert policy on
-- payments.
create or replace function apply_payment_to_charge()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.status = 'succeeded' and NEW.rent_charge_id is not null then
    update rent_charges
       set amount_paid = amount_paid + NEW.amount,
           status = case when amount_paid + NEW.amount >= amount then 'paid' else 'partial' end
     where id = NEW.rent_charge_id;
  end if;
  return NEW;
end;
$fn$;
create trigger payments_apply_to_charge after insert on payments
  for each row execute function apply_payment_to_charge();

create or replace function reverse_refunded_payment()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if NEW.status = 'refunded' and OLD.status is distinct from 'refunded' and NEW.rent_charge_id is not null then
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
create trigger payments_reverse_refund after update on payments
  for each row execute function reverse_refunded_payment();

-- NOT built here, flagged for later: a scheduled job (pg_cron or an edge
-- function on a timer) is still needed to (a) flip rent_charges.status to
-- 'late' once due_date has passed with the charge still pending/partial,
-- and (b) insert a late_fee rent_charge automatically when the lease's
-- late_fee_auto_apply is true. Both are time-driven, not
-- write-driven, so a trigger on this table can't do them.

-- ===================================================================
-- Row-level security
-- ===================================================================

alter table organizations enable row level security;
alter table org_members enable row level security;
alter table properties enable row level security;
alter table units enable row level security;
alter table leases enable row level security;
alter table lease_tenants enable row level security;
alter table rent_charges enable row level security;
alter table payments enable row level security;
alter table maintenance_requests enable row level security;
alter table maintenance_jobs enable row level security;
alter table job_entries enable row level security;
alter table receipts enable row level security;
alter table technician_property_access enable row level security;
alter table messages enable row level security;
alter table invites enable row level security;
alter table documents enable row level security;
alter table state_rent_regulations enable row level security;

-- organizations: membership grants read; only an admin updates org
-- settings (e.g. stripe_connect_account_id). No insert/delete policy —
-- creation only happens through create_organization() above, which runs
-- as the table owner and bypasses RLS.
create policy organizations_read on organizations for select
  using (is_org_member(id));
create policy organizations_update on organizations for update
  using (has_org_role(id, array['admin']::org_role[]))
  with check (has_org_role(id, array['admin']::org_role[]));

-- org_members: everyone sees themself; admin/PM see the whole roster;
-- everyone sees who the admins/PMs are (so a tenant or technician knows
-- who to message). No client-facing insert/update/delete — those go
-- through accept_invite / update_org_member_role / set_org_member_status.
create policy org_members_read on org_members for select
  using (
    user_id = auth.uid()
    or has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or (role in ('admin','property_manager') and is_org_member(organization_id))
  );

-- properties: admin/PM see all; technician sees what they're scoped to;
-- tenant sees the property their unit is in. Only admin manages them.
create policy properties_read on properties for select
  using (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or technician_has_property_access(id)
    or exists (
      select 1 from units u join leases l on l.unit_id = u.id
       where u.property_id = properties.id and is_tenant_of_lease(l.id)
    )
  );
create policy properties_write on properties for insert
  with check (has_org_role(organization_id, array['admin']::org_role[]));
create policy properties_update on properties for update
  using (has_org_role(organization_id, array['admin']::org_role[]))
  with check (has_org_role(organization_id, array['admin']::org_role[]));
create policy properties_delete on properties for delete
  using (has_org_role(organization_id, array['admin']::org_role[]));

-- units: same shape as properties. Deliberately resolves org via
-- org_id_for_property(property_id) rather than org_id_for_unit(id) — the
-- latter re-queries `units` itself, which can't see a row this same
-- INSERT command just created (needed for INSERT ... RETURNING, which
-- re-checks this SELECT policy against the new row). Same reasoning
-- applies to leases_read and maintenance_jobs_read/update below.
create policy units_read on units for select
  using (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
    or exists (select 1 from leases l where l.unit_id = units.id and is_tenant_of_lease(l.id))
  );
create policy units_write on units for insert
  with check (has_org_role(org_id_for_property(property_id), array['admin']::org_role[]));
create policy units_update on units for update
  using (has_org_role(org_id_for_property(property_id), array['admin']::org_role[]))
  with check (has_org_role(org_id_for_property(property_id), array['admin']::org_role[]));
create policy units_delete on units for delete
  using (has_org_role(org_id_for_property(property_id), array['admin']::org_role[]));

-- leases: admin/PM manage; tenant reads their own. Resolves org via
-- org_id_for_unit(unit_id), not org_id_for_lease(id) — see the note on
-- units_read above for why a self-querying lookup breaks INSERT ... RETURNING.
create policy leases_read on leases for select
  using (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or is_tenant_of_lease(id)
  );
create policy leases_write on leases for insert
  with check (has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[]));
create policy leases_update on leases for update
  using (has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[]));
create policy leases_delete on leases for delete
  using (has_org_role(org_id_for_unit(unit_id), array['admin']::org_role[]));

-- lease_tenants: normal path is accept_invite(); these policies cover
-- admin/PM managing tenants directly (e.g. backfilling existing tenants),
-- and let roommates on the same lease see each other.
create policy lease_tenants_read on lease_tenants for select
  using (
    has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[])
    or is_tenant_of_lease(lease_id)
  );
create policy lease_tenants_write on lease_tenants for insert
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy lease_tenants_update on lease_tenants for update
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy lease_tenants_delete on lease_tenants for delete
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));

-- rent_charges: admin/PM manage; tenant reads their own lease's charges.
create policy rent_charges_read on rent_charges for select
  using (
    has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[])
    or is_tenant_of_lease(lease_id)
  );
create policy rent_charges_write on rent_charges for insert
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy rent_charges_update on rent_charges for update
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy rent_charges_delete on rent_charges for delete
  using (has_org_role(org_id_for_lease(lease_id), array['admin']::org_role[]));

-- payments: read-only from the client's perspective, always. Deliberately
-- no insert/update/delete policy for `authenticated` — a payment only
-- becomes real once Stripe confirms it, written by the backend webhook
-- handler using the service_role key (which bypasses RLS entirely). A
-- client-writable payments table would let a compromised browser fake a
-- "succeeded" rent payment.
create policy payments_read on payments for select
  using (
    has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[])
    or is_tenant_of_lease(lease_id)
  );

-- maintenance_requests: tenant submits/reads their own unit's requests;
-- admin/PM manage all; PM can also submit on a tenant's behalf.
create policy maintenance_requests_read on maintenance_requests for select
  using (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from leases l where l.unit_id = maintenance_requests.unit_id and is_tenant_of_lease(l.id))
  );
create policy maintenance_requests_write on maintenance_requests for insert
  with check (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from leases l where l.unit_id = maintenance_requests.unit_id and is_tenant_of_lease(l.id))
  );
create policy maintenance_requests_update on maintenance_requests for update
  using (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or (status = 'open' and exists (select 1 from org_members om where om.id = maintenance_requests.submitted_by and om.user_id = auth.uid()))
  )
  with check (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = maintenance_requests.submitted_by and om.user_id = auth.uid())
  );
create policy maintenance_requests_delete on maintenance_requests for delete
  using (has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[]));

-- maintenance_jobs: admin/PM manage everything; a technician sees and
-- updates jobs assigned to them or within their scoped properties.
-- Compares assigned_technician_id directly against the caller's own
-- member id rather than calling is_assigned_technician(id) — that
-- function re-queries maintenance_jobs itself, which is the same
-- self-reference problem noted on units_read above, and matters more
-- here because a technician's own update has no other disjunct to fall
-- back on (unlike admin/PM, who are already covered by the organization_id
-- column check with no subquery at all).
create policy maintenance_jobs_read on maintenance_jobs for select
  using (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
    or assigned_technician_id = get_my_member_id(organization_id)
  );
create policy maintenance_jobs_write on maintenance_jobs for insert
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy maintenance_jobs_update on maintenance_jobs for update
  using (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or assigned_technician_id = get_my_member_id(organization_id)
  )
  with check (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or assigned_technician_id = get_my_member_id(organization_id)
  );
create policy maintenance_jobs_delete on maintenance_jobs for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- job_entries: technician logs against their own assigned jobs; admin can
-- log too (covering for someone); PM is view-only, matching the
-- capability matrix in docs/domain-model.md.
create policy job_entries_read on job_entries for select
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or is_assigned_technician(job_id)
  );
create policy job_entries_write on job_entries for insert
  with check (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or (is_assigned_technician(job_id) and technician_id = get_my_member_id(org_id_for_job(job_id)))
  );
create policy job_entries_update on job_entries for update
  using (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  )
  with check (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  );
create policy job_entries_delete on job_entries for delete
  using (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = job_entries.technician_id and om.user_id = auth.uid())
  );

-- receipts: same shape as job_entries.
create policy receipts_read on receipts for select
  using (
    has_org_role(org_id_for_job(job_id), array['admin','property_manager']::org_role[])
    or is_assigned_technician(job_id)
  );
create policy receipts_write on receipts for insert
  with check (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or (is_assigned_technician(job_id) and uploaded_by = get_my_member_id(org_id_for_job(job_id)))
  );
create policy receipts_update on receipts for update
  using (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  )
  with check (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  );
create policy receipts_delete on receipts for delete
  using (
    has_org_role(org_id_for_job(job_id), array['admin']::org_role[])
    or exists (select 1 from org_members om where om.id = receipts.uploaded_by and om.user_id = auth.uid())
  );

-- technician_property_access: admin/PM configure it; a technician can
-- read their own scope so the app can show them what they can see.
create policy technician_property_access_read on technician_property_access for select
  using (
    has_org_role(org_id_for_member(org_member_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from org_members om where om.id = technician_property_access.org_member_id and om.user_id = auth.uid())
  );
create policy technician_property_access_write on technician_property_access for insert
  with check (has_org_role(org_id_for_member(org_member_id), array['admin','property_manager']::org_role[]));
create policy technician_property_access_update on technician_property_access for update
  using (has_org_role(org_id_for_member(org_member_id), array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_member(org_member_id), array['admin','property_manager']::org_role[]));
create policy technician_property_access_delete on technician_property_access for delete
  using (has_org_role(org_id_for_member(org_member_id), array['admin','property_manager']::org_role[]));

-- messages: only thread participants can read/send. Marking read_at is
-- covered by the same "can access this thread" check.
create policy messages_read on messages for select
  using (can_access_thread(thread_type, thread_ref_id, organization_id));
create policy messages_write on messages for insert
  with check (
    can_access_thread(thread_type, thread_ref_id, organization_id)
    and sender_id = get_my_member_id(organization_id)
  );
create policy messages_update on messages for update
  using (can_access_thread(thread_type, thread_ref_id, organization_id))
  with check (can_access_thread(thread_type, thread_ref_id, organization_id));

-- invites: admin/PM see their org's invites. No client-facing
-- insert/update/delete — create_invite / accept_invite / revoke_invite
-- above are the only supported paths.
create policy invites_read on invites for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- documents: admin/PM manage everything; a tenant sees their lease's
-- documents, a technician sees their job's documents.
create policy documents_read on documents for select
  using (
    has_org_role(organization_id, array['admin','property_manager']::org_role[])
    or (related_type = 'lease' and is_tenant_of_lease(related_id))
    or (related_type = 'job' and is_assigned_technician(related_id))
  );
create policy documents_write on documents for insert
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy documents_update on documents for update
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy documents_delete on documents for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- state_rent_regulations: public reference data — any logged-in user can
-- read it (the client needs it to render late-fee limits before
-- submitting a lease). No insert/update/delete policy for `authenticated`
-- — only seed.sql / a future migration (run as the table owner) changes
-- it, until there's a platform-staff role worth building for this.
create policy state_rent_regulations_read on state_rent_regulations for select
  using (true);
