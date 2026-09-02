/**
 * The clause text of a lease agreement.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  PLACEHOLDER. Replace with the real lease agreement before this is
 *  used with an actual tenant.
 * ─────────────────────────────────────────────────────────────────────
 *
 * What is here is deliberately skeletal: enough to prove the document
 * generates, pulls the right figures, and paginates — not a lease anyone
 * should sign. A residential lease is a legal document whose required
 * disclosures, prohibited clauses, and deposit handling vary by state, and
 * none of that can be inferred from the data model. The wording needs to
 * come from a lawyer or a vetted state-specific template, the same way
 * state_rent_regulations holds verified rules rather than guesses.
 *
 * Anything in {braces} is substituted from the lease data — see
 * LeaseDocument.tsx. Adding a clause needs no code change; adding a new
 * {placeholder} does.
 */

export type LeaseClause = { heading: string; body: string }

export const LEASE_CLAUSES: LeaseClause[] = [
  {
    heading: 'Parties and Premises',
    body:
      'This Residential Lease Agreement ("Agreement") is entered into between ' +
      '{landlord} ("Landlord") and {tenants} ("Tenant"), for the premises located at ' +
      '{premises} ("Premises").',
  },
  {
    heading: 'Term',
    body:
      'The term of this Agreement begins on {startDate} and {termEnd} Tenant shall ' +
      'surrender the Premises in the condition received, ordinary wear and tear excepted.',
  },
  {
    heading: 'Rent',
    body:
      'Tenant shall pay rent of {rentAmount} per month, due on day {rentDueDay} of each ' +
      'month. {lateFeeClause}',
  },
  {
    heading: 'Security Deposit',
    body:
      'Tenant shall pay a security deposit of {depositAmount}, to be held and returned in ' +
      'accordance with applicable state law.',
  },
  {
    heading: 'Payment of Rent',
    body:
      'Rent may be paid through the online portal provided by Landlord. {feeClause}',
  },
  {
    heading: 'Maintenance and Repairs',
    body:
      'Tenant shall promptly notify Landlord of any needed repairs. Landlord shall ' +
      'maintain the Premises in a habitable condition as required by applicable law.',
  },
  {
    heading: 'Governing Law',
    body:
      'This Agreement is governed by the laws of the state in which the Premises are ' +
      'located ({state}).',
  },
]
