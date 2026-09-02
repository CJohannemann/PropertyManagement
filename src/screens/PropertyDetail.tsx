import { useEffect, useState } from 'react'
import { fetchUnits, createUnit, type Unit } from '../lib/units'
import { fetchLeasesForUnit, fetchLeaseTenants, type Lease } from '../lib/leases'
import { LeaseForm } from './LeaseForm'
import { InviteTenant } from './InviteTenant'
import { LeaseDocument } from './LeaseDocument'

export type PropertySummary = {
  id: string
  name: string
  address_line1: string
  city: string
  state: string
  zip: string
}

type Props = {
  property: PropertySummary
  /** Property managers can do everything here except add/remove units. */
  canManageUnits: boolean
  organizationName: string
  onBack: () => void
}

export function PropertyDetail({
  property, canManageUnits, organizationName, onBack,
}: Props) {
  const [units, setUnits] = useState<Unit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingUnit, setAddingUnit] = useState(false)

  async function load() {
    try {
      setUnits(await fetchUnits(property.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
  }, [property.id])

  return (
    <div>
      <button className="link" onClick={onBack}>← All properties</button>
      <h2 style={{ marginBottom: 0 }}>{property.name}</h2>
      <p className="muted" style={{ marginTop: '0.25rem' }}>
        {property.address_line1}, {property.city}, {property.state} {property.zip}
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Units</h3>
        {canManageUnits && (
          <button className="link" onClick={() => setAddingUnit((s) => !s)}>
            {addingUnit ? 'Cancel' : '+ Add unit'}
          </button>
        )}
      </div>

      {addingUnit && (
        <AddUnitForm
          propertyId={property.id}
          onAdded={() => { setAddingUnit(false); load() }}
        />
      )}

      {error && <p className="error-text">{error}</p>}
      {units === null && !error && <p className="muted">Loading…</p>}
      {units?.length === 0 && (
        <p className="empty-state">
          No units yet{canManageUnits ? ' — add the first one above.' : '.'}
        </p>
      )}

      <div className="card-list">
        {units?.map((u) => (
          <UnitRow key={u.id} unit={u} property={property}
            organizationName={organizationName} />
        ))}
      </div>
    </div>
  )
}

function UnitRow({
  unit, property, organizationName,
}: { unit: Unit; property: PropertySummary; organizationName: string }) {
  const [leases, setLeases] = useState<Lease[] | null>(null)
  const [tenantCounts, setTenantCounts] = useState<Record<string, number>>({})
  const [creatingLease, setCreatingLease] = useState(false)
  const [invitingFor, setInvitingFor] = useState<string | null>(null)
  const [viewingDoc, setViewingDoc] = useState<Lease | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const ls = await fetchLeasesForUnit(unit.id)
      setLeases(ls)
      // Whether a lease already has someone on it decides between "Invite
      // tenant" and just showing the count.
      const counts: Record<string, number> = {}
      for (const l of ls) counts[l.id] = (await fetchLeaseTenants(l.id)).length
      setTenantCounts(counts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    load()
  }, [unit.id])

  const activeLease = leases?.find((l) => l.status === 'active') ?? null

  if (viewingDoc) {
    return (
      <LeaseDocument
        lease={viewingDoc}
        propertyName={property.name}
        premises={`${property.address_line1}, ${property.city}, ${property.state} ${property.zip}${
          unit.label ? ` (${unit.label})` : ''
        }`}
        stateCode={property.state}
        organizationName={organizationName}
        onClose={() => setViewingDoc(null)}
      />
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <strong>{unit.label}</strong>
        <span className="muted">{unit.status}</span>
      </div>
      <div className="muted">
        {[
          unit.bedrooms != null ? `${unit.bedrooms} bd` : null,
          unit.bathrooms != null ? `${unit.bathrooms} ba` : null,
          unit.sqft != null ? `${unit.sqft} sqft` : null,
        ].filter(Boolean).join(' · ') || 'No details recorded'}
      </div>

      {error && <p className="error-text">{error}</p>}

      {activeLease ? (
        <div style={{ marginTop: '0.5rem' }}>
          <div>
            ${activeLease.rent_amount}/mo, due day {activeLease.rent_due_day}
            {' · '}
            {tenantCounts[activeLease.id] > 0
              ? `${tenantCounts[activeLease.id]} tenant(s)`
              : 'no tenant yet'}
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <button className="link" onClick={() => setViewingDoc(activeLease)}>
              View / print lease
            </button>
            {tenantCounts[activeLease.id] === 0 && invitingFor !== activeLease.id && (
              <button className="link" onClick={() => setInvitingFor(activeLease.id)}>
                Invite tenant
              </button>
            )}
          </div>
          {invitingFor === activeLease.id && (
            <InviteTenant
              leaseId={activeLease.id}
              onDone={() => { setInvitingFor(null); load() }}
            />
          )}
        </div>
      ) : (
        <div style={{ marginTop: '0.5rem' }}>
          {creatingLease ? (
            <LeaseForm
              unitId={unit.id}
              stateCode={property.state}
              onCreated={() => { setCreatingLease(false); load() }}
              onCancel={() => setCreatingLease(false)}
            />
          ) : (
            <button className="link" onClick={() => setCreatingLease(true)}>
              + Create lease
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function AddUnitForm({ propertyId, onAdded }: { propertyId: string; onAdded: () => void }) {
  const [label, setLabel] = useState('')
  const [bedrooms, setBedrooms] = useState('')
  const [bathrooms, setBathrooms] = useState('')
  const [sqft, setSqft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createUnit({
        propertyId,
        label,
        bedrooms: bedrooms ? Number(bedrooms) : null,
        bathrooms: bathrooms ? Number(bathrooms) : null,
        sqft: sqft ? Number(sqft) : null,
      })
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '0.5rem' }}>
      <div>
        <div className="field">
          <label htmlFor="u-label">Label (e.g. "Unit A", "Upstairs")</label>
          <input id="u-label" required value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="u-bd">Bedrooms</label>
          <input id="u-bd" type="number" min="0" step="0.5" value={bedrooms}
            onChange={(e) => setBedrooms(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="u-ba">Bathrooms</label>
          <input id="u-ba" type="number" min="0" step="0.5" value={bathrooms}
            onChange={(e) => setBathrooms(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="u-sq">Square feet</label>
          <input id="u-sq" type="number" min="0" value={sqft}
            onChange={(e) => setSqft(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add unit'}
        </button>
      </div>
    </form>
  )
}
