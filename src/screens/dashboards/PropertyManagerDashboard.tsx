import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'

type Property = {
  id: string
  name: string
  address_line1: string
  city: string
  state: string
  units: { id: string }[]
}

export function PropertyManagerDashboard() {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('properties')
      .select('id, name, address_line1, city, state, units(id)')
      .order('created_at', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setProperties(data as unknown as Property[])
      })
  }, [])

  return (
    <div>
      <h2>Properties</h2>
      {error && <p className="error-text">{error}</p>}
      {properties === null && !error && <p className="muted">Loading…</p>}
      {properties?.length === 0 && (
        <p className="empty-state">No properties yet — ask an admin to add one.</p>
      )}
      <div className="card-list">
        {properties?.map((p) => (
          <div key={p.id}>
            <strong>{p.name}</strong>
            <div className="muted">
              {p.address_line1}, {p.city}, {p.state}
            </div>
            <div className="muted">{p.units.length} unit(s)</div>
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: '2rem' }}>Rent status</h2>
      <p className="empty-state">
        No leases yet — rent status will show here once tenants are added.
      </p>
    </div>
  )
}
