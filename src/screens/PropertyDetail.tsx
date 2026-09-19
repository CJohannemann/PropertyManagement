import { errorMessage, supabase, describeError } from '../lib/supabase'
import { useEffect, useState } from 'react'
import { fetchUnits, createUnit, updateUnit, type Unit } from '../lib/units'
import {
  fetchLeasesForUnit, fetchLeaseTenants, type Lease, type LeaseTenant,
} from '../lib/leases'
import { LeaseForm } from './LeaseForm'
import { InviteTenant } from './InviteTenant'
import { LeaseDocument } from './LeaseDocument'
import { fetchSigningStatus, type SigningStatus } from '../lib/signatures'

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
  /**
   * Property managers can do everything here except add, remove or edit
   * units and the property itself — properties_write and units_write are
   * both admin-only in db/schema.sql.
   */
  canManageUnits: boolean
  organizationName: string
  onBack: () => void
  /** Reloads the caller's property list after an edit, so the header here
   *  and the row it was opened from don't disagree. */
  onPropertyChanged: () => void
}

export function PropertyDetail({
  property, canManageUnits, organizationName, onBack, onPropertyChanged,
}: Props) {
  const [units, setUnits] = useState<Unit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addingUnit, setAddingUnit] = useState(false)
  const [editingProperty, setEditingProperty] = useState(false)

  async function load() {
    try {
      setUnits(await fetchUnits(property.id))
    } catch (e) {
      setError(errorMessage(e))
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
        {canManageUnits && !editingProperty && (
          <>
            {' · '}
            <button className="link" onClick={() => setEditingProperty(true)}>
              Edit
            </button>
          </>
        )}
      </p>

      {editingProperty && (
        <PropertyForm
          property={property}
          onSaved={() => { setEditingProperty(false); onPropertyChanged() }}
          onCancel={() => setEditingProperty(false)}
        />
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3>Units</h3>
        {canManageUnits && (
          <button className="link" onClick={() => setAddingUnit((s) => !s)}>
            {addingUnit ? 'Cancel' : '+ Add unit'}
          </button>
        )}
      </div>

      {addingUnit && (
        <UnitForm
          propertyId={property.id}
          onSaved={() => { setAddingUnit(false); load() }}
          onCancel={() => setAddingUnit(false)}
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
            canManageUnits={canManageUnits}
            onUnitChanged={load}
            organizationName={organizationName} />
        ))}
      </div>
    </div>
  )
}

function UnitRow({
  unit, property, organizationName, canManageUnits, onUnitChanged,
}: {
  unit: Unit
  property: PropertySummary
  organizationName: string
  canManageUnits: boolean
  onUnitChanged: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [leases, setLeases] = useState<Lease[] | null>(null)
  const [tenants, setTenants] = useState<Record<string, LeaseTenant[]>>({})
  const [creatingLease, setCreatingLease] = useState(false)
  const [editingLease, setEditingLease] = useState<string | null>(null)
  const [invitingFor, setInvitingFor] = useState<string | null>(null)
  const [viewingDoc, setViewingDoc] = useState<Lease | null>(null)
  const [signing, setSigning] = useState<Record<string, SigningStatus>>({})
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const ls = await fetchLeasesForUnit(unit.id)
      setLeases(ls)
      const people: Record<string, LeaseTenant[]> = {}
      const sigs: Record<string, SigningStatus> = {}
      for (const l of ls) {
        people[l.id] = await fetchLeaseTenants(l.id)
        const st = await fetchSigningStatus(l.id)
        if (st) sigs[l.id] = st
      }
      setTenants(people)
      setSigning(sigs)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  useEffect(() => {
    load()
  }, [unit.id])

  const activeLease = leases?.find((l) => l.status === 'active') ?? null
  // Correctable right up until somebody signs it, and not after: a
  // signature is what turns typed-in terms into an agreement, and the
  // database stops bringing the charges along at the same moment. See
  // db/migrations/028_editable_draft_leases.sql.
  const activeSigning = activeLease ? signing[activeLease.id] : undefined
  const leaseIsDraft =
    !activeSigning?.tenant_signed && !activeSigning?.landlord_signed

  if (viewingDoc) {
    return (
      <LeaseDocument
        signable
        onSigned={load}
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
        {/* Derived from whether a lease is actually running, not read off
            units.status. Nothing has ever written that column — it is
            'vacant' from its default and stays that way — so a unit with a
            signed tenant and overdue rent still announced itself as
            vacant. 'maintenance' is the one value there that is a real
            decision someone made, so it still wins when set. */}
        <span className="muted">
          {unit.status === 'maintenance'
            ? 'maintenance'
            : activeLease ? 'occupied' : 'vacant'}
        </span>
      </div>
      <div className="muted">
        {[
          unit.bedrooms != null ? `${unit.bedrooms} bd` : null,
          unit.bathrooms != null ? `${unit.bathrooms} ba` : null,
          unit.sqft != null ? `${unit.sqft} sqft` : null,
        ].filter(Boolean).join(' · ') || 'No details recorded'}
        {canManageUnits && !editing && (
          <>
            {' · '}
            <button className="link" onClick={() => setEditing(true)}>Edit</button>
          </>
        )}
      </div>

      {editing && (
        <UnitForm
          propertyId={property.id}
          unit={unit}
          onSaved={() => { setEditing(false); onUnitChanged() }}
          onCancel={() => setEditing(false)}
        />
      )}

      {error && <p className="error-text">{error}</p>}

      {activeLease && editingLease === activeLease.id ? (
        <LeaseForm
          unitId={unit.id}
          stateCode={property.state}
          lease={activeLease}
          onCreated={() => { setEditingLease(null); load() }}
          onCancel={() => setEditingLease(null)}
        />
      ) : activeLease ? (
        <div style={{ marginTop: '0.5rem' }}>
          <div>
            ${activeLease.rent_amount}/mo, due day {activeLease.rent_due_day}
            {activeLease.end_date === null
              ? ' · month-to-month'
              : ` · ends ${activeLease.end_date}`}
          </div>
          {/* Named, not counted. "2 tenant(s)" was true and useless — the
              question a landlord actually has is which two, and whether
              the second one ever accepted their invite. */}
          <div className="muted">
            {(tenants[activeLease.id]?.length ?? 0) === 0
              ? 'No tenant yet'
              : tenants[activeLease.id].map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && ', '}
                    {t.org_members?.full_name ?? 'Unnamed'}
                    {t.is_primary && ' (primary)'}
                    {t.org_members?.status === 'disabled' && ' — access removed'}
                  </span>
                ))}
          </div>
          <div className="muted">
            {signing[activeLease.id]?.fully_executed
              ? 'Lease signed by both parties'
              : signing[activeLease.id]?.tenant_signed
                ? 'Tenant has signed — needs your countersignature'
                : signing[activeLease.id]?.landlord_signed
                  ? 'You have signed — waiting on the tenant'
                  : 'Not signed yet'}
          </div>
          <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
            <button className="link" onClick={() => setViewingDoc(activeLease)}>
              View / sign lease
            </button>
            {/* Not offered once it is signed, rather than offered and then
                refused: the answer to "why can't I change this?" is the
                signature, and a button that only ever errors doesn't say
                so. */}
            {leaseIsDraft && (
              <button className="link" onClick={() => setEditingLease(activeLease.id)}>
                Edit lease
              </button>
            )}
            {/* Offered however many tenants are already on the lease.
                Gating this on "nobody yet" made a roommate, a spouse or a
                co-signer impossible to add — lease_tenants has always been
                a list with an is_primary flag, and the UI was the only
                thing insisting a lease held one person. */}
            {invitingFor !== activeLease.id && (
              <button className="link" onClick={() => setInvitingFor(activeLease.id)}>
                {(tenants[activeLease.id]?.length ?? 0) === 0
                  ? 'Invite tenant'
                  : 'Invite another tenant'}
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

/**
 * Correcting a property's name or address.
 *
 * Editing rather than replacing matters more here than it looks: the
 * address is what a lease document prints as the premises, and the state
 * is what the late-fee rules are checked against. A typo fixed here fixes
 * both, where deleting and re-adding would orphan every unit under it.
 */
function PropertyForm({
  property, onSaved, onCancel,
}: { property: PropertySummary; onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState(property.name)
  const [addressLine1, setAddressLine1] = useState(property.address_line1)
  const [city, setCity] = useState(property.city)
  const [state, setState] = useState(property.state)
  const [zip, setZip] = useState(property.zip)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!supabase) return
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('properties')
      .update({
        name,
        address_line1: addressLine1,
        city,
        state: state.toUpperCase(),
        zip,
      })
      .eq('id', property.id)
    if (error) {
      setError(describeError(error))
      setBusy(false)
      return
    }
    onSaved()
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '0.5rem' }}>
      <div>
        <div className="field">
          <label htmlFor="ep-name">Name</label>
          <input id="ep-name" required value={name}
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep-addr">Address</label>
          <input id="ep-addr" required value={addressLine1}
            onChange={(e) => setAddressLine1(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep-city">City</label>
          <input id="ep-city" required value={city}
            onChange={(e) => setCity(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ep-state">State (2-letter)</label>
          <input id="ep-state" required maxLength={2} value={state}
            onChange={(e) => setState(e.target.value)} />
          <span className="muted">
            The state decides which late-fee rules a new lease is checked
            against.
          </span>
        </div>
        <div className="field">
          <label htmlFor="ep-zip">ZIP</label>
          <input id="ep-zip" required value={zip}
            onChange={(e) => setZip(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button className="link" type="button" onClick={onCancel}
          style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/** Adds a unit, or corrects one — the same fields either way. */
function UnitForm({
  propertyId, unit, onSaved, onCancel,
}: {
  propertyId: string
  unit?: Unit
  onSaved: () => void
  onCancel: () => void
}) {
  const [label, setLabel] = useState(unit?.label ?? '')
  const [bedrooms, setBedrooms] = useState(unit?.bedrooms?.toString() ?? '')
  const [bathrooms, setBathrooms] = useState(unit?.bathrooms?.toString() ?? '')
  const [sqft, setSqft] = useState(unit?.sqft?.toString() ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const fields = {
      label,
      bedrooms: bedrooms ? Number(bedrooms) : null,
      bathrooms: bathrooms ? Number(bathrooms) : null,
      sqft: sqft ? Number(sqft) : null,
    }
    try {
      if (unit) await updateUnit(unit.id, fields)
      else await createUnit({ propertyId, ...fields })
      onSaved()
    } catch (err) {
      setError(errorMessage(err))
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
          {busy ? 'Saving…' : unit ? 'Save changes' : 'Add unit'}
        </button>
        <button className="link" type="button" onClick={onCancel}
          style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
