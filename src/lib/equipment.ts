import { supabase } from './supabase'

/**
 * What is installed where — see db/migrations/030_equipment.sql.
 *
 * unit_id null means the item serves the whole building (a shared boiler,
 * the laundry-room washer) rather than one unit.
 */
export type Equipment = {
  id: string
  property_id: string
  unit_id: string | null
  category: EquipmentCategory
  make: string | null
  model: string | null
  serial_number: string | null
  location: string | null
  install_date: string | null
  notes: string | null
}

export const EQUIPMENT_CATEGORIES = [
  'water_heater', 'furnace', 'air_conditioner', 'heat_pump', 'boiler',
  'dishwasher', 'refrigerator', 'range', 'microwave', 'washer', 'dryer',
  'garbage_disposal', 'other',
] as const

export type EquipmentCategory = (typeof EQUIPMENT_CATEGORIES)[number]

export const EQUIPMENT_LABEL: Record<EquipmentCategory, string> = {
  water_heater: 'Water heater',
  furnace: 'Furnace',
  air_conditioner: 'Air conditioner',
  heat_pump: 'Heat pump',
  boiler: 'Boiler',
  dishwasher: 'Dishwasher',
  refrigerator: 'Refrigerator',
  range: 'Range / oven',
  microwave: 'Microwave',
  washer: 'Washer',
  dryer: 'Dryer',
  garbage_disposal: 'Garbage disposal',
  other: 'Other',
}

const COLUMNS =
  'id, property_id, unit_id, category, make, model, serial_number, location, install_date, notes'

/**
 * A unit's equipment plus the building's shared equipment — both are what
 * a technician standing in that unit might be working on. With no unit,
 * every row at the property.
 */
export async function fetchEquipment(
  propertyId: string, unitId?: string | null,
): Promise<Equipment[]> {
  if (!supabase) return []
  let q = supabase.from('equipment').select(COLUMNS).eq('property_id', propertyId)
  if (unitId) q = q.or(`unit_id.eq.${unitId},unit_id.is.null`)
  const { data, error } = await q.order('category').order('created_at')
  if (error) throw error
  return data as Equipment[]
}

export type EquipmentInput = Omit<Equipment, 'id'>

/** Blank text is stored as null, so "not recorded" has one spelling. */
function clean(input: EquipmentInput): EquipmentInput {
  const t = (s: string | null) => (s && s.trim() ? s.trim() : null)
  return {
    property_id: input.property_id,
    unit_id: input.unit_id,
    category: input.category,
    make: t(input.make),
    model: t(input.model),
    serial_number: t(input.serial_number),
    location: t(input.location),
    install_date: input.install_date || null,
    notes: t(input.notes),
  }
}

export async function createEquipment(input: EquipmentInput, memberId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase
    .from('equipment')
    .insert({ ...clean(input), created_by: memberId })
  if (error) throw error
}

export async function updateEquipment(id: string, input: EquipmentInput): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('equipment').update(clean(input)).eq('id', id)
  if (error) throw error
}

/**
 * Office-only (RLS). A disallowed delete is filtered to zero rows rather
 * than raising, so the row count is checked to make that an error instead
 * of a silent no-op.
 */
export async function deleteEquipment(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.from('equipment').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data || data.length === 0) throw new Error('You do not have permission to remove this.')
}

/** Age in whole years from an install date, or null if unknown. */
export function ageInYears(installDate: string | null, today = new Date()): number | null {
  if (!installDate) return null
  const d = new Date(`${installDate}T00:00:00`)
  if (Number.isNaN(d.getTime())) return null
  let years = today.getFullYear() - d.getFullYear()
  const beforeAnniversary =
    today.getMonth() < d.getMonth()
    || (today.getMonth() === d.getMonth() && today.getDate() < d.getDate())
  if (beforeAnniversary) years -= 1
  return Math.max(0, years)
}

/**
 * A web search for the item's manual — the thing a technician wants the
 * make and model *for*. Null until there is at least a model to search.
 */
export function manualSearchUrl(e: Pick<Equipment, 'make' | 'model' | 'category'>): string | null {
  if (!e.model) return null
  const q = [e.make, e.model, EQUIPMENT_LABEL[e.category], 'manual']
    .filter(Boolean).join(' ')
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}

// ------------------------------------------------- technician access --

export type TechnicianAccess = { all: boolean; propertyIds: string[] }

export async function fetchTechnicianAccess(memberId: string): Promise<TechnicianAccess> {
  if (!supabase) return { all: false, propertyIds: [] }
  const { data, error } = await supabase
    .from('technician_property_access')
    .select('property_id')
    .eq('org_member_id', memberId)
  if (error) throw error
  const rows = data as { property_id: string | null }[]
  return {
    all: rows.some((r) => r.property_id === null),
    propertyIds: rows.flatMap((r) => (r.property_id ? [r.property_id] : [])),
  }
}

export async function setTechnicianAccess(memberId: string, access: TechnicianAccess): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.rpc('set_technician_access', {
    member: memberId,
    all_properties: access.all,
    property_ids: access.all ? [] : access.propertyIds,
  })
  if (error) throw error
}
