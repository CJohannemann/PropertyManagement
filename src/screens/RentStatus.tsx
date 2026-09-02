import { useEffect, useState } from 'react'
import {
  fetchCharges, outstanding, totalOutstanding, isOverdue, money,
  type ChargeWithPlace,
} from '../lib/charges'

/**
 * Rent status across the whole organization — what admins and property
 * managers see. RLS scopes the underlying query, so this component doesn't
 * filter by org itself.
 */
export function RentStatus() {
  const [charges, setCharges] = useState<ChargeWithPlace[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <p className="error-text">{error}</p>
  if (charges === null) return <p className="muted">Loading…</p>

  if (charges.length === 0) {
    return (
      <p className="empty-state">
        No charges yet. Rent is billed automatically each month for every
        active lease — the first one appears on that lease's due date.
      </p>
    )
  }

  const owed = totalOutstanding(charges)
  const overdue = charges.filter(isOverdue)

  return (
    <div>
      <div className="card-list">
        <div>
          <strong>{money(owed)}</strong> outstanding across {charges.length} charge(s)
          {overdue.length > 0 && (
            <div className="error-text" style={{ marginBottom: 0 }}>
              {overdue.length} overdue ({money(totalOutstanding(overdue))})
            </div>
          )}
        </div>
      </div>

      <div className="card-list">
        {charges.map((c) => {
          const place = c.leases?.units
            ? `${c.leases.units.properties?.name ?? ''} · ${c.leases.units.label}`
            : 'Unknown unit'
          return (
            <div key={c.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{place}</strong>
                <span className={isOverdue(c) ? 'error-text' : 'muted'}
                      style={{ margin: 0 }}>
                  {isOverdue(c) ? 'Overdue' : c.status}
                </span>
              </div>
              <div className="muted">
                {c.charge_type === 'late_fee' ? 'Late fee' : c.charge_type === 'other' ? 'Other' : 'Rent'}
                {' due '}{c.due_date} · {money(Number(c.amount))}
                {Number(c.amount_paid) > 0 && ` · ${money(Number(c.amount_paid))} paid`}
                {outstanding(c) > 0 && ` · ${money(outstanding(c))} outstanding`}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
