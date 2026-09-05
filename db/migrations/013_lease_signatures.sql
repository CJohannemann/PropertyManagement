-- Signing a lease.
--
-- Until now an invite link attached a tenant to a lease and dropped them
-- on a dashboard showing what they owed — without ever showing them the
-- lease. That is worse than having no signing at all, because it looks
-- like onboarding completed.
--
-- Kentucky adopted UETA as KRS Chapter 369, so an electronic signature is
-- enforceable, but the statute and the federal ESIGN Act both require
-- four things. Each maps to a column here rather than being assumed:
--
--   intent to sign        -> signed_name, typed by the signer, plus an
--                            explicit act; a checkbox alone is weaker
--   consent to transact
--   electronically        -> consented_electronic, recorded separately
--                            because consent to e-records and agreement
--                            to the lease are different agreements
--   association with the
--   record                -> lease_id plus the snapshot below, so the
--                            signature is tied to specific text and not
--                            to "the lease" as a moving target
--   retention and
--   accurate reproduction -> the snapshot, which is why a signature
--                            cannot simply point at the live lease row
--
-- THE SNAPSHOT IS THE POINT. A lease document is rendered from the lease
-- row plus the organization's template, and both keep changing after
-- signing — rent gets corrected, a clause gets edited. Re-rendering later
-- would show something the tenant never agreed to, and quietly. So
-- signing freezes the inputs, server-side, from the database.
--
-- Idempotent, safe to re-run.

create table if not exists lease_signatures (
  id                   uuid primary key default gen_random_uuid(),
  lease_id             uuid not null references leases(id) on delete cascade,
  org_member_id        uuid not null references org_members(id),
  signer_role          text not null check (signer_role in ('tenant', 'landlord')),

  -- What the signer typed as their name, and that they meant it to be a
  -- signature. Both required: intent is the part a checkbox alone does
  -- not establish.
  signed_name          text not null check (btrim(signed_name) <> ''),
  consented_electronic boolean not null,

  -- Captured server-side, not sent by the client.
  signed_at            timestamptz not null default now(),
  ip_address           text,
  user_agent           text,

  -- The authoritative record of what was signed: the lease row and the
  -- template's clauses exactly as they stood, read from the database at
  -- signing rather than accepted from the browser.
  lease_snapshot       jsonb not null,
  clauses_snapshot     jsonb not null,
  -- What the signer actually saw on screen. Client-supplied and therefore
  -- NOT authoritative — kept because "accurately reproduced" is about the
  -- document a person read, and re-rendering years later depends on
  -- rendering code that may have changed. Where the two disagree, the
  -- snapshots above are the record.
  rendered_text        text,

  -- Over the canonical snapshots, so later tampering with the stored row
  -- is detectable.
  document_hash        text not null,

  unique (lease_id, org_member_id)
);
create index if not exists lease_signatures_lease_idx on lease_signatures (lease_id);

alter table lease_signatures enable row level security;

-- Readable by the organization's admins and property managers, and by any
-- tenant on the lease — every signature on it, not only their own.
--
-- That distinction is the requirement, not a convenience: retention under
-- UETA is about each party holding the executed agreement, and a tenant
-- who can see their own signature but not the landlord's countersignature
-- cannot tell whether the lease was ever executed at all.
-- Dropped first so this file can be re-run; `create policy` has no
-- `if not exists`. See the note in 008_lease_templates.sql.
drop policy if exists lease_signatures_read on lease_signatures;
create policy lease_signatures_read on lease_signatures for select
  using (
    has_org_role(org_id_for_lease(lease_id),
                 array['admin','property_manager']::org_role[])
    or is_tenant_of_lease(lease_id)
  );

-- No insert/update/delete policy on purpose. Signatures are written only
-- by sign_lease() below, which runs as the table owner: a signature a
-- browser could write directly, amend, or remove is not evidence of
-- anything.

create or replace function sign_lease(
  target_lease uuid,
  typed_name text,
  consent boolean,
  seen_text text default null
)
returns uuid
language plpgsql security definer set search_path = public as $fn$
declare
  member       org_members%rowtype;
  the_lease    leases%rowtype;
  org          uuid;
  role_signing text;
  clauses      jsonb;
  headers      json;
  fwd          text;
  ua           text;
  snapshot     jsonb;
  new_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  if consent is not true then
    raise exception 'cannot sign without consenting to use electronic records';
  end if;
  if btrim(coalesce(typed_name, '')) = '' then
    raise exception 'a signature needs a name';
  end if;

  select * into the_lease from leases where id = target_lease;
  if the_lease.id is null then
    raise exception 'no such lease';
  end if;
  org := org_id_for_lease(target_lease);

  select * into member from org_members
   where user_id = auth.uid() and organization_id = org and status = 'active'
   limit 1;
  if member.id is null then
    raise exception 'you are not a member of this organization';
  end if;

  -- A tenant may sign only a lease they are on; anyone managing the
  -- organization signs as the landlord.
  if member.role = 'tenant' then
    if not exists (select 1 from lease_tenants lt
                    where lt.lease_id = target_lease and lt.org_member_id = member.id) then
      raise exception 'you are not a tenant on this lease';
    end if;
    role_signing := 'tenant';
  elsif member.role in ('admin', 'property_manager') then
    role_signing := 'landlord';
  else
    raise exception 'this role cannot sign a lease';
  end if;

  -- The clauses as they stand right now, from the organization's default
  -- template. Ordered, so the snapshot is stable rather than depending on
  -- row order.
  select coalesce(jsonb_agg(to_jsonb(c) order by c.position), '[]'::jsonb)
    into clauses
    from lease_template_clauses c
    join lease_templates t on t.id = c.template_id
   where t.organization_id = org and t.is_default;

  if clauses = '[]'::jsonb then
    raise exception 'this organization has no lease template, so there is nothing to sign';
  end if;

  -- PostgREST exposes the request's headers, so the address comes from the
  -- proxy rather than from the browser claiming its own IP.
  begin
    headers := current_setting('request.headers', true)::json;
    fwd := split_part(coalesce(headers->>'x-forwarded-for', ''), ',', 1);
    ua  := headers->>'user-agent';
  exception when others then
    fwd := null; ua := null;
  end;

  snapshot := to_jsonb(the_lease);

  insert into lease_signatures (
    lease_id, org_member_id, signer_role, signed_name, consented_electronic,
    ip_address, user_agent, lease_snapshot, clauses_snapshot, rendered_text,
    document_hash
  ) values (
    target_lease, member.id, role_signing, btrim(typed_name), consent,
    nullif(btrim(fwd), ''), ua, snapshot, clauses, seen_text,
    encode(digest(snapshot::text || clauses::text, 'sha256'), 'hex')
  )
  on conflict (lease_id, org_member_id) do nothing
  returning id into new_id;

  if new_id is null then
    raise exception 'you have already signed this lease';
  end if;

  return new_id;
end;
$fn$;
-- digest() is pgcrypto, which supabase/postgres installs into
-- `extensions` — hence the search_path below rather than the plain
-- `public` the rest of these functions use.
alter function sign_lease(uuid, text, boolean, text) set search_path = public, extensions;
revoke all on function sign_lease(uuid, text, boolean, text) from public;
grant execute on function sign_lease(uuid, text, boolean, text) to authenticated;

-- Whether a lease is fully executed: at least one tenant and the
-- landlord. A view rather than a column, so it cannot drift out of step
-- with the signatures it describes.
create or replace view lease_signing_status as
  select
    l.id as lease_id,
    count(*) filter (where s.signer_role = 'tenant')   > 0 as tenant_signed,
    count(*) filter (where s.signer_role = 'landlord') > 0 as landlord_signed,
    count(*) filter (where s.signer_role = 'tenant')   > 0
      and count(*) filter (where s.signer_role = 'landlord') > 0 as fully_executed,
    max(s.signed_at) as last_signed_at
  from leases l
  left join lease_signatures s on s.lease_id = l.id
  group by l.id;

grant select on lease_signing_status to authenticated;
