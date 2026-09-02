import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { MaintenanceRequests } from '../MaintenanceRequests'

type Property = PropertySummary & { units: { id: string }[] }

type Props = { organizationId: string; organizationName: string; memberId: string }

export function PropertyManagerDashboard({ organizationId, organizationName, memberId }: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PropertySummary | null>(null)

  async function load() {
    if (!supabase) return
    const { data, error } = await supabase
      .from('properties')
      .select('id, name, address_line1, city, state, zip, units(id)')
      .order('created_at', { ascending: false })
    if (error) setError(describeError(error))
    else setProperties(data as unknown as Property[])
  }

  useEffect(() => {
    load()
  }, [])

  if (selected) {
    return (
      <PropertyDetail
        property={selected}
        // Adding/removing units is admin-only per the capability matrix in
        // docs/domain-model.md; leases and tenant invites are not.
        canManageUnits={false}
        organizationName={organizationName}
        onBack={() => { setSelected(null); load() }}
      />
    )
  }

  return (
    <div>
      <h2>Rent status</h2>
      <RentStatus />

      <div style={{ marginTop: '2rem' }}>
        <MaintenanceRequests organizationId={organizationId} memberId={memberId} />
      </div>

      <h2 style={{ marginTop: '2rem' }}>Properties</h2>
      {error && <p className="error-text">{error}</p>}
      {properties === null && !error && <p className="muted">Loading…</p>}
      {properties?.length === 0 && (
        <p className="empty-state">No properties yet — ask an admin to add one.</p>
      )}
      <div className="card-list">
        {properties?.map((p) => (
          <div key={p.id} onClick={() => setSelected(p)} style={{ cursor: 'pointer' }}>
            <strong>{p.name}</strong>
            <div className="muted">
              {p.address_line1}, {p.city}, {p.state}
            </div>
            <div className="muted">{p.units.length} unit(s)</div>
          </div>
        ))}
      </div>
    </div>
  )
}
