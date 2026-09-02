import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'

type Charge = {
  id: string
  charge_type: string
  due_date: string
  amount: number
  amount_paid: number
  status: string
}

type Lease = {
  id: string
  rent_amount: number
  status: string
  start_date: string
  end_date: string | null
  rent_charges: Charge[]
}

export function TenantDashboard() {
  const [leases, setLeases] = useState<Lease[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    // No explicit filter needed — RLS already scopes both tables to
    // leases/charges this signed-in tenant is actually on.
    supabase
      .from('leases')
      .select('id, rent_amount, status, start_date, end_date, rent_charges(id, charge_type, due_date, amount, amount_paid, status)')
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setLeases(data as unknown as Lease[])
      })
  }, [])

  return (
    <div>
      <h2>Your lease</h2>
      {error && <p className="error-text">{error}</p>}
      {leases === null && !error && <p className="muted">Loading…</p>}
      {leases?.length === 0 && (
        <p className="empty-state">No lease on file yet.</p>
      )}
      <div className="card-list">
        {leases?.map((l) => (
          <div key={l.id}>
            <strong>${l.rent_amount}/month</strong>
            <div className="muted">
              {l.status} · {l.start_date}
              {l.end_date ? ` – ${l.end_date}` : ''}
            </div>
            {l.rent_charges.length === 0 ? (
              <p className="muted" style={{ marginTop: '0.5rem' }}>
                No charges billed yet.
              </p>
            ) : (
              <ul>
                {l.rent_charges.map((c) => (
                  <li key={c.id}>
                    {c.charge_type} due {c.due_date}: ${c.amount_paid} / ${c.amount} ({c.status})
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
