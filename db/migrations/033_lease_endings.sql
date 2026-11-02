-- Ending a tenancy: moving out, eviction, and what happens after.
--
-- leases.status has allowed 'ended' since the baseline, but nothing ever
-- set it. After a tenant left, the lease stayed 'active': rent kept
-- billing every month, the unit kept reading as occupied, and the unit
-- could not take a new lease. That is true of every move-out, not only an
-- eviction. Three pieces:
--
--   1. end_lease(): records the move-out — date, reason, a note — and
--      stops the lease. Rent and late fees dated on or before the move-out
--      stay owed; unpaid charges dated after it are removed; late fees
--      stop growing. The tenant's sign-in is either kept (so a former
--      tenant can still see and pay what they owe) or removed, chosen at
--      the time. A former tenant can no longer report repairs.
--
--   2. lease_events + the 'lease-files' bucket: a dated record against a
--      lease — notices served, court filings, hearings, judgments, payment
--      plans, notes — with documents and photos attached. Office only.
--      What an attorney asks for is a timeline; this is where it lives.
--
--   3. Security deposit wrap-up: deductions with reasons, applying the
--      deposit to unpaid rent (through the ledger, so the balance owed
--      actually drops), and the refund — amount, date, how.
--
-- None of this files anything with a court or serves anyone. It records
-- what the landlord did; the legal process happens outside the app.
--
-- Idempotent, safe to re-run.

-- ============================================================ 1. ending ==

alter table leases add column if not exists ended_on   date;
alter table leases add column if not exists end_reason text;
alter table leases add column if not exists end_note   text;
alter table leases add column if not exists ended_by   uuid references org_members(id) on delete set null;
alter table leases add column if not exists ended_at   timestamptz;

alter table leases drop constraint if exists leases_end_reason_check;
alter table leases add constraint leases_end_reason_check
  check (end_reason is null or end_reason in (
    'term_ended', 'moved_out_early', 'mutual_agreement', 'eviction',
    'abandoned', 'other'));

-- A dated record against a lease (part 2), created here because ending a
-- lease writes the first entry.
create table if not exists lease_events (
  id          uuid primary key default gen_random_uuid(),
  lease_id    uuid not null references leases(id) on delete cascade,
  event_type  text not null default 'note'
                check (event_type in (
                  'notice_served', 'court_filing', 'hearing', 'judgment',
                  'writ', 'payment_plan', 'move_out', 'inspection',
                  'deposit', 'note', 'other')),
  event_date  date not null default current_date,
  title       text not null check (length(trim(title)) > 0),
  details     text,
  created_by  uuid references org_members(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists lease_events_lease_idx on lease_events (lease_id, event_date desc);

create or replace function end_lease(
  target_lease uuid,
  move_out     date,
  reason       text,
  note         text default null,
  keep_access  boolean default true
)
returns jsonb language plpgsql security definer set search_path = public as $fn$
declare
  l          leases%rowtype;
  org        uuid;
  me         uuid;
  removed    int := 0;
  disabled   int := 0;
  still_owed numeric;
  label      text;
begin
  select * into l from leases where id = target_lease;
  if l.id is null then
    raise exception 'no such lease';
  end if;

  org := org_id_for_lease(l.id);
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can end a lease';
  end if;

  if l.status = 'ended' then
    raise exception 'this lease has already ended';
  end if;

  if move_out is null then
    raise exception 'a move-out date is required';
  end if;
  if move_out < l.start_date then
    raise exception 'the move-out date is before the lease started';
  end if;
  -- Recorded once it has happened. A move-out next month is a lease end
  -- date, not an ended lease: ending it now would stop billing the weeks
  -- the tenant is still living there.
  if move_out > current_date then
    raise exception 'record the move-out once it has happened — the date can''t be in the future';
  end if;

  if reason is null or reason not in ('term_ended', 'moved_out_early', 'mutual_agreement',
                                      'eviction', 'abandoned', 'other') then
    raise exception 'unknown reason';
  end if;

  me := get_my_member_id(org);

  -- Unpaid charges for after the tenant left are not owed. Late fees go
  -- with the rent they were charged on (and are dropped first, since they
  -- reference it). Anything with money already paid against it stays: a
  -- refund is a decision for a person, not a side effect.
  delete from rent_charges f
   using rent_charges r
   where f.parent_charge_id = r.id
     and f.charge_type = 'late_fee'
     and f.amount_paid = 0
     and r.lease_id = l.id
     and r.charge_type = 'rent'
     and r.amount_paid = 0
     and r.due_date > move_out;

  delete from rent_charges r
   where r.lease_id = l.id
     and r.charge_type = 'rent'
     and r.amount_paid = 0
     and r.due_date > move_out;
  get diagnostics removed = row_count;

  -- end_date is what billing reads (generate_rent_charges), so it moves to
  -- the real last day. status 'ended' is what everything else reads: the
  -- unit becomes vacant and can take a new lease.
  update leases
     set status     = 'ended',
         end_date   = move_out,
         ended_on   = move_out,
         end_reason = reason,
         end_note   = nullif(trim(coalesce(note, '')), ''),
         ended_by   = me,
         ended_at   = now(),
         updated_at = now()
   where id = l.id;

  -- Sign-in. Only for people with no other running lease here: a tenant
  -- moving from one unit to another keeps their account.
  if not coalesce(keep_access, true) then
    update org_members om
       set status = 'disabled'
     where om.status <> 'disabled'
       and om.role = 'tenant'
       and om.id in (select org_member_id from lease_tenants where lease_id = l.id)
       and not exists (
         select 1 from lease_tenants lt2
           join leases l2 on l2.id = lt2.lease_id
          where lt2.org_member_id = om.id
            and l2.id <> l.id
            and l2.status <> 'ended'
       );
    get diagnostics disabled = row_count;
  end if;

  label := case reason
    when 'term_ended' then 'Lease term ended'
    when 'moved_out_early' then 'Tenant moved out early'
    when 'mutual_agreement' then 'Ended by mutual agreement'
    when 'eviction' then 'Ended by eviction'
    when 'abandoned' then 'Unit abandoned'
    else 'Lease ended'
  end;
  insert into lease_events (lease_id, event_type, event_date, title, details, created_by)
  values (l.id, 'move_out', move_out, label, nullif(trim(coalesce(note, '')), ''), me);

  select coalesce(sum(amount - amount_paid), 0) into still_owed
    from rent_charges where lease_id = l.id and amount_paid < amount;

  return jsonb_build_object(
    'removed_charges', removed,
    'access_removed', disabled,
    'still_owed', still_owed
  );
end;
$fn$;
revoke all on function end_lease(uuid, date, text, text, boolean) from public;
grant execute on function end_lease(uuid, date, text, text, boolean) to authenticated;

-- Late fees stop growing once a lease has ended. What had accrued by then
-- stays owed; the daily portion just doesn't keep climbing on a tenancy
-- that no longer exists. Otherwise identical to 005's version.
create or replace function apply_late_fees()
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  with due as (
    select
      rc.id       as parent_id,
      rc.lease_id,
      (current_date - rc.due_date) as days_late,
      case
        when l.late_fee_amount is null then 0
        when (current_date - rc.due_date) < coalesce(l.late_fee_grace_days, 0) then 0
        when l.late_fee_type = 'percent'
          then round(l.rent_amount * (l.late_fee_amount / 100.0), 2)
        else l.late_fee_amount
      end as initial_fee,
      case
        when l.late_fee_daily_amount is null or l.late_fee_daily_start_days is null then 0
        else l.late_fee_daily_amount
             * greatest((current_date - rc.due_date) - l.late_fee_daily_start_days + 1, 0)
      end as daily_fee
    from rent_charges rc
    join leases l on l.id = rc.lease_id
    where rc.charge_type = 'rent'
      and rc.amount_paid < rc.amount
      and l.late_fee_auto_apply
      and l.status <> 'ended'
  ),
  totals as (
    select parent_id, lease_id, (initial_fee + daily_fee) as fee
      from due
     where days_late > 0 and (initial_fee + daily_fee) > 0
  ),
  upserted as (
    insert into rent_charges (lease_id, charge_type, due_date, amount, parent_charge_id)
    select lease_id, 'late_fee', current_date, fee, parent_id from totals
    on conflict (parent_charge_id) where charge_type = 'late_fee'
      do update set amount = greatest(excluded.amount, rent_charges.amount_paid)
      where rent_charges.amount is distinct from greatest(excluded.amount, rent_charges.amount_paid)
    returning 1
  )
  select count(*) into n from upserted;
  return n;
end;
$fn$;
revoke all on function apply_late_fees() from public, authenticated, anon;

-- A former tenant can still read their requests and charges (they may
-- owe money and keep their sign-in to pay it), but cannot report a repair
-- in a unit they no longer live in — which would now also alert every
-- technician at the property (031).
drop policy if exists maintenance_requests_write on maintenance_requests;
create policy maintenance_requests_write on maintenance_requests for insert
  with check (
    has_org_role(org_id_for_unit(unit_id), array['admin','property_manager']::org_role[])
    or exists (select 1 from leases l
                where l.unit_id = maintenance_requests.unit_id
                  and l.status <> 'ended'
                  and is_tenant_of_lease(l.id))
  );

-- ======================================================= 2. the record ==

alter table lease_events enable row level security;

drop policy if exists lease_events_read on lease_events;
drop policy if exists lease_events_write on lease_events;
drop policy if exists lease_events_update on lease_events;
drop policy if exists lease_events_delete on lease_events;

-- Office only. Notes about a dispute — what the tenant said, what the
-- attorney advised — are not the tenant's to read, and not a technician's.
create policy lease_events_read on lease_events for select
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy lease_events_write on lease_events for insert
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy lease_events_update on lease_events for update
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]))
  with check (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
create policy lease_events_delete on lease_events for delete
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));

-- Documents and photos for the record: a copy of the notice served, the
-- court's judgment, move-out photos. Keyed <lease_id>/<event_id>/<file>,
-- so the first path segment decides access — the same scheme as receipts
-- (011) and repair photos (015); see 011 for why the bucket columns are
-- filled in only if storage-api has created them.
insert into storage.buckets (id, name)
values ('lease-files', 'lease-files')
on conflict (id) do nothing;

do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'public') then
    execute 'update storage.buckets set public = false where id = ''lease-files''';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'file_size_limit') then
    execute 'update storage.buckets set file_size_limit = 26214400 where id = ''lease-files''';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'storage' and table_name = 'buckets'
                and column_name = 'allowed_mime_types') then
    execute 'update storage.buckets set allowed_mime_types =
             array[''image/jpeg'',''image/png'',''image/heic'',''image/webp'',''application/pdf'']
             where id = ''lease-files''';
  end if;
end $$;

create or replace function public.storage_object_lease_id(object_name text)
returns uuid language plpgsql immutable as $fn$
begin
  return split_part(object_name, '/', 1)::uuid;
exception when others then
  return null;
end;
$fn$;

drop policy if exists lease_files_read on storage.objects;
drop policy if exists lease_files_insert on storage.objects;
drop policy if exists lease_files_delete on storage.objects;

create policy lease_files_read on storage.objects for select
  using (
    bucket_id = 'lease-files'
    and public.storage_object_lease_id(name) is not null
    and public.has_org_role(public.org_id_for_lease(public.storage_object_lease_id(name)),
                            array['admin','property_manager']::public.org_role[])
  );
create policy lease_files_insert on storage.objects for insert
  with check (
    bucket_id = 'lease-files'
    and public.storage_object_lease_id(name) is not null
    and public.has_org_role(public.org_id_for_lease(public.storage_object_lease_id(name)),
                            array['admin','property_manager']::public.org_role[])
  );
create policy lease_files_delete on storage.objects for delete
  using (
    bucket_id = 'lease-files'
    and public.storage_object_lease_id(name) is not null
    and public.has_org_role(public.org_id_for_lease(public.storage_object_lease_id(name)),
                            array['admin','property_manager']::public.org_role[])
  );

-- ======================================================= 3. the deposit ==

-- Each deduction, with its reason. applied_to_balance marks the one made
-- by apply_deposit_to_balance(): that money already went through the
-- ledger as payments, so deleting the row alone would leave the payments
-- behind — those rows can't be deleted from the app.
create table if not exists deposit_deductions (
  id                 uuid primary key default gen_random_uuid(),
  lease_id           uuid not null references leases(id) on delete cascade,
  description        text not null check (length(trim(description)) > 0),
  amount             numeric(10,2) not null check (amount > 0),
  applied_to_balance boolean not null default false,
  created_by         uuid references org_members(id) on delete set null,
  created_at         timestamptz not null default now()
);
create index if not exists deposit_deductions_lease_idx on deposit_deductions (lease_id);

-- The refund, once made. One per lease.
create table if not exists deposit_returns (
  lease_id    uuid primary key references leases(id) on delete cascade,
  amount      numeric(10,2) not null check (amount >= 0),
  returned_on date not null,
  method      text,
  note        text,
  recorded_by uuid references org_members(id) on delete set null,
  created_at  timestamptz not null default now()
);

alter table deposit_deductions enable row level security;
alter table deposit_returns enable row level security;

drop policy if exists deposit_deductions_read on deposit_deductions;
drop policy if exists deposit_deductions_write on deposit_deductions;
drop policy if exists deposit_deductions_delete on deposit_deductions;
drop policy if exists deposit_returns_read on deposit_returns;
drop policy if exists deposit_returns_delete on deposit_returns;

create policy deposit_deductions_read on deposit_deductions for select
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
-- Plain deductions are typed in directly; applied_to_balance ones only
-- come from the function below.
create policy deposit_deductions_write on deposit_deductions for insert
  with check (
    has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[])
    and not applied_to_balance
  );
create policy deposit_deductions_delete on deposit_deductions for delete
  using (
    has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[])
    and not applied_to_balance
    and not exists (select 1 from deposit_returns dr where dr.lease_id = deposit_deductions.lease_id)
  );

create policy deposit_returns_read on deposit_returns for select
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));
-- Undoing a recorded refund (a typo) is allowed; recording one goes
-- through record_deposit_return(), which checks the amount.
create policy deposit_returns_delete on deposit_returns for delete
  using (has_org_role(org_id_for_lease(lease_id), array['admin','property_manager']::org_role[]));

-- What the landlord is holding, and where it stands.
--   held      — deposits actually paid (security, pet, other)
--   deducted  — every deduction, including any applied to the balance
--   returned  — the recorded refund, if any
--   remaining — held − deducted − returned
--   owed      — what the tenant still owes on the lease, not counting the
--               deposit charges themselves
create or replace function deposit_summary(target_lease uuid)
returns table(held numeric, deducted numeric, returned numeric, remaining numeric, owed numeric)
language plpgsql stable security definer set search_path = public as $fn$
begin
  if not has_org_role(org_id_for_lease(target_lease), array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can see the deposit';
  end if;

  return query
    with h as (
      select coalesce(sum(amount_paid), 0) as v from rent_charges
       where lease_id = target_lease
         and charge_type in ('security_deposit', 'pet_deposit', 'other_deposit')
    ), d as (
      select coalesce(sum(amount), 0) as v from deposit_deductions where lease_id = target_lease
    ), r as (
      select coalesce(sum(amount), 0) as v from deposit_returns where lease_id = target_lease
    ), o as (
      select coalesce(sum(amount - amount_paid), 0) as v from rent_charges
       where lease_id = target_lease
         and amount_paid < amount
         and charge_type not in ('security_deposit', 'pet_deposit', 'other_deposit')
    )
    select h.v, d.v, r.v, h.v - d.v - r.v, o.v from h, d, r, o;
end;
$fn$;
revoke all on function deposit_summary(uuid) from public;
grant execute on function deposit_summary(uuid) to authenticated;

-- Uses what's left of the deposit to pay down what the tenant owes,
-- oldest charge first, as real payments (method 'other', noted as from the
-- deposit) — so the balance owed drops everywhere it is shown, and a court
-- or the tenant sees exactly which charges the deposit covered. Records
-- one deduction for the total. Returns the amount applied.
create or replace function apply_deposit_to_balance(target_lease uuid)
returns numeric language plpgsql security definer set search_path = public as $fn$
declare
  org       uuid;
  me        uuid;
  available numeric;
  applied   numeric := 0;
  portion   numeric;
  ch        record;
begin
  org := org_id_for_lease(target_lease);
  if org is null then
    raise exception 'no such lease';
  end if;
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can apply a deposit';
  end if;
  if exists (select 1 from deposit_returns where lease_id = target_lease) then
    raise exception 'the deposit refund is already recorded — undo it first';
  end if;

  select remaining into available from deposit_summary(target_lease);
  if available <= 0 then
    raise exception 'there is no deposit left to apply';
  end if;

  me := get_my_member_id(org);

  for ch in
    select id, amount - amount_paid as outstanding
      from rent_charges
     where lease_id = target_lease
       and amount_paid < amount
       and charge_type not in ('security_deposit', 'pet_deposit', 'other_deposit')
     order by due_date, created_at
  loop
    exit when available <= 0;
    portion := least(available, ch.outstanding);
    perform record_manual_payment(ch.id, portion, 'other', current_date,
                                  'Applied from security deposit', null);
    available := available - portion;
    applied := applied + portion;
  end loop;

  if applied = 0 then
    raise exception 'nothing is owed on this lease';
  end if;

  insert into deposit_deductions (lease_id, description, amount, applied_to_balance, created_by)
  values (target_lease, 'Applied to unpaid rent and fees', applied, true, me);

  return applied;
end;
$fn$;
revoke all on function apply_deposit_to_balance(uuid) from public;
grant execute on function apply_deposit_to_balance(uuid) to authenticated;

create or replace function record_deposit_return(
  target_lease uuid, amount numeric, returned_on date,
  method text default null, note text default null
)
returns void language plpgsql security definer set search_path = public as $fn$
declare
  org       uuid;
  available numeric;
begin
  org := org_id_for_lease(target_lease);
  if org is null then
    raise exception 'no such lease';
  end if;
  if not has_org_role(org, array['admin','property_manager']::org_role[]) then
    raise exception 'only an admin or property manager can record a deposit refund';
  end if;
  if exists (select 1 from deposit_returns where lease_id = target_lease) then
    raise exception 'a refund is already recorded for this lease';
  end if;
  if amount is null or amount < 0 then
    raise exception 'the refund can''t be negative';
  end if;
  if returned_on is null then
    raise exception 'a date is required';
  end if;

  select remaining into available from deposit_summary(target_lease);
  if amount > available then
    raise exception 'only % of the deposit is left after deductions',
      to_char(greatest(available, 0), 'FM$999999990.00');
  end if;

  insert into deposit_returns (lease_id, amount, returned_on, method, note, recorded_by)
  values (target_lease, amount, returned_on,
          nullif(trim(coalesce(method, '')), ''), nullif(trim(coalesce(note, '')), ''),
          get_my_member_id(org));

  insert into lease_events (lease_id, event_type, event_date, title, details, created_by)
  values (target_lease, 'deposit', returned_on,
          'Deposit refund of ' || to_char(amount, 'FM$999999990.00') || ' recorded',
          nullif(trim(coalesce(note, '')), ''), get_my_member_id(org));
end;
$fn$;
revoke all on function record_deposit_return(uuid, numeric, date, text, text) from public;
grant execute on function record_deposit_return(uuid, numeric, date, text, text) to authenticated;
