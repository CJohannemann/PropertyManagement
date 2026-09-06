import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { navigate, type Route } from '../../lib/route'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { RentOverview } from '../RentOverview'
import { RentSnapshot } from '../RentSnapshot'
import { DashboardSections } from '../DashboardSections'
import { QuickActions } from '../QuickActions'
import { Upcoming } from '../Upcoming'
import { RecentActivity } from '../RecentActivity'
import { MaintenanceRequests } from '../MaintenanceRequests'
import { LeaseTemplates } from '../LeaseTemplates'

type Property = PropertySummary & { units: { id: string }[] }

type Props = {
  organizationId: string
  organizationName: string
  memberId: string
  section: Route
  propertyId?: string
}

/**
 * The property manager's app. Same sections as the admin's, minus the two
 * things the capability matrix in docs/domain-model.md reserves for an
 * admin: adding properties and units, and connecting the Stripe account.
 */
export function PropertyManagerDashboard({
  organizationId, organizationName, memberId, section, propertyId,
}: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    if (!supabase) return
    const { data, error } = await supabase
      .from('properties')
      .select('id, name, address_line1, city, state, zip, units(id)')
      .order('created_at', { ascending: false })
    if (error) setError(describeError(error))
    else setProperties(data as unknown as Property[])
  }

  useEffect(() => { load() }, [])

  // Which property the URL points at. Read from the list rather than held
  // in state, so /properties/<id> works on a cold load and on the back
  // button, not only when arrived at by tapping.
  const openProperty = propertyId
    ? properties?.find((p) => p.id === propertyId) ?? null
    : null

  if (propertyId && properties && !openProperty) {
    return (
      <div>
        <button className="link" onClick={() => navigate('/properties')}>
          ← All properties
        </button>
        <p className="empty-state">
          That property isn't here any more. It may have been removed.
        </p>
      </div>
    )
  }

  if (openProperty) {
    return (
      <PropertyDetail
        property={openProperty}
        // Adding/removing units is admin-only per the capability matrix in
        // docs/domain-model.md; leases and tenant invites are not.
        canManageUnits={false}
        organizationName={organizationName}
        onBack={() => { navigate('/properties'); load() }}
      />
    )
  }

  if (section === '/rent') {
    return (
      <div>
        <h2>Rent</h2>
        <RentSnapshot
          organizationId={organizationId}
          propertyChoices={(properties ?? []).map((p) => ({ id: p.id, name: p.name }))}
          showFilters
        />
        <RentOverview organizationId={organizationId} />
        <div style={{ marginTop: '1rem' }}>
          <RentStatus />
        </div>
      </div>
    )
  }

  if (section === '/maintenance') {
    return <MaintenanceRequests organizationId={organizationId} memberId={memberId} />
  }

  if (section === '/settings') {
    return <LeaseTemplates organizationId={organizationId} onBack={() => navigate('/dashboard')} />
  }

  if (section === '/properties') {
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
            <div
              key={p.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate('/properties', { id: p.id })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  navigate('/properties', { id: p.id })
                }
              }}
              style={{ cursor: 'pointer' }}
            >
              <strong>{p.name}</strong>
              <div className="muted">
                {p.address_line1}, {p.city}, {p.state}
              </div>
              <div className="muted">{p.units.length} unit(s)</div>
            </div>
          ))}
        </div>

        {/* A property manager may manage lease templates — the RLS policies
            in 008_lease_templates.sql grant admin and property_manager
            alike. Kept out of the Properties heading: the wording every
            lease prints from belongs to the organization, not to any one
            building. */}
        <h2 style={{ marginTop: '2.5rem' }}>Settings</h2>
        <div className="card-list">
          <div
            role="button"
            tabIndex={0}
            onClick={() => navigate('/settings')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/settings') }
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

  return (
    <div>
      <h2>Needs your attention</h2>
      <DashboardSections
        organizationId={organizationId}
        onOpenProperty={(id) => navigate('/properties', { id })}
      />
      <h2 style={{ marginTop: '2rem' }}>This month</h2>
      <RentSnapshot organizationId={organizationId} />

      <div style={{ marginTop: '2rem' }}>
        <Upcoming
          organizationId={organizationId}
          propertyChoices={(properties ?? []).map((p) => ({ id: p.id, name: p.name }))}
        />
      </div>
      <h2 style={{ marginTop: '2rem' }}>Recent activity</h2>
      <RecentActivity organizationId={organizationId} />
      <QuickActions />
    </div>
  )
}
