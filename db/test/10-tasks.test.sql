-- Tasks, and the upcoming-events feed they feed.
--
-- The dates a landlord needs warning about live in three different places
-- — tasks, rent charges, leases — and the point of upcoming_events is that
-- nobody should have to know which. These check the merge is right and the
-- boundary holds.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-11111111aaaa', 'owner@example.com'),
  ('22222222-2222-2222-2222-22222222bbbb', 'other@example.com'),
  ('33333333-3333-3333-3333-33333333cccc', 'tenant@example.com');
insert into org_creation_allowlist (email)
values ('owner@example.com'), ('other@example.com');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-11111111aaaa', false);
select create_organization('Owner Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'Central', '807', 'Newport', 'KY', '41071') returning id as prop \gset
insert into units (property_id, label) values (:'prop', '2 - Middle') returning id as unit \gset
insert into leases (unit_id, start_date, end_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', current_date + 20, 1200, 1, 'active') returning id as lease \gset
select id as owner_member from org_members
 where user_id = '11111111-1111-1111-1111-11111111aaaa' \gset

-- A separate landlord, whose dates must never appear in the first one's feed.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-22222222bbbb', false);
select create_organization('Other Org') as org2 \gset
select set_config('request.jwt.uid', '11111111-1111-1111-1111-11111111aaaa', false);

-- ------------------------------------------------------------ tasks --

insert into tasks (organization_id, property_id, title, category, due_date, created_by)
values (:'org', :'prop', 'Roof inspection', 'inspection', current_date + 10, :'owner_member')
returning id as inspection \gset

-- An organization-level task: insurance belongs to the business, not a
-- building, which is why property_id is nullable.
insert into tasks (organization_id, title, category, due_date, repeat_months, created_by)
values (:'org', 'Insurance renewal', 'insurance', current_date + 25, 12, :'owner_member')
returning id as insurance \gset

select assert((select count(*) from tasks where organization_id = :'org') = 2,
  'tasks are recorded');
select assert_rejected(
  format('insert into tasks (organization_id, title, due_date) values (%L, %L, %L)',
         :'org', '   ', current_date),
  'a task must actually have a title');
select assert_rejected(
  format('insert into tasks (organization_id, title, due_date, repeat_months)
          values (%L, %L, %L, 999)', :'org', 'Silly repeat', current_date),
  'an absurd repeat interval is refused');

-- ------------------------------------------------- completing them --

-- A one-off just closes. Checked by counting rather than by capturing the
-- return: psql's \gset UNSETS a variable when the value is null, so
-- :'var' would be a syntax error rather than an empty string.
select complete_task(:'inspection');
select assert((select count(*) from tasks where organization_id = :'org') = 2,
  'completing a one-off task spawns nothing');
select assert((select completed_at from tasks where id = :'inspection') is not null,
  'and the task is marked done');
select assert((select completed_by from tasks where id = :'inspection') = :'owner_member',
  'with who did it');

-- Ticking the same task again must not spawn anything either.
select complete_task(:'inspection');
select assert((select count(*) from tasks where organization_id = :'org') = 2,
  'completing a finished task changes nothing');

-- A repeating one comes back, counted from its DUE date rather than today,
-- so a task done three weeks late does not drag every future occurrence
-- three weeks later.
select complete_task(:'insurance');
select id as next_year from tasks
 where organization_id = :'org' and title = 'Insurance renewal'
   and completed_at is null \gset

select assert(:'next_year' is not null,
  'completing a repeating task schedules the next one');
select assert(
  (select due_date from tasks where id = :'next_year')
    = (current_date + 25 + interval '12 months')::date,
  'a year after the date it was due, not a year after it was ticked, got '
  || (select due_date::text from tasks where id = :'next_year'));
select assert((select repeat_months from tasks where id = :'next_year') = 12,
  'and it keeps repeating');

-- ------------------------------------------------- the merged feed --

-- Something owed, so rent shows up in the feed.
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease', 'rent', current_date + 5, 1200);

-- An open task in range.
insert into tasks (organization_id, property_id, title, category, due_date, created_by)
values (:'org', :'prop', 'Boiler service', 'appointment', current_date + 3, :'owner_member');

-- And one far enough out to be excluded by the window.
insert into tasks (organization_id, title, category, due_date, created_by)
values (:'org', 'Property tax', 'tax', current_date + 200, :'owner_member');

-- Three: the boiler at +3, the rent at +5, the lease ending at +20. The
-- roof inspection is completed and the insurance renewal moved a year out
-- when it was ticked, so neither is upcoming any more.
select assert((select count(*) from upcoming_events(:'org', 45)) = 3,
  'the feed merges tasks, rent and the lease ending, got '
  || (select count(*)::text from upcoming_events(:'org', 45)));

select assert(
  (select kind from upcoming_events(:'org', 45) order by due_date limit 1) = 'task',
  'and sorts by date — the boiler at +3 comes first');
select assert(
  (select kind from upcoming_events(:'org', 45) order by due_date offset 1 limit 1) = 'rent',
  'then the rent at +5');
select assert(
  (select kind from upcoming_events(:'org', 45) order by due_date offset 2 limit 1) = 'lease',
  'then the lease ending at +20');

select assert(
  (select count(*) from upcoming_events(:'org', 45) where title = 'Property tax') = 0,
  'a date beyond the window is left out');
select assert(
  (select count(*) from upcoming_events(:'org', 250) where title = 'Property tax') = 1,
  'and included when the window reaches it');

-- A completed task drops out rather than lingering.
select assert(
  (select count(*) from upcoming_events(:'org', 45) where title = 'Roof inspection') = 0,
  'a completed task is not upcoming');

-- Overdue is more upcoming, not less: something that should have happened
-- last week still needs doing.
insert into tasks (organization_id, title, category, due_date, created_by)
values (:'org', 'Overdue chore', 'other', current_date - 7, :'owner_member');
select assert(
  (select count(*) from upcoming_events(:'org', 45) where title = 'Overdue chore') = 1,
  'a task already past its date still shows');

-- Four tenants due on the same day are one line, not four.
insert into units (property_id, label) values (:'prop', '3 - Top') returning id as unit2 \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit2', '2026-01-01', 900, 1, 'active') returning id as lease2 \gset
insert into rent_charges (lease_id, charge_type, due_date, amount)
values (:'lease2', 'rent', current_date + 5, 900);
select assert(
  (select count(*) from upcoming_events(:'org', 45) where kind = 'rent') = 1,
  'two tenants due the same day are one rent line');
select assert(
  (select detail from upcoming_events(:'org', 45) where kind = 'rent') = '2 tenant(s) · 2100.00',
  'which says how many and how much, got '
  || (select detail from upcoming_events(:'org', 45) where kind = 'rent'));

-- ------------------------------------------------------ the boundary --

-- Refused outright rather than returning an empty set: asking for another
-- organization's dates is a question this landlord has no standing to ask,
-- and "no results" would suggest they simply had none.
select assert_rejected(
  format('select * from upcoming_events(%L, 45)', :'org2'),
  'one landlord cannot read another organization''s dates');

set role authenticated;
select set_config('request.jwt.uid', '33333333-3333-3333-3333-33333333cccc', false);
select assert((select count(*) from tasks) = 0,
  'someone outside the organization sees no tasks at all');
reset role;

select assert_rejected(
  format('select complete_task(%L)', :'insurance'),
  'and cannot complete one');

select assert(true, 'task tests completed');
