import { useEffect, useState } from 'react'
import { supabase, describeError } from '../lib/supabase'
import { navigate } from '../lib/route'
import type { Unit } from '../lib/units'
import { EquipmentList } from './EquipmentList'

type TechProperty = {
  id: string
  name: string
  address_line1: string
  city: string
  state: string
  zip: string
  units: Pick<Unit, 'id' | 'label' | 'bedrooms' | 'bathrooms'>[]
}

type Props = {
  memberId: string
  /** From the URL: /properties/<id>. */
  propertyId?: string
}

/**
 * The properties a technician services, and what is installed in them.
 *
 * Which properties appear is decided entirely by RLS — properties_read and
 * units_read let a technician see what technician_property_access scopes
 * them to — so this screen asks for everything and gets only theirs.
 */
export function TechnicianProperties({ memberId, propertyId }: Props) {
  const [properties, setProperties] = useState<TechProperty[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('properties')
      .select('id, name, address_line1, city, state, zip, units(id, label, bedrooms, bathrooms)')
      .order('name')
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setProperties(data as unknown as TechProperty[])
      })
  }, [])

  const open = propertyId ? properties?.find((p) => p.id === propertyId) ?? null : null

  if (propertyId && properties && !open) {
    return (
      <div>
        <button className="link" onClick={() => navigate('/properties')}>← All properties</button>
        <p className="empty-state">
          That property isn't on your list. Your access may have changed —
          ask your property manager.
        </p>
      </div>
    )
  }

  if (open) return <PropertyView property={open} memberId={memberId} />

  return (
    <div>
      <h2>Properties you service</h2>
      {error && <p className="error-text">{error}</p>}
      {properties === null && !error && <p className="muted">Loading…</p>}
      {properties?.length === 0 && (
        <p className="empty-state">
          You haven't been given any properties yet. Your property manager
          chooses which ones you service in Settings → Your team.
        </p>
      )}
      <div className="card-list">
        {properties?.map((p) => (
          <div
            key={p.id}
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => navigate('/properties', { id: p.id })}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                navigate('/properties', { id: p.id })
              }
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <strong>{p.name}</strong>
              <span className="muted">
                {p.units.length} unit{p.units.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="muted">{p.address_line1}, {p.city}, {p.state} {p.zip}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function PropertyView({ property, memberId }: { property: TechProperty; memberId: string }) {
  const units = [...property.units].sort((a, b) => a.label.localeCompare(b.label))
  // A single-unit house has nothing to choose between, so it opens on its
  // one unit rather than on a list of one.
  const single = units.length === 1
  const [unitId, setUnitId] = useState<string | null>(single ? units[0].id : null)
  const unit = units.find((u) => u.id === unitId) ?? null

  useEffect(() => { setUnitId(single ? units[0].id : null) }, [property.id])

  const address = `${property.address_line1}, ${property.city}, ${property.state} ${property.zip}`

  if (unit) {
    return (
      <div>
        <button className="link"
          onClick={() => (single ? navigate('/properties') : setUnitId(null))}>
          ← {single ? 'All properties' : `All units at ${property.name}`}
        </button>
        <h2 style={{ marginBottom: 0 }}>
          {property.name}{single ? '' : ` · ${unit.label}`}
        </h2>
        <p className="muted" style={{ marginTop: '0.25rem' }}>{address}</p>
        <h3>Equipment</h3>
        <EquipmentList propertyId={property.id} unitId={unit.id}
          memberId={memberId} canDelete={false} />
      </div>
    )
  }

  return (
    <div>
      <button className="link" onClick={() => navigate('/properties')}>← All properties</button>
      <h2 style={{ marginBottom: 0 }}>{property.name}</h2>
      <p className="muted" style={{ marginTop: '0.25rem' }}>{address}</p>

      <h3>Choose a unit</h3>
      {units.length === 0 && <p className="empty-state">No units recorded at this property.</p>}
      <div className="card-list">
        {units.map((u) => (
          <div
            key={u.id}
            role="button"
            tabIndex={0}
            style={{ cursor: 'pointer' }}
            onClick={() => { setUnitId(u.id); window.scrollTo(0, 0) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setUnitId(u.id)
              }
            }}
          >
            <strong>{u.label}</strong>
            <div className="muted">
              {[
                u.bedrooms != null ? `${u.bedrooms} bd` : null,
                u.bathrooms != null ? `${u.bathrooms} ba` : null,
              ].filter(Boolean).join(' · ') || 'View equipment'}
            </div>
          </div>
        ))}
      </div>

      {/* The shared boiler or laundry-room washer belongs to no one unit,
          so it is shown here as well as inside each unit. */}
      <h3 style={{ marginTop: '2rem' }}>Shared with the building</h3>
      <EquipmentList propertyId={property.id} unitId={null}
        memberId={memberId} canDelete={false} />
    </div>
  )
}
