import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import {
  fetchEquipment, createEquipment, updateEquipment, deleteEquipment,
  ageInYears, manualSearchUrl,
  EQUIPMENT_CATEGORIES, EQUIPMENT_LABEL,
  type Equipment, type EquipmentInput,
} from '../lib/equipment'

type Props = {
  propertyId: string
  /**
   * The unit being looked at. Shows that unit's equipment and, separately,
   * the building's shared equipment — both are things a technician in the
   * unit might be fixing. Null shows only the shared equipment.
   */
  unitId: string | null
  /** The viewer's org_members id, recorded as who added a row. */
  memberId: string
  /** Office staff can delete; a technician can add and correct. */
  canDelete: boolean
  /** Hides the add/edit controls — e.g. a completed job. */
  readOnly?: boolean
}

/**
 * The inventory of what is installed: make, model, serial, age.
 *
 * Shared by the technician's unit screen, the office's property screen and
 * the job screen, so the same item reads the same way wherever it's seen.
 */
export function EquipmentList({ propertyId, unitId, memberId, canDelete, readOnly }: Props) {
  const [items, setItems] = useState<Equipment[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  async function load() {
    try {
      const rows = await fetchEquipment(propertyId, unitId)
      setItems(unitId ? rows : rows.filter((r) => r.unit_id === null))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  useEffect(() => { load() }, [propertyId, unitId])

  const inUnit = items?.filter((i) => unitId && i.unit_id === unitId) ?? []
  const shared = items?.filter((i) => i.unit_id === null) ?? []

  function rows(list: Equipment[]) {
    return (
      <div className="card-list">
        {list.map((item) => editing === item.id ? (
          <div key={item.id}>
            <EquipmentForm
              propertyId={propertyId}
              unitId={unitId}
              item={item}
              onSave={async (input) => { await updateEquipment(item.id, input); setEditing(null); load() }}
              onDelete={canDelete
                ? async () => { await deleteEquipment(item.id); setEditing(null); load() }
                : undefined}
              onCancel={() => setEditing(null)}
            />
          </div>
        ) : (
          <EquipmentRow key={item.id} item={item}
            onEdit={readOnly ? undefined : () => { setAdding(false); setEditing(item.id) }} />
        ))}
      </div>
    )
  }

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      {items === null && !error && <p className="muted">Loading…</p>}

      {items !== null && items.length === 0 && !adding && (
        <p className="empty-state" style={{ paddingBottom: 0 }}>
          No equipment recorded yet.
          {!readOnly && ' Add the water heater, HVAC and appliances so the make and model are on hand for the next repair.'}
        </p>
      )}

      {unitId && inUnit.length > 0 && rows(inUnit)}

      {shared.length > 0 && (
        <>
          {unitId && (
            <h4 style={{ margin: '1.25rem 0 0' }}>Shared with the building</h4>
          )}
          {rows(shared)}
        </>
      )}

      {!readOnly && (adding ? (
        <div className="card-list">
          <div>
            <EquipmentForm
              propertyId={propertyId}
              unitId={unitId}
              onSave={async (input) => { await createEquipment(input, memberId); setAdding(false); load() }}
              onCancel={() => setAdding(false)}
            />
          </div>
        </div>
      ) : (
        <button className="link" style={{ marginTop: '0.75rem' }}
          onClick={() => { setEditing(null); setAdding(true) }}>
          + Add equipment
        </button>
      ))}
    </div>
  )
}

function EquipmentRow({ item, onEdit }: { item: Equipment; onEdit?: () => void }) {
  const age = ageInYears(item.install_date)
  const manual = manualSearchUrl(item)
  const makeModel = [item.make, item.model].filter(Boolean).join(' ')

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '0.5rem' }}>
        <strong>{EQUIPMENT_LABEL[item.category]}</strong>
        {item.location && <span className="muted">{item.location}</span>}
      </div>
      {/* The make and model are the reason this screen exists, so they get
          the most prominent line — and say so plainly when missing rather
          than leaving a gap that reads as "nothing to know". */}
      <div style={{ fontSize: '1.05rem', marginTop: '0.25rem' }}>
        {makeModel || <span className="muted">Make and model not recorded</span>}
      </div>
      <div className="muted">
        {[
          item.serial_number ? `Serial ${item.serial_number}` : null,
          item.install_date
            ? `Installed ${item.install_date}${age !== null ? ` (${age} yr${age === 1 ? '' : 's'})` : ''}`
            : null,
        ].filter(Boolean).join(' · ')}
      </div>
      {item.notes && <div className="muted" style={{ marginTop: '0.25rem' }}>{item.notes}</div>}
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
        {manual && (
          <a className="link-text" href={manual} target="_blank" rel="noreferrer">
            Look up manual ↗
          </a>
        )}
        {onEdit && <button className="link" onClick={onEdit}>Edit</button>}
      </div>
    </div>
  )
}

function EquipmentForm({
  propertyId, unitId, item, onSave, onDelete, onCancel,
}: {
  propertyId: string
  unitId: string | null
  item?: Equipment
  onSave: (input: EquipmentInput) => Promise<void>
  onDelete?: () => Promise<void>
  onCancel: () => void
}) {
  const [category, setCategory] = useState<Equipment['category']>(item?.category ?? 'water_heater')
  // Whether it belongs to this unit or the building. Only a choice when
  // there is a unit to belong to.
  const [shared, setShared] = useState(item ? item.unit_id === null : unitId === null)
  const [make, setMake] = useState(item?.make ?? '')
  const [model, setModel] = useState(item?.model ?? '')
  const [serial, setSerial] = useState(item?.serial_number ?? '')
  const [location, setLocation] = useState(item?.location ?? '')
  const [installDate, setInstallDate] = useState(item?.install_date ?? '')
  const [notes, setNotes] = useState(item?.notes ?? '')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const idp = item?.id ?? 'new'

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    run(() => onSave({
      property_id: propertyId,
      // Keeps an item's own unit when edited from a view without one.
      unit_id: shared ? null : (unitId ?? item?.unit_id ?? null),
      category,
      make,
      model,
      serial_number: serial,
      location,
      install_date: installDate || null,
      notes,
    }))
  }

  return (
    <form onSubmit={submit}>
      <div className="field">
        <label htmlFor={`eq-cat-${idp}`}>Type</label>
        <select id={`eq-cat-${idp}`} value={category}
          onChange={(e) => setCategory(e.target.value as Equipment['category'])}>
          {EQUIPMENT_CATEGORIES.map((c) => (
            <option key={c} value={c}>{EQUIPMENT_LABEL[c]}</option>
          ))}
        </select>
      </div>
      {unitId && (
        <div className="field">
          <span className="muted">Serves</span>
          <div className="seg" role="radiogroup" aria-label="Serves">
            <button type="button" role="radio" aria-checked={!shared}
              className={!shared ? 'seg-item is-current' : 'seg-item'}
              onClick={() => setShared(false)}>This unit</button>
            <button type="button" role="radio" aria-checked={shared}
              className={shared ? 'seg-item is-current' : 'seg-item'}
              onClick={() => setShared(true)}>Whole building</button>
          </div>
        </div>
      )}
      <div className="field">
        <label htmlFor={`eq-make-${idp}`}>Make</label>
        <input id={`eq-make-${idp}`} value={make} placeholder="e.g. Rheem"
          onChange={(e) => setMake(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`eq-model-${idp}`}>Model number</label>
        <input id={`eq-model-${idp}`} value={model} placeholder="From the data plate"
          onChange={(e) => setModel(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`eq-serial-${idp}`}>Serial number</label>
        <input id={`eq-serial-${idp}`} value={serial}
          onChange={(e) => setSerial(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`eq-loc-${idp}`}>Location</label>
        <input id={`eq-loc-${idp}`} value={location} placeholder="e.g. Basement, hall closet"
          onChange={(e) => setLocation(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`eq-date-${idp}`}>Installed</label>
        <input id={`eq-date-${idp}`} type="date" value={installDate}
          onChange={(e) => setInstallDate(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`eq-notes-${idp}`}>Notes</label>
        <textarea id={`eq-notes-${idp}`} rows={2} value={notes}
          placeholder="Filter size, warranty, last service…"
          onChange={(e) => setNotes(e.target.value)} />
      </div>
      {error && <p className="error-text">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Saving…' : item ? 'Save changes' : 'Add equipment'}
      </button>
      <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
        <button className="link" type="button" onClick={onCancel}>Cancel</button>
        {onDelete && (confirmingDelete ? (
          <>
            <button className="link" type="button" disabled={busy}
              style={{ color: 'var(--danger)' }} onClick={() => run(onDelete)}>
              Yes, remove it
            </button>
            <button className="link" type="button" onClick={() => setConfirmingDelete(false)}>
              Keep it
            </button>
          </>
        ) : (
          <button className="link" type="button" style={{ color: 'var(--danger)' }}
            onClick={() => setConfirmingDelete(true)}>
            Remove
          </button>
        ))}
      </div>
    </form>
  )
}
