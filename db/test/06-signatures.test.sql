-- Lease signing.
--
-- The tests that matter here are about what a signature has to survive:
-- someone editing the lease afterwards, someone signing twice, someone
-- signing a lease they are not on, and someone tampering with the record.

insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'tenant@example.com'),
  ('33333333-3333-3333-3333-333333333333', 'other@example.com');
insert into org_creation_allowlist (email) values ('owner@example.com');

select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
select create_organization('Test Org') as org \gset
insert into properties (organization_id, name, address_line1, city, state, zip)
values (:'org', 'H', '1 St', 'Covington', 'KY', '41051') returning id as prop \gset
insert into units (property_id, label) values (:'prop', 'A') returning id as unit \gset
insert into units (property_id, label) values (:'prop', 'B') returning id as unit_b \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit', '2026-01-01', 1200, 1, 'active') returning id as lease \gset
insert into leases (unit_id, start_date, rent_amount, rent_due_day, status)
values (:'unit_b', '2026-01-01', 900, 1, 'active') returning id as other_lease \gset

-- A lease cannot be signed before the landlord has any lease wording:
-- there would be nothing to attach the signature to.
select assert_rejected(
  format('select sign_lease(%L, %L, true)', :'lease', 'Owner'),
  'signing is refused when the organization has no lease template');

insert into lease_templates (organization_id, name, is_default)
values (:'org', 'Standard', true) returning id as tpl \gset
insert into lease_template_clauses (template_id, position, heading, body)
values (:'tpl', 0, 'Rent', 'Tenant shall pay {rentAmount} per month.'),
       (:'tpl', 1, 'Term', 'The term begins on {startDate}.');

-- The tenant joins via an invite, as they would in the app.
select token from create_invite('tenant@example.com', 'tenant', :'lease', 'A Tenant') \gset
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select accept_invite(:'token');

-- ------------------------------------------------ intent and consent --

select assert_rejected(
  format('select sign_lease(%L, %L, false)', :'lease', 'A Tenant'),
  'cannot sign without consenting to electronic records');

select assert_rejected(
  format('select sign_lease(%L, %L, true)', :'lease', '   '),
  'a signature needs a name, not whitespace');

-- ------------------------------------------------------- signing --

select sign_lease(:'lease', 'A Tenant', true, 'Rent: $1,200.00 per month.') as sig \gset

select assert((select signer_role from lease_signatures where id = :'sig') = 'tenant',
  'a tenant signs as the tenant');
select assert((select consented_electronic from lease_signatures where id = :'sig'),
  'consent is recorded');
select assert((select length(document_hash) from lease_signatures where id = :'sig') = 64,
  'a sha256 hash of the signed content is stored');
select assert((select jsonb_array_length(clauses_snapshot) from lease_signatures
                where id = :'sig') = 2,
  'the clauses in force at signing are captured');

-- Signing twice is not additive.
select assert_rejected(
  format('select sign_lease(%L, %L, true)', :'lease', 'A Tenant'),
  'the same person cannot sign the same lease twice');

-- A tenant cannot sign a lease they are not on.
select assert_rejected(
  format('select sign_lease(%L, %L, true)', :'other_lease', 'A Tenant'),
  'a tenant cannot sign someone elses lease');

-- ------------------------------------- the snapshot survives edits --

-- The whole point: change the lease and the template afterwards, and what
-- was signed must not move.
select set_config('request.jwt.uid', '11111111-1111-1111-1111-111111111111', false);
update leases set rent_amount = 2500 where id = :'lease';
update lease_template_clauses set body = 'Tenant shall pay whatever we say.'
 where template_id = :'tpl' and position = 0;

select assert(
  (select (lease_snapshot->>'rent_amount')::numeric from lease_signatures where id = :'sig')
    = 1200,
  'the signed snapshot still shows the rent that was agreed, not the edited one');
select assert(
  (select clauses_snapshot->0->>'body' from lease_signatures where id = :'sig')
    = 'Tenant shall pay {rentAmount} per month.',
  'the signed clause text is unchanged by later template edits');
select assert(
  (select rent_amount from leases where id = :'lease') = 2500,
  'while the live lease does reflect the edit');

-- ------------------------------------------------ countersigning --

select assert((select landlord_signed from lease_signing_status where lease_id = :'lease')
              = false,
  'not executed until the landlord signs too');
select assert((select tenant_signed from lease_signing_status where lease_id = :'lease'),
  'but the tenant signature is recorded');
select assert((select fully_executed from lease_signing_status where lease_id = :'lease')
              = false,
  'and the lease is not fully executed');

select sign_lease(:'lease', 'The Landlord', true) as owner_sig \gset
select assert((select signer_role from lease_signatures where id = :'owner_sig') = 'landlord',
  'an admin signs as the landlord');
select assert((select fully_executed from lease_signing_status where lease_id = :'lease'),
  'both signatures make it fully executed');

-- --------------------------------------------- who can see and touch --

set role authenticated;

-- The signer and the landlord can read it; an unrelated member cannot.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
select assert((select count(*) from lease_signatures) = 2,
  'a tenant can see the signatures on their own lease');

select set_config('request.jwt.uid', '33333333-3333-3333-3333-333333333333', false);
select assert((select count(*) from lease_signatures) = 0,
  'someone outside the organization sees no signatures');

-- Signatures are written only by sign_lease(). A record a browser can
-- edit or delete is not evidence of anything.
select set_config('request.jwt.uid', '22222222-2222-2222-2222-222222222222', false);
update lease_signatures set signed_name = 'Someone Else';
delete from lease_signatures;
reset role;

select assert((select count(*) from lease_signatures where lease_id = :'lease') = 2,
  'a signature cannot be deleted from the client');
select assert(
  (select count(*) from lease_signatures where signed_name = 'Someone Else') = 0,
  'a signature cannot be rewritten from the client');

select assert(true, 'signature tests completed');
