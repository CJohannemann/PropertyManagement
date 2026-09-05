import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { RentOverview } from '../RentOverview'
import { DashboardSections } from '../DashboardSections'
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
      <h2>Needs your attention</h2>
      <DashboardSections
        organizationId={organizationId}
        onOpenProperty={(id) => {
          const p = properties?.find((x) => x.id === id)
          if (p) setSelected(p)
        }}
      />

      <h2 style={{ marginTop: '2rem' }}>Rent status</h2>
      <RentOverview organizationId={organizationId} />
      <div style={{ marginTop: '1rem' }}>
        <RentStatus />
      </div>

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

      {/* A property manager may manage lease templates — the RLS policies in
          008_lease_templates.sql grant admin and property_manager alike.
          Kept out of the Properties heading: the wording every lease prints
          from belongs to the organization, not to any one building. */}
      <h2 style={{ marginTop: '2.5rem' }}>Settings</h2>
      <div className="card-list">
        <div
          role="button"
          tabIndex={0}
          onClick={() => setShowTemplates(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowTemplates(true) }
          }}
          style={{ cursor: 'pointer' }}
        >
          <strong>Lease templates</strong>
          <div className="muted">
            The clause wording your leases are printed from.
          </div>
        </div>
      </div>
    </div>
  )
}
