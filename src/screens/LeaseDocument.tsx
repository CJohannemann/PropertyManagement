import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { money } from '../lib/charges'
import { LEASE_CLAUSES } from '../lib/leaseTemplate'
import type { Lease } from '../lib/leases'

type Props = {
  lease: Lease
  propertyName: string
  premises: string
  stateCode: string
  organizationName: string
  onClose: () => void
}

type PartyRow = { full_name: string | null; is_primary: boolean }

/**
 * A printable lease. Rendered as HTML and handed to the browser's own
 * print dialog ("Save as PDF") rather than built with a PDF library:
 * pagination, line breaking, widow control and font embedding all come
 * free and correct, which for a legal document matters more than the
 * extra click. It also means no PDF dependency in the bundle and, more
 * importantly, nowhere to store a file — this stack has no object storage.
 *
 * The document is regenerated from the lease row every time rather than
 * saved. That is right for an UNSIGNED draft, and will be wrong the moment
 * signatures exist: a signed lease must be frozen at the moment it was
 * signed, not re-rendered from data that may have changed since.
 */
export function LeaseDocument({
  lease, propertyName, premises, stateCode, organizationName, onClose,
}: Props) {
  const [parties, setParties] = useState<PartyRow[] | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('lease_tenants')
      .select('is_primary, org_members(full_name)')
      .eq('lease_id', lease.id)
      .then(({ data }) => {
        const rows = (data ?? []) as unknown as {
          is_primary: boolean
          org_members: { full_name: string | null } | null
        }[]
        setParties(
          rows.map((r) => ({
            full_name: r.org_members?.full_name ?? null,
            is_primary: r.is_primary,
          })),
        )
      })
  }, [lease.id])

  const named = (parties ?? []).map((p) => p.full_name).filter(Boolean) as string[]
  // An unnamed party is shown as a blank rather than an email or an id:
  // the document is going out for signature, and a visible gap is a
  // prompt to fill it in, where a stray address looks deliberate.
  const tenantNames = named.length > 0 ? named.join(' and ') : '________________________'

  const lateFeeClause = lease.late_fee_auto_apply && lease.late_fee_amount != null
    ? `If rent is not received within ${lease.late_fee_grace_days ?? 0} day(s) of the due date, ` +
      `a late fee of ${
        lease.late_fee_type === 'percent'
          ? `${lease.late_fee_amount}% of the monthly rent`
          : money(Number(lease.late_fee_amount))
      } shall be applied.`
    : 'No automatic late fee applies under this Agreement.'

  // The disclosure that has to appear in the lease itself, not only at
  // checkout — an undisclosed surcharge risks reading as a disguised rent
  // increase. See docs/domain-model.md.
  const feeClause = lease.fee_payer === 'tenant'
    ? 'Tenant is responsible for any payment processing fee charged for online payment. ' +
      'The fee is shown before payment is confirmed, and Tenant may avoid it by paying ' +
      'through another method accepted by Landlord.'
    : 'Landlord is responsible for any payment processing fee charged for online payment.'

  const termEnd = lease.end_date
    ? `ends on ${lease.end_date}.`
    : 'continues month to month until terminated as permitted by law.'

  const values: Record<string, string> = {
    landlord: organizationName,
    tenants: tenantNames,
    premises,
    startDate: lease.start_date,
    termEnd,
    rentAmount: money(Number(lease.rent_amount)),
    rentDueDay: String(lease.rent_due_day),
    depositAmount: money(Number(lease.deposit_amount)),
    lateFeeClause,
    feeClause,
    state: stateCode,
  }

  const fill = (s: string) =>
    s.replace(/\{(\w+)\}/g, (whole, key: string) =>
      // An unknown placeholder is left visible rather than replaced with
      // an empty string: a lease quietly missing a clause is far worse
      // than one that obviously needs attention before it goes out.
      key in values ? values[key] : whole,
    )

  return (
    <div className="lease-doc-overlay">
      <div className="lease-doc-actions no-print">
        <button className="link" onClick={onClose}>← Back</button>
        <button className="primary" style={{ width: 'auto' }} onClick={() => window.print()}>
          Print / Save as PDF
        </button>
      </div>

      <p className="muted no-print" style={{ maxWidth: '7.5in', margin: '0 auto 1rem' }}>
        Choose "Save as PDF" as the destination in the print dialog to get a
        file you can send. This is a draft for signature — review it before
        sending, and replace the placeholder clause text with your own lease
        agreement.
      </p>

      <article className="lease-doc">
        <h1>Residential Lease Agreement</h1>
        <p className="lease-doc-sub">{propertyName} — {premises}</p>

        {LEASE_CLAUSES.map((c, i) => (
          <section key={c.heading}>
            <h2>{i + 1}. {c.heading}</h2>
            <p>{fill(c.body)}</p>
          </section>
        ))}

        <section className="lease-doc-signatures">
          <h2>Signatures</h2>
          <div className="sig-block">
            <div className="sig-line" />
            <div>Landlord — {organizationName}</div>
            <div className="sig-date">Date: ______________</div>
          </div>
          {(named.length > 0 ? named : ['']).map((name, i) => (
            <div className="sig-block" key={i}>
              <div className="sig-line" />
              <div>Tenant{name ? ` — ${name}` : ''}</div>
              <div className="sig-date">Date: ______________</div>
            </div>
          ))}
        </section>
      </article>
    </div>
  )
}
