-- What is installed where: water heaters, furnaces, AC units, appliances.
--
-- A technician standing in a unit needs the make and model of the thing
-- they are about to fix before they can look up a part, a manual or a
-- fault code. Nothing recorded that anywhere — the tenant's request says
-- "dishwasher won't drain", not "Bosch SHX878WD5N".
--
-- Two things are added here:
--
--   1. `equipment`: one row per installed item. Hangs off a property and,
--      optionally, a unit. unit_id null means it serves the whole building
--      — a shared boiler, the laundry room washer — rather than one unit.
--
--   2. `set_technician_access()`: technician_property_access has existed
--      since the baseline, and every technician-facing policy reads it,
--      but nothing in the app could write it. A technician therefore saw
--      no properties at all unless someone inserted rows by hand. The
--      function replaces a technician's whole scope in one transaction so
--      "all properties" and "these two" cannot end up both half-applied.
--
-- Idempotent, safe to re-run.

-- ---------------------------------------------------------- equipment --

-- The composite foreign key below needs (id, property_id) to be unique on
-- units. id alone already is, so this changes nothing about which rows are
-- allowed — it only lets equipment prove its unit is in its property.
create unique index if not exists units_id_property_uidx on units (id, property_id);

create table if not exists equipment (
  id              uuid primary key default gen_random_uuid(),
  property_id     uuid not null references properties(id) on delete cascade,
  unit_id         uuid,
  category        text not null default 'other'
                    check (category in (
                      'water_heater', 'furnace', 'air_conditioner', 'heat_pump',
                      'boiler', 'dishwasher', 'refrigerator', 'range', 'microwave',
                      'washer', 'dryer', 'garbage_disposal', 'other')),
  make            text,
  model           text,
  serial_number   text,
  -- Where in the unit, when that is not obvious: "basement", "hall closet",
  -- "upstairs zone".
  location        text,
  install_date    date,
  notes           text,
  created_by      uuid references org_members(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A unit's equipment must be in that unit's property. MATCH SIMPLE (the
  -- default) skips the check when unit_id is null, which is exactly the
  -- building-wide case.
  foreign key (unit_id, property_id) references units (id, property_id) on delete cascade
);
create index if not exists equipment_property_idx on equipment (property_id);
create index if not exists equipment_unit_idx on equipment (unit_id);

drop trigger if exists equipment_set_updated_at on equipment;
create trigger equipment_set_updated_at before update on equipment
  for each row execute function set_updated_at();

alter table equipment enable row level security;

drop policy if exists equipment_read on equipment;
drop policy if exists equipment_write on equipment;
drop policy if exists equipment_update on equipment;
drop policy if exists equipment_delete on equipment;

-- Admin and property manager see and manage everything. A technician sees
-- and records equipment at the properties they are scoped to — they are
-- usually the one reading the data plate, so they should be able to write
-- down what it says — but cannot delete it. Tenants are left out: nothing
-- in their app needs it.
create policy equipment_read on equipment for select
  using (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
  );
create policy equipment_write on equipment for insert
  with check (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
  );
create policy equipment_update on equipment for update
  using (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
  )
  with check (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
    or technician_has_property_access(property_id)
  );
create policy equipment_delete on equipment for delete
  using (
    has_org_role(org_id_for_property(property_id), array['admin','property_manager']::org_role[])
  );

-- ------------------------------------------------- technician access --

-- Replaces a technician's property scope.
--
--   all_properties = true   → one row with property_id null (everything,
--                              including properties added later)
--   all_properties = false  → one row per id in property_ids; an empty
--                              array removes all access
--
-- Checks what the table's policies do not: that the member really is a
-- technician, and that every property belongs to the same organization.
-- The policies only check that the caller manages the member's
-- organization, so a row naming another organization's property was
-- insertable — harmless, since technician_has_property_access compares
-- organizations, but meaningless data nobody should be able to write.
create or replace function set_technician_access(
  member uuid, all_properties boolean, property_ids uuid[] default '{}'
)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  m org_members%rowtype;
begin
  select * into m from org_members where id = member;
  if m.id is null then
    raise exception 'no such member';
  end if;

  if not has_org_role(m.organization_id, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can change technician access';
  end if;

  if m.role <> 'technician' then
    raise exception 'property access only applies to technicians';
  end if;

  if not coalesce(all_properties, false) and exists (
    select 1 from unnest(coalesce(property_ids, '{}')) as pid
     where org_id_for_property(pid) is distinct from m.organization_id
  ) then
    raise exception 'every property must belong to the technician''s organization';
  end if;

  delete from technician_property_access where org_member_id = member;

  if coalesce(all_properties, false) then
    insert into technician_property_access (org_member_id, property_id)
    values (member, null);
  else
    insert into technician_property_access (org_member_id, property_id)
    select distinct member, pid from unnest(coalesce(property_ids, '{}')) as pid;
  end if;
end;
$fn$;
revoke all on function set_technician_access(uuid, boolean, uuid[]) from public;
grant execute on function set_technician_access(uuid, boolean, uuid[]) to authenticated;
