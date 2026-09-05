import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { MaintenanceRequests } from '../MaintenanceRequests'
import { LeaseTemplates } from '../LeaseTemplates'

type Property = PropertySummary & { units: { id: string }[] }

type Props = { organizationId: string; organizationName: string; memberId: string }

export function PropertyManagerDashboard({ organizationId, organizationName, memberId }: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<PropertySummary | null>(null)
  const [showTemplates, setShowTemplates] = useState(false)

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

  if (showTemplates) {
    return (
      <LeaseTemplates
        organizationId={organizationId}
        onBack={() => setShowTemplates(false)}
      />
    )
  }

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

      {/* A property manager is allowed to manage lease templates — the RLS
          policies in 008_lease_templates.sql grant admin and
          property_manager alike — but this screen never offered a way in.
          The "no lease template yet" message a manager hits when printing
          a lease told them to set one up "under Lease templates", which
          existed only on the admin dashboard. */}
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center', marginTop: '2rem' }}>
        <h2>Properties</h2>
        <button className="link" onClick={() => setShowTemplates(true)}>
          Lease templates
        </button>
      </div>
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
