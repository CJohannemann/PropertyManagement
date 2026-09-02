-- The non-financial lease terms the document needs in order to say
-- anything specific: who pays which utility, whether smoking or pets are
-- allowed, whether renters insurance is required, what parking exists.
--
-- Without these the generated lease can only speak in generalities, which
-- is exactly where a lease is least useful — "Tenant shall pay utilities
-- as agreed" settles nothing when the water bill arrives.
--
-- Defaults are chosen to be the restrictive/safe reading (no smoking, no
-- pets, insurance not required) so a lease created without touching these
-- fields says something conservative rather than accidentally granting
-- permission.
--
-- Idempotent, safe to re-run.

alter table leases add column if not exists smoking_policy text
  not null default 'not_permitted'
  check (smoking_policy in ('not_permitted', 'permitted', 'outdoors_only'));

alter table leases add column if not exists pets_allowed boolean not null default false;
-- Free text rather than a pets table: the lease needs to describe what was
-- agreed ("two domestic cats, 12lbs"), not to track animals as entities.
-- A pet that needs its own record is a different feature.
alter table leases add column if not exists pets_description text;
alter table leases add column if not exists pet_rent_amount numeric(10,2);

alter table leases add column if not exists renters_insurance_required boolean
  not null default false;

alter table leases add column if not exists parking_description text;

-- {"Electric":"tenant","Water":"landlord",...}. jsonb rather than columns
-- because the list of utilities is not fixed — septic, HOA dues and snow
-- removal apply to some properties and are meaningless for others — and
-- rather than a join table because nothing ever queries across leases by
-- utility; it is only ever read back whole to print on the document.
alter table leases add column if not exists utilities jsonb not null default '{}'::jsonb;

-- Anything negotiated for this specific tenancy. Printed verbatim, and
-- stated in the document to override conflicting clauses — which is how
-- the existing paper lease handles it.
alter table leases add column if not exists additional_terms text;

comment on column leases.utilities is
  'Map of utility name to "tenant" | "landlord" | "na". Printed on the lease document.';
comment on column leases.pet_rent_amount is
  'Recurring monthly pet rent, billed on top of rent_amount. Distinct from pet_deposit_amount.';

-- Pet rent recurs monthly, so it belongs in the monthly rent charge rather
-- than the move-in bill. Folded into the rent charge amount rather than
-- billed as a second line, so a tenant sees one "rent" figure that matches
-- what the lease says is due each month.
create or replace function generate_rent_charges(
  for_month date default date_trunc('month', current_date)::date
)
returns int language plpgsql security definer set search_path = public as $fn$
declare
  n int := 0;
begin
  insert into rent_charges (lease_id, charge_type, due_date, amount)
  select l.id, 'rent', (for_month + (l.rent_due_day - 1))::date,
         l.rent_amount + coalesce(l.pet_rent_amount, 0)
    from leases l
   where l.status = 'active'
     and (for_month + (l.rent_due_day - 1))::date >= l.start_date
     and (l.end_date is null or (for_month + (l.rent_due_day - 1))::date <= l.end_date)
     -- "already billed anywhere this month", not "on this exact date":
     -- moving a lease's rent_due_day mid-month would otherwise bill the
     -- tenant a second time for the same month.
     and not exists (
       select 1 from rent_charges rc
        where rc.lease_id = l.id
          and rc.charge_type = 'rent'
          and rc.due_date >= for_month
          and rc.due_date < (for_month + interval '1 month')
     );
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function generate_rent_charges(date) from public, authenticated, anon;
