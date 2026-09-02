import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'

type Property = {
  id: string
  name: string
  address_line1: string
  city: string
  state: string
  zip: string
  units: { id: string }[]
}

type Props = { organizationId: string }

export function AdminDashboard({ organizationId }: Props) {
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
    // organizationId isn't used directly in the query — RLS already scopes
    // `properties` to the caller's org — but it's the effect's real
    // dependency conceptually (a different org's admin sees different
    // rows), so it's listed here for correctness even though the query
    // itself doesn't reference it.
  }, [organizationId])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>Properties</h2>
        <button className="link" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : '+ Add property'}
        </button>
      </div>

      {showForm && (
        <AddPropertyForm
          onAdded={() => {
            setShowForm(false)
            load()
          }}
        />
      )}

      {error && <p className="error-text">{error}</p>}

      {properties === null && !error && <p className="muted">Loading…</p>}

      {properties?.length === 0 && (
        <p className="empty-state">
          No properties yet — add your first one above.
        </p>
      )}

      <div className="card-list">
        {properties?.map((p) => (
          <div key={p.id}>
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

function AddPropertyForm({ onAdded }: { onAdded: () => void }) {
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
    const { error } = await supabase.from('properties').insert({
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
          <input
            id="p-addr"
            required
            value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="p-city">City</label>
          <input id="p-city" required value={city} onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="p-state">State (2-letter)</label>
          <input
            id="p-state"
            required
            maxLength={2}
            value={state}
            onChange={(e) => setState(e.target.value)}
          />
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
