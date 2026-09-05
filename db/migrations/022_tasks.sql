-- Things with a date that nothing else in the schema knows about.
--
-- The dashboard's Upcoming Events wants inspections, insurance renewals,
-- property tax deadlines, contractor appointments and recurring chores.
-- Rent due dates and lease expiries are already derivable from leases and
-- rent_charges; none of the rest existed anywhere.
--
-- One table rather than five. An inspection and an insurance renewal are
-- the same shape — a thing, on a date, maybe about a property, maybe
-- repeating — and modelling them separately would be five sets of policies
-- and five screens to say the same sentence.
--
-- Idempotent, safe to re-run.

create table if not exists tasks (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  -- Optional: "renew the insurance" belongs to the business, "inspect the
  -- roof" belongs to a building.
  property_id     uuid references properties(id) on delete cascade,
  title           text not null check (length(trim(title)) > 0),
  notes           text,
  category        text not null default 'other'
                    check (category in ('inspection', 'insurance', 'tax',
                                        'appointment', 'maintenance', 'other')),
  due_date        date not null,
  -- Null means it happens once. Otherwise the task reappears this many
  -- months after being completed — annual inspections, quarterly filters.
  repeat_months   int check (repeat_months is null or repeat_months between 1 and 60),
  completed_at    timestamptz,
  completed_by    uuid references org_members(id),
  created_by      uuid references org_members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists tasks_org_due_idx on tasks (organization_id, due_date);
create index if not exists tasks_open_idx on tasks (organization_id, due_date)
  where completed_at is null;

drop trigger if exists tasks_set_updated_at on tasks;
create trigger tasks_set_updated_at before update on tasks
  for each row execute function set_updated_at();

alter table tasks enable row level security;

drop policy if exists tasks_read on tasks;
drop policy if exists tasks_write on tasks;
drop policy if exists tasks_update on tasks;
drop policy if exists tasks_delete on tasks;

-- Admin and property manager only. A task can name a contractor's arrival
-- time or what an inspection found; neither is a tenant's business, and
-- neither is a technician's beyond the job they were given.
create policy tasks_read on tasks for select
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy tasks_write on tasks for insert
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy tasks_update on tasks for update
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]))
  with check (has_org_role(organization_id, array['admin','property_manager']::org_role[]));
create policy tasks_delete on tasks for delete
  using (has_org_role(organization_id, array['admin','property_manager']::org_role[]));

-- Ticking a task off, and rescheduling it if it repeats.
--
-- A function rather than a client-side update because the repeat is the
-- whole point: an annual inspection marked done should already be on the
-- calendar for next year before anyone closes the app. Counted from the
-- due date, not from today — a task done three weeks late does not shift
-- every future occurrence three weeks later.
create or replace function complete_task(task uuid)
returns uuid language plpgsql security definer set search_path = public as $fn$
declare
  t       tasks%rowtype;
  me      uuid;
  next_id uuid;
begin
  select * into t from tasks where id = task;
  if t.id is null then
    raise exception 'no such task';
  end if;

  if not has_org_role(t.organization_id, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can complete a task';
  end if;

  if t.completed_at is not null then
    return null; -- already done; ticking twice must not spawn a second one
  end if;

  me := get_my_member_id(t.organization_id);
  update tasks set completed_at = now(), completed_by = me where id = task;

  if t.repeat_months is not null then
    insert into tasks (organization_id, property_id, title, notes, category,
                       due_date, repeat_months, created_by)
    values (t.organization_id, t.property_id, t.title, t.notes, t.category,
            t.due_date + make_interval(months => t.repeat_months), t.repeat_months, me)
    returning id into next_id;
  end if;

  return next_id;
end;
$fn$;
revoke all on function complete_task(uuid) from public;
grant execute on function complete_task(uuid) to authenticated;

-- What is coming up, from every source that has a date.
--
-- Tasks, rent falling due, and leases ending, merged and sorted — a
-- landlord thinks in "what is coming up", not in which table a date
-- happens to live in. Returns structured rows; the wording is the
-- interface's job.
create or replace function upcoming_events(org uuid, days_ahead int default 45)
returns table(
  kind text,
  ref_id uuid,
  title text,
  detail text,
  due_date date,
  category text
)
language plpgsql security definer set search_path = public as $fn$
begin
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see upcoming events';
  end if;

  if days_ahead is null or days_ahead < 1 or days_ahead > 365 then
    raise exception 'days_ahead must be between 1 and 365';
  end if;

  return query
    -- Open tasks, including overdue ones: something that should have
    -- happened last week is more upcoming, not less.
    select 'task'::text,
           t.id,
           t.title,
           coalesce(p.name, 'All properties'),
           t.due_date,
           t.category
      from tasks t
      left join properties p on p.id = t.property_id
     where t.organization_id = org
       and t.completed_at is null
       and t.due_date <= current_date + days_ahead

    union all

    -- Rent not yet paid, grouped so four tenants due on the 1st are one
    -- line rather than four.
    select 'rent'::text,
           null::uuid,
           'Rent due',
           count(*)::text || ' tenant(s) · ' || to_char(sum(rc.amount - rc.amount_paid), 'FM999999990.00'),
           rc.due_date,
           'rent'::text
      from rent_charges rc
      join leases l on l.id = rc.lease_id
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
     where p.organization_id = org
       and rc.amount_paid < rc.amount
       and rc.due_date between current_date and current_date + days_ahead
     group by rc.due_date

    union all

    select 'lease'::text,
           l.id,
           'Lease ends',
           p.name || coalesce(' · ' || u.label, ''),
           l.end_date,
           'lease'::text
      from leases l
      join units u on u.id = l.unit_id
      join properties p on p.id = u.property_id
     where p.organization_id = org
       and l.status = 'active'
       and l.end_date between current_date and current_date + days_ahead

    order by 5, 3;
end;
$fn$;
revoke all on function upcoming_events(uuid, int) from public;
grant execute on function upcoming_events(uuid, int) to authenticated;
