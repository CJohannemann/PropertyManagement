/**
 * An OPTIONAL starting point a landlord can copy into their own lease
 * template, then edit. Not the app's lease, and not used by anything
 * unless a landlord explicitly chooses to start from it.
 *
 * ─────────────────────────────────────────────────────────────────────
 *  NOT LEGAL ADVICE. Whoever uses this is responsible for their own
 *  lease, reviewed by their own attorney, for their own state.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Lease text is per-organization data (see
 * db/migrations/008_lease_templates.sql), because a product serving
 * several landlords in several states cannot supply one lease for all of
 * them — and shouldn't be the author of anyone's legal documents. This
 * file exists only so a landlord starting from nothing has something to
 * edit rather than a blank page.
 *
 * These clauses were adapted from one Kentucky lease from 2025. That
 * makes them Kentucky-shaped, and quite possibly wrong elsewhere: states
 * differ on required disclosures, deposit handling, notice periods and
 * prohibited clauses. Treat this as a skeleton to replace, not a document
 * to rely on.
 *
 * Two deliberate departures from the lease it came from:
 *
 *  1. Its criminal-mischief clause is omitted. That clause described
 *     criminal mischief in the second degree as a "Class A Felony" and the
 *     third degree as a "Class B Felony". Under KRS 512.030 second degree
 *     is a Class A MISDEMEANOR, and KRS 512.040 (third degree) was
 *     repealed in 2024. Reciting criminal penalties incorrectly in a lease
 *     threatens tenants with consequences that do not exist, and a lease
 *     does not need to recite the penal code to preserve the landlord's
 *     rights under it. Section 11 states the substance without inventing
 *     the statute.
 *
 *  2. Its security-deposit clause named a specific bank account. That
 *     belongs in a per-lease field, not in template text where every
 *     tenant of every landlord would inherit one landlord's account
 *     number.
 *
 * Anything in {braces} is substituted from the lease data — see
 * LeaseDocument.tsx. A clause whose data is absent is dropped entirely
 * rather than printed with a blank, which is what `omitIfEmpty` marks.
 * Both survive being copied into a landlord's own template.
 */

export type LeaseClause = {
  heading: string
  body: string
  /**
   * Placeholder names whose absence removes the whole clause. A lease with
   * no pets should not carry a pet clause reading "Tenant may keep: ".
   */
  omitIfEmpty?: string[]
}

export const STARTER_CLAUSES: LeaseClause[] = [
  {
    heading: 'Parties and Premises',
    body:
      'This Residential Lease Agreement ("Agreement") is made on {agreementDate} between ' +
      '{landlord} ("Landlord") and {tenants} ("Tenant"), for the residential premises at ' +
      '{premises} ("Premises"). If more than one person is named as Tenant, all such persons ' +
      'have joint and several liability for the obligations of Tenant, and references to ' +
      'Tenant in the singular apply to all of them.',
  },
  {
    heading: 'Term',
    body:
      'The term of this Agreement begins on {startDate} and {termEnd} Tenant shall surrender ' +
      'the Premises at the end of the term in the condition received, ordinary wear and tear ' +
      'excepted.',
  },
  {
    heading: 'Rent',
    body:
      'Tenant shall pay rent of {rentAmount} per month, due in advance on or before the ' +
      '{rentDueDayOrdinal} day of each month ("Due Date"), regardless of whether that day ' +
      'falls on a weekend or holiday. {petRentClause}',
  },
  {
    heading: 'Late Rent and Returned Payments',
    body: '{lateFeeClause} All late fees are additional rent for that month and are collected as such.',
  },
  {
    heading: 'Deposits and Fees',
    body:
      'The amounts shown under "Due at signing" above are payable on execution of this ' +
      'Agreement. Deposits are refundable in accordance with applicable law, less any amounts ' +
      'lawfully withheld for unpaid rent, unpaid fees, unpaid utilities, or damage beyond ' +
      'ordinary wear and tear. Any amount identified as non-refundable is not returnable. ' +
      'Tenant shall give Landlord written notice of a forwarding address on or before the end ' +
      'of the term. Tenant may not apply any deposit toward rent for any month.',
  },
  {
    heading: 'Payment of Rent',
    body:
      'Rent may be paid through the online portal provided by Landlord. {feeClause}',
  },
  {
    heading: 'Utilities and Other Services',
    body:
      'Responsibility for utilities and other services is as set out in the table above, in ' +
      'addition to rent. A party responsible for a service is responsible for all associated ' +
      'charges, including seasonal fees, late fees, connection fees and maintenance charges. ' +
      'If Tenant fails to place a service in Tenant’s name from the start of the term, or ' +
      'cancels it before the end of the term, and the account is billed to Landlord, that ' +
      'amount is charged back to Tenant in addition to rent. Landlord is not responsible for ' +
      'any interruption or failure of a service, or for any resulting inconvenience or damage.',
    omitIfEmpty: ['utilitiesTable'],
  },
  {
    heading: 'Occupancy',
    body:
      'The Premises shall be occupied as a residence only, by Tenant and any occupants named ' +
      'in this Agreement. Tenant may host a guest for up to fifteen (15) days in any six (6) ' +
      'month period, provided the guest maintains a separate residence; a guest staying longer ' +
      'is an unauthorized occupant. Tenant shall comply with all laws and ordinances affecting ' +
      'the use and occupancy of the Premises.',
  },
  {
    heading: 'Pets',
    body:
      'No animal of any kind may be kept on the Premises, even temporarily, except as ' +
      'authorized in writing. {petsClause} Landlord may require permanent removal of an animal ' +
      'that becomes a nuisance, causes a disturbance, or damages the Premises. Animals ' +
      'belonging to guests are not permitted.',
  },
  {
    heading: 'Smoking',
    body: '{smokingClause} Damage caused by smoking is not ordinary wear and tear, and Landlord ' +
      'may deduct the cost of cleaning or repairing such damage — including deodorizing, ' +
      'sealing and repainting, and replacing carpet — from the security deposit. For this ' +
      'purpose "smoking" includes cigarettes, pipes, cigars, and electronic or aerosol ' +
      'vaporizing devices, whether used with tobacco, marijuana, or any similar substance.',
  },
  {
    heading: 'Condition of the Premises, Repairs and Damage',
    body:
      'Tenant has examined the Premises and accepts them in their present condition, subject to ' +
      'any defects noted in writing at move-in. Tenant shall keep the Premises in good order ' +
      'and shall promptly pay for repairs caused by the negligence or misuse of Tenant, ' +
      'Tenant’s occupants or guests. Tenant shall notify Landlord in writing immediately on ' +
      'discovering any needed repair or sign of a serious building problem — including water ' +
      'leaks, a leaking roof, foundation cracks, moisture in a ceiling, a spongy floor, ' +
      'appliance malfunction, or electrical sparking. Delay in reporting may make Tenant liable ' +
      'for damage that worsened as a result. Landlord shall pay for repairs of conditions ' +
      'materially affecting health or safety, and shall maintain the Premises in a habitable ' +
      'condition as required by law. Tenant is responsible for the cost of intentional or ' +
      'reckless damage to the Premises, and Landlord may pursue any remedy available at law.',
  },
  {
    heading: 'Landlord Access',
    body:
      'Landlord may enter the Premises at reasonable times to inspect, make repairs, or show ' +
      'the Premises. Except in an emergency or where Tenant has requested a repair, Landlord ' +
      'shall make a good faith effort to give Tenant at least two (2) days notice by telephone, ' +
      'text, email, or notice left at the Premises. Landlord may show the Premises to ' +
      'prospective tenants, purchasers, or lenders, and may display "for rent" or "for sale" ' +
      'signs.',
  },
  {
    heading: 'Extended Absence',
    body:
      'Tenant shall notify Landlord in writing of any expected absence from the Premises longer ' +
      'than seven (7) days, no later than the first day of the absence, and shall arrange for ' +
      'the Premises to be checked periodically. Landlord may enter during such an absence for ' +
      'any reasonable purpose.',
  },
  {
    heading: 'Locks and Security Devices',
    body:
      'Tenant shall not add or change any lock, bolt, latch or other security device without ' +
      'Landlord’s written consent. Requests to rekey, repair or add a security device must be ' +
      'in writing; work requested by Tenant is at Tenant’s expense, paid in advance, and ' +
      'performed by Landlord or Landlord’s contractor.',
  },
  {
    heading: 'Smoke and Carbon Monoxide Detectors',
    body:
      'Smoke and, where applicable, carbon monoxide detectors have been installed and both ' +
      'parties confirm they are working at the start of the term. Tenant shall keep them ' +
      'operational, shall not disable or impair them, shall test them as the manufacturer ' +
      'recommends, shall replace batteries at Tenant’s expense, and shall report any failure ' +
      'to Landlord in writing immediately.',
  },
  {
    heading: 'Keys',
    body:
      'Tenant shall return all keys, remotes and openers, including any copies made, at the end ' +
      'of the term. Tenant is responsible for the cost of rekeying if all keys are not returned.',
  },
  {
    heading: 'Parking',
    body: 'Parking provided: {parkingDescription}. Parking is for Tenant’s own registered ' +
      'passenger vehicles only, and not for washing, oil changes, or repair. Trucks over one ' +
      'ton, boats, recreational vehicles, trailers, and unlicensed, unregistered or abandoned ' +
      'vehicles may not be parked without Landlord’s written permission. Guests shall park on ' +
      'adjacent streets or in designated guest parking. Vehicles in violation may be towed at ' +
      'the owner’s risk and expense.',
    omitIfEmpty: ['parkingDescription'],
  },
  {
    heading: 'Renters Insurance',
    body: '{insuranceClause} Landlord does not insure Tenant against personal injury or loss of ' +
      'or damage to Tenant’s personal property.',
  },
  {
    heading: 'Assignment and Subletting',
    body:
      'Tenant shall not assign this Agreement, sublet the Premises, or grant any license to use ' +
      'the Premises without Landlord’s prior written consent. Consent on one occasion is not ' +
      'consent to any later assignment, subletting or license. Any assignment or subletting ' +
      'without consent, or by operation of law, is void and may, at Landlord’s option, ' +
      'terminate this Agreement.',
  },
  {
    heading: 'Alterations',
    body:
      'Tenant shall make no alteration, improvement or painting of any kind without Landlord’s ' +
      'prior written consent. Any alteration or improvement becomes the property of Landlord ' +
      'and remains at the end of the term, unless otherwise agreed in writing; Landlord may ' +
      'instead require Tenant to remove it and restore the Premises at Tenant’s expense.',
  },
  {
    heading: 'Hazardous Materials',
    body:
      'Tenant shall not keep on the Premises anything of a dangerous, flammable or explosive ' +
      'nature that would unreasonably increase the risk of fire or explosion, or that a ' +
      'responsible insurer would treat as hazardous.',
  },
  {
    heading: 'Mold and Moisture',
    body:
      'Both parties have visually inspected the Premises and observed no visible mold, obvious ' +
      'water leak, or excess moisture, except as noted in writing at move-in. Landlord makes no ' +
      'representation as to whether mold is present; only a qualified inspector can determine ' +
      'that. Tenant shall promptly notify Landlord in writing of any condition posing a hazard ' +
      'to property, health or safety, and Landlord shall take appropriate action as required by ' +
      'law. Tenant shall use reasonable care to limit moisture — keeping the Premises heated ' +
      'in freezing weather, using bathroom exhaust fans, and ventilating as needed.',
  },
  {
    heading: 'Lead-Based Paint Disclosure',
    body:
      'Housing built before 1978 may contain lead-based paint, which can pose serious health ' +
      'hazards, particularly to children and pregnant women. For any pre-1978 dwelling, ' +
      'Landlord shall disclose any known lead-based paint or hazards and any related records or ' +
      'reports, and shall provide Tenant with the federally approved pamphlet on lead poisoning ' +
      'prevention, before the tenancy begins.',
  },
  {
    heading: 'Fair Housing',
    body:
      'The federal Fair Housing Act prohibits discrimination on the basis of race, color, ' +
      'national origin, religion, sex (including gender identity and sexual orientation), ' +
      'familial status, and disability. The parties shall comply with that Act and with any ' +
      'other protected classification under applicable federal, state or local law.',
  },
  {
    heading: 'Damage or Destruction of the Premises',
    body:
      'If the Premises are destroyed or made wholly uninhabitable by fire, storm or other ' +
      'casualty not caused by Tenant’s negligence, this Agreement terminates as of that date, ' +
      'except as to rights already accrued; rent is accounted for to that date and any rent ' +
      'paid beyond it is refunded. If only part of the Premises is made uninhabitable, Landlord ' +
      'may either repair it or terminate this Agreement. If Landlord repairs, rent abates in ' +
      'proportion to the affected part until the repair is complete.',
  },
  {
    heading: 'Military Service, Family Violence and Related Protections',
    body:
      'The federal Servicemembers Civil Relief Act permits Tenant to terminate this Agreement ' +
      'in certain circumstances arising from military service. Tenant may also have rights ' +
      'under state or local law to terminate early in situations involving family violence, ' +
      'certain sexual offenses, or stalking. The parties shall comply with any such law.',
  },
  {
    heading: 'Accuracy of Application',
    body:
      'Tenant’s representations in the rental application are material to Landlord’s decision ' +
      'to enter this Agreement. A material misrepresentation or failure to disclose is a breach ' +
      'and is good cause for termination.',
  },
  {
    heading: 'Credit Reporting',
    body:
      'Tenant is notified that a negative credit report may be submitted to a credit reporting ' +
      'agency if Tenant fails to fulfill the terms of this Agreement.',
  },
  {
    heading: 'Subordination',
    body:
      'This Agreement and Tenant’s interest under it are subordinate to any mortgage, lien or ' +
      'encumbrance now or later placed on the Premises by Landlord, to advances made under ' +
      'them, and to any renewal, extension or modification of them.',
  },
  {
    heading: 'Notices',
    body:
      'Notice to Tenant may be given at the Premises, or at another address Tenant designates ' +
      'in writing, or otherwise at Tenant’s last known address. Notice to Landlord shall be ' +
      'given at the address stated above.',
  },
  {
    heading: 'Additional Terms',
    body: '{additionalTerms}',
    omitIfEmpty: ['additionalTerms'],
  },
  {
    heading: 'General',
    body:
      'This Agreement is governed by the laws of the Commonwealth of Kentucky, and the parties ' +
      'consent to venue in the county where the Premises are located. This Agreement is the ' +
      'entire agreement between the parties and may be modified only by a written amendment ' +
      'signed by all parties. Landlord’s failure to enforce any term on one occasion is not a ' +
      'waiver of that term. Headings are for convenience only. If any provision is held ' +
      'unenforceable, the remainder stays in effect. Time is of the essence.',
  },
]
