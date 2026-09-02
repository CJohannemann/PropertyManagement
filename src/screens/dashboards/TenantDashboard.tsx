import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import {
  fetchCharges, outstanding, totalOutstanding, isOverdue, money,
  type ChargeWithPlace,
} from '../../lib/charges'

type Lease = {
  id: string
  rent_amount: number
  status: string
  start_date: string
  end_date: string | null
  rent_due_day: number
  deposit_amount: number
  fee_payer: 'landlord' | 'tenant'
}

export function TenantDashboard() {
  const [leases, setLeases] = useState<Lease[] | null>(null)
  const [charges, setCharges] = useState<ChargeWithPlace[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    // No explicit filter — RLS already scopes both to this tenant.
    supabase
      .from('leases')
      .select('id, rent_amount, status, start_date, end_date, rent_due_day, deposit_amount, fee_payer')
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setLeases(data as unknown as Lease[])
      })
    fetchCharges()
      .then(setCharges)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (error) return <p className="error-text">{error}</p>
  if (leases === null || charges === null) return <p className="muted">Loading…</p>

  if (leases.length === 0) {
    return <p className="empty-state">No lease on file yet.</p>
  }

  const owed = totalOutstanding(charges)
  const overdue = charges.filter(isOverdue)
  const lease = leases[0]

  return (
    <div>
      <h2>What you owe</h2>
      <div className="card-list">
        <div>
          <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>{money(owed)}</div>
          {owed === 0 ? (
            <div className="muted">You're all paid up.</div>
          ) : overdue.length > 0 ? (
            <div className="error-text" style={{ marginBottom: 0 }}>
              {money(totalOutstanding(overdue))} of this is past due.
            </div>
          ) : (
            <div className="muted">Nothing overdue.</div>
          )}
          {/* Payments aren't wired up yet — saying so is better than a
              button that does nothing, or silence where one should be. */}
          <p className="muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            Online payment is coming soon — pay as you do today for now.
          </p>
        </div>
      </div>

      <h2 style={{ marginTop: '2rem' }}>Your charges</h2>
      {charges.length === 0 ? (
        <p className="empty-state">Nothing billed yet.</p>
      ) : (
        <div className="card-list">
          {charges.map((c) => (
            <div key={c.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {c.charge_type === 'late_fee' ? 'Late fee' : c.charge_type === 'other' ? 'Other charge' : 'Rent'}
                </strong>
                <span className={isOverdue(c) ? 'error-text' : 'muted'} style={{ margin: 0 }}>
                  {isOverdue(c) ? 'Overdue' : c.status}
                </span>
              </div>
              <div className="muted">
                Due {c.due_date} · {money(Number(c.amount))}
                {Number(c.amount_paid) > 0 && ` · ${money(Number(c.amount_paid))} paid`}
                {outstanding(c) > 0 && ` · ${money(outstanding(c))} left`}
              </div>
            </div>
          ))}
        </div>
      )}

      <h2 style={{ marginTop: '2rem' }}>Your lease</h2>
      <div className="card-list">
        <div>
          <strong>{money(Number(lease.rent_amount))}/month</strong>
          <div className="muted">
            Due on day {lease.rent_due_day} · {lease.status}
          </div>
          <div className="muted">
            {lease.start_date}{lease.end_date ? ` – ${lease.end_date}` : ' – ongoing'}
          </div>
          {Number(lease.deposit_amount) > 0 && (
            <div className="muted">
              Security deposit: {money(Number(lease.deposit_amount))}
            </div>
          )}
          {lease.fee_payer === 'tenant' && (
            <div className="muted">
              A payment processing fee is added at checkout when paying online.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
