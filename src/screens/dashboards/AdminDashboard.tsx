import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { navigate, type Route } from '../../lib/route'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { RentOverview } from '../RentOverview'
import { DashboardSections } from '../DashboardSections'
import { QuickActions } from '../QuickActions'
import { LeaseTemplates } from '../LeaseTemplates'
import { MaintenanceRequests } from '../MaintenanceRequests'
import { GettingPaid } from '../GettingPaid'

type Property = PropertySummary & { units: { id: string }[] }

type Props = {
  organizationId: string
  organizationName: string
  memberId: string
  section: Route
  propertyId?: string
}

/**
 * The admin's app, split into the sections the bottom nav switches between.
 *
 * It was one long page of stacked panels, which fought the spec's own two
 * rules — answer the important questions in ten seconds, without excessive
 * scrolling. Home now answers those; everything else is a tap away and has
 * a URL, so the back button works and a number can link somewhere real.
 */
export function AdminDashboard({
  organizationId, organizationName, memberId, section, propertyId,
}: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)

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
    // organizationId isn't in the query — RLS already scopes `properties`
    // to the caller's org — but a different org's admin sees different
    // rows, so it's the effect's real dependency.
  }, [organizationId])

  // Which property the URL is pointing at. Read from the list rather than
  // held in state, so /properties/<id> works on a cold load and on the back
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
        canManageUnits
        organizationName={organizationName}
        onBack={() => { navigate('/properties'); load() }}
      />
    )
  }

  if (section === '/rent') {
    return (
      <div>
        <h2>Rent</h2>
        <RentOverview organizationId={organizationId} />
        <div style={{ marginTop: '1rem' }}>
          <RentStatus />
        </div>
        <div style={{ marginTop: '2rem' }}>
          <GettingPaid organizationId={organizationId} />
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
        <div style={{ display: 'flex', justifyContent: 'space-between',
                      alignItems: 'center' }}>
          <h2>Properties</h2>
          <button className="link" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Cancel' : '+ Add property'}
          </button>
        </div>

        {showForm && (
          <AddPropertyForm
            organizationId={organizationId}
            onAdded={() => { setShowForm(false); load() }}
          />
        )}

        {error && <p className="error-text">{error}</p>}
        {properties === null && !error && <p className="muted">Loading…</p>}
        {properties?.length === 0 && (
          <p className="empty-state">No properties yet — add your first one above.</p>
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
                {p.address_line1}, {p.city}, {p.state} {p.zip}
              </div>
              <div className="muted">{p.units.length} unit(s)</div>
            </div>
          ))}
        </div>

        {/* Lease templates were wedged into this heading beside "+ Add
            property", which read as a property action and crowded the
            heading on a phone. They are neither — the wording every lease
            prints from belongs to the organization, not to any one
            building. This is where org-wide settings collect. */}
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

  // Home: what needs doing, then the portfolio, then the shortcuts.
  return (
    <div>
      <h2>Needs your attention</h2>
      <DashboardSections
        organizationId={organizationId}
        onOpenProperty={(id) => navigate('/properties', { id })}
      />
      <QuickActions canAddProperty />
    </div>
  )
}

function AddPropertyForm(
  { organizationId, onAdded }: { organizationId: string; onAdded: () => void },
) {
  const [name, setName] = useState('')
  const [addressLine1, setAddressLine1] = useState('')
  const [city, setCity] = useState('')
  const [state, setState] = useState('')
  const [zip, setZip] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    // organization_id must be set explicitly: it's NOT NULL, and the
    // properties_write policy checks has_org_role(organization_id, admin) —
    // so omitting it fails as "new row violates row-level security policy"
    // rather than as the missing-column error it actually is.
    const { error } = await supabase.from('properties').insert({
      organization_id: organizationId,
      name,
      address_line1: addressLine1,
      city,
      state: state.toUpperCase(),
      zip,
    })
    setBusy(false)
    if (error) setError(describeError(error))
    else onAdded()
  }

  return (
    <form onSubmit={submit} style={{ margin: '1rem 0' }} className="card-list">
      <div>
        <div className="field">
          <label htmlFor="p-name">Name</label>
          <input id="p-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-addr">Address</label>
          <input id="p-addr" required value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-city">City</label>
          <input id="p-city" required value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-state">State (2-letter)</label>
          <input id="p-state" required maxLength={2} value={state}
            onChange={(e) => setState(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-zip">ZIP</label>
          <input id="p-zip" required value={zip} onChange={(e) => setZip(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add property'}
        </button>
      </div>
    </form>
  )
}
