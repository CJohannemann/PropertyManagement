import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'
import { PropertyDetail, type PropertySummary } from '../PropertyDetail'
import { RentStatus } from '../RentStatus'
import { RentOverview } from '../RentOverview'
import { LeaseTemplates } from '../LeaseTemplates'
import { MaintenanceRequests } from '../MaintenanceRequests'
import { GettingPaid } from '../GettingPaid'

type Property = PropertySummary & { units: { id: string }[] }

type Props = { organizationId: string; organizationName: string; memberId: string }

export function AdminDashboard({ organizationId, organizationName, memberId }: Props) {
  const [properties, setProperties] = useState<Property[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
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
    // organizationId isn't in the query — RLS already scopes `properties`
    // to the caller's org — but a different org's admin sees different
    // rows, so it's the effect's real dependency.
  }, [organizationId])

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
        canManageUnits
        organizationName={organizationName}
        onBack={() => { setSelected(null); load() }}
      />
    )
  }

  return (
    <div>
      <h2>Rent status</h2>
      <RentOverview organizationId={organizationId} />
      <div style={{ marginTop: '1rem' }}>
        <RentStatus />
      </div>

      <div style={{ marginTop: '2rem' }}>
        <GettingPaid organizationId={organizationId} />
      </div>

      <div style={{ marginTop: '2rem' }}>
        <MaintenanceRequests organizationId={organizationId} memberId={memberId} />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2rem' }}>
        <h2>Properties</h2>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button className="link" onClick={() => setShowTemplates(true)}>
            Lease templates
          </button>
          <button className="link" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Cancel' : '+ Add property'}
          </button>
        </div>
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
          <div key={p.id} onClick={() => setSelected(p)} style={{ cursor: 'pointer' }}>
            <strong>{p.name}</strong>
            <div className="muted">
              {p.address_line1}, {p.city}, {p.state} {p.zip}
            </div>
            <div className="muted">{p.units.length} unit(s)</div>
          </div>
        ))}
      </div>
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
