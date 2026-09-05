import { useEffect, useState } from 'react'
import {
  fetchCharges, outstanding, totalOutstanding, isOverdue, statusLabel, money, chargeLabel,
  methodLabel, voidManualPayment,
  type ChargeWithPlace, type PaymentRow,
  groupByProperty,
} from '../lib/charges'
import { RecordPayment } from './RecordPayment'

/**
 * Rent status across the whole organization — what admins and property
 * managers see. RLS scopes the underlying query, so this component doesn't
 * filter by org itself.
 *
 * Grouped by building, collapsed by default. A flat list of every charge is
 * readable for one three-unit house and useless at any real size: a
 * landlord with 100 doors would scroll past 99 rows to find the one that
 * needs chasing. Buildings that owe money sort to the top, largest first,
 * so the ones needing attention are the ones you land on.
 */
export function RentStatus() {
  const [charges, setCharges] = useState<ChargeWithPlace[] | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [recording, setRecording] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => { reload() }, [])

  function toggle(propertyId: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(propertyId)) next.delete(propertyId)
      else next.add(propertyId)
      return next
    })
  }

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
  // Counts charges that actually owe something, not every charge on file.
  // "outstanding across 12 charge(s)" when ten of them are settled
  // overstates the problem.
  const owing = charges.filter((c) => outstanding(c) > 0)

  const buildings = groupByProperty(charges)

  return (
    <div>
      <div className="card-list">
        <div>
          <strong>{money(owed)}</strong> outstanding across {owing.length} charge(s)
          {overdue.length > 0 && (
            <div className="error-text" style={{ marginBottom: 0 }}>
              {overdue.length} overdue ({money(totalOutstanding(overdue))})
            </div>
          )}
        </div>
      </div>

      <div className="card-list">
        {buildings.map((b) => {
          const isOpen = expanded.has(b.id)
          const bOverdue = b.charges.filter(isOverdue)
          const unitsOwing = new Set(
            b.charges.filter((c) => outstanding(c) > 0).map((c) => c.leases?.units?.id),
          ).size

          return (
            <div key={b.id}>
              <div
                role="button"
                tabIndex={0}
                aria-expanded={isOpen}
                onClick={() => toggle(b.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggle(b.id)
                  }
                }}
                style={{ cursor: 'pointer' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>{isOpen ? '▾' : '▸'} {b.name}</strong>
                  <strong className={bOverdue.length > 0 ? 'error-text' : undefined}
                          style={{ margin: 0, whiteSpace: 'nowrap' }}>
                    {b.owed > 0 ? money(b.owed) : 'All paid'}
                  </strong>
                </div>
                <div className="muted">
                  {b.owed > 0
                    ? `${unitsOwing} unit(s) owing`
                    : `${b.unitCount} unit(s) · nothing outstanding`}
                  {bOverdue.length > 0 && ` · ${bOverdue.length} overdue`}
                </div>
              </div>

              {isOpen && (
                <div style={{ marginTop: '0.75rem', paddingLeft: '0.75rem',
                              borderLeft: '2px solid var(--line)' }}>
                  {b.units.map((u) => (
                    <div key={u.id} style={{ marginBottom: '1rem' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                        <strong>{u.label}</strong>
                        <span className="muted" style={{ margin: 0 }}>
                          {u.owed > 0 ? `${money(u.owed)} outstanding` : 'Paid up'}
                        </span>
                      </div>
                      {u.charges.map((c) => (
                        <div key={c.id} style={{ marginTop: '0.75rem' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                            <span>{chargeLabel(c.charge_type)}</span>
                            <span className={isOverdue(c) ? 'error-text' : 'muted'}
                                  style={{ margin: 0, whiteSpace: 'nowrap' }}>
                              {statusLabel(c)}
                            </span>
                          </div>
                          <div className="muted">
                            Due {c.due_date} · {money(Number(c.amount))}
                            {Number(c.amount_paid) > 0 && ` · ${money(Number(c.amount_paid))} paid`}
                            {outstanding(c) > 0 && ` · ${money(outstanding(c))} outstanding`}
                          </div>

                          {(c.payments ?? []).map((p) => (
                            <PaymentLine
                              key={p.id}
                              payment={p}
                              onChanged={reload}
                              onError={setError}
                            />
                          ))}

                          {outstanding(c) > 0 && (
                            recording === c.id ? (
                              <RecordPayment
                                charge={c}
                                onRecorded={() => { setRecording(null); reload() }}
                                onCancel={() => setRecording(null)}
                              />
                            ) : (
                              <button className="link" onClick={() => setRecording(c.id)}>
                                Record a payment
                              </button>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * One payment against a charge, with a way to undo it.
 *
 * A payment still in flight is called out rather than shown as money
 * received: an ACH transfer sits in 'processing' for days, and a landlord
 * seeing it listed under a charge should not read that as settled.
 */
function PaymentLine({
  payment, onChanged, onError,
}: { payment: PaymentRow; onChanged: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false)
  const inFlight = payment.status === 'pending' || payment.status === 'processing'
  const voided = payment.status === 'refunded'
  const failed = payment.status === 'failed'

  // Stripe payments are refunded in Stripe, never unpicked here — see
  // void_manual_payment in db/migrations/018_manual_payments.sql.
  const canVoid = !voided && !inFlight && payment.method !== 'ach' && payment.method !== 'card'

  return (
    <div className="muted" style={{ marginTop: '0.35rem', display: 'flex',
                                    justifyContent: 'space-between', gap: '1rem' }}>
      <span style={{ textDecoration: voided ? 'line-through' : undefined }}>
        {money(Number(payment.amount))} by {methodLabel(payment.method)}
        {payment.paid_at ? ` on ${payment.paid_at.slice(0, 10)}` : ''}
        {payment.note ? ` · ${payment.note}` : ''}
        {inFlight && ' · on its way, not cleared yet'}
        {failed && ' · did not clear'}
        {voided && ' · voided'}
      </span>
      {canVoid && (
        <button
          className="link"
          disabled={busy}
          style={{ margin: 0, whiteSpace: 'nowrap' }}
          onClick={async () => {
            setBusy(true)
            try {
              await voidManualPayment(payment.id)
              onChanged()
            } catch (e) {
              onError(e instanceof Error ? e.message : String(e))
              setBusy(false)
            }
          }}
        >
          {busy ? 'Voiding…' : 'Void'}
        </button>
      )}
    </div>
  )
}
