-- Lease clause text belongs to the landlord, not to the application.
--
-- It was previously hardcoded in src/lib/leaseTemplate.ts, which is wrong
-- for a product serving more than one landlord in more than one state:
-- every organization would inherit one landlord's Kentucky wording, and
-- the platform would in effect be authoring everyone's legal documents.
-- A lease is a document its landlord is responsible for and their counsel
-- reviews; the app's job is to hold it, fill in the figures, and print it.
--
-- Clauses are rows rather than one big text blob so that placeholder
-- substitution, ordering, and "drop this clause when its data is absent"
-- keep working, and so a landlord can edit one clause without retyping
-- the document.
--
-- Idempotent, safe to re-run.

create table if not exists lease_templates (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  -- Used for new leases when the landlord hasn't picked one explicitly.
  is_default      boolean not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists lease_templates_org_idx on lease_templates (organization_id);

-- At most one default per organization. A partial unique index rather than
-- application logic, because "whichever row was written last wins" is
-- exactly the bug that leaves two defaults and a document that renders
-- differently depending on row order.
create unique index if not exists lease_templates_one_default_per_org
  on lease_templates (organization_id) where is_default;

create table if not exists lease_template_clauses (
  id            uuid primary key default gen_random_uuid(),
  template_id   uuid not null references lease_templates(id) on delete cascade,
  position      int not null,
  heading       text not null,
  body          text not null,
  -- Placeholder names whose absence drops the whole clause, so a lease
  -- with no parking doesn't print "Parking provided: ."
  omit_if_empty text[] not null default '{}',
  created_at    timestamptz not null default now()
);
create index if not exists lease_template_clauses_template_idx
  on lease_template_clauses (template_id, position);

-- Which template produced a lease's document. Null for leases written
-- before templates existed. This matters more later than it does now:
-- once a lease is signed, the signed text must be frozen as signed, and
-- knowing which template rendered it is the first half of that.
alter table leases add column if not exists lease_template_id uuid
  references lease_templates(id) on delete set null;

create or replace function org_id_for_template(t uuid)
returns uuid language sql stable security definer as $fn$
  select organization_id from lease_templates where id = t;
$fn$;

alter table lease_templates enable row level security;
alter table lease_template_clauses enable row level security;

-- Dropped first so this file can be re-run. `create policy` has no
-- `if not exists`, so without these the second run of
-- apply-migrations.sh aborts here — and because the script applies every
-- migration in order, that stops every later migration from being
-- applied too.
drop policy if exists lease_templates_read on lease_templates;
drop policy if exists lease_templates_write on lease_templates;
drop policy if exists lease_templates_update on lease_templates;
drop policy if exists lease_templates_delete on lease_templates;
drop policy if exists lease_template_clauses_read on lease_template_clauses;
drop policy if exists lease_template_clauses_write on lease_template_clauses;
drop policy if exists lease_template_clauses_update on lease_template_clauses;
drop policy if exists lease_template_clauses_delete on lease_template_clauses;

-- Readable by everyone in the organization, including tenants: a tenant
-- viewing their own lease needs the clause text to render it. Writable by
-- admin and property manager only.
create policy lease_templates_read on lease_templates for select
  using (is_org_member(organization_id));
create policy lease_templates_write on lease_templates for insert
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy lease_templates_update on lease_templates for update
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy lease_templates_delete on lease_templates for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

create policy lease_template_clauses_read on lease_template_clauses for select
  using (is_org_member(org_id_for_template(template_id)));
create policy lease_template_clauses_write on lease_template_clauses for insert
  with check (has_org_role(org_id_for_template(template_id),
                           array['admin','property_manager']::org_role[]));
create policy lease_template_clauses_update on lease_template_clauses for update
  using (has_org_role(org_id_for_template(template_id),
                      array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_template(template_id),
                           array['admin','property_manager']::org_role[]));
create policy lease_template_clauses_delete on lease_template_clauses for delete
  using (has_org_role(org_id_for_template(template_id),
                      array['admin','property_manager']::org_role[]));

drop trigger if exists lease_templates_set_updated_at on lease_templates;
create trigger lease_templates_set_updated_at before update on lease_templates
  for each row execute function set_updated_at();
