import { supabase } from './supabase'

export type Unit = {
  id: string
  property_id: string
  label: string
  bedrooms: number | null
  bathrooms: number | null
  sqft: number | null
  status: 'vacant' | 'occupied' | 'maintenance'
}

export async function fetchUnits(propertyId: string): Promise<Unit[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('units')
    .select('id, property_id, label, bedrooms, bathrooms, sqft, status')
    .eq('property_id', propertyId)
    .order('label')
  if (error) throw error
  return data as Unit[]
}

/**
 * Corrects a unit's details. The RLS write policy on `units` is admin-only,
 * which is the same rule that governs adding one — a property manager sees
 * the form disabled rather than a rejection.
 *
 * `status` is deliberately not editable here: nothing has ever written that
 * column, occupancy is derived from whether a lease is running (see the
 * comment in PropertyDetail.tsx), and offering a dropdown that sets it
 * would put a stale value back in the way of a derived one.
 */
export async function updateUnit(id: string, input: {
  label: string
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
}): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase
    .from('units')
    .update({
      label: input.label,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      sqft: input.sqft ?? null,
    })
    .eq('id', id)
  if (error) throw error
}

export async function createUnit(input: {
  propertyId: string
  label: string
  bedrooms?: number | null
  bathrooms?: number | null
  sqft?: number | null
}): Promise<Unit> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase
    .from('units')
    .insert({
      property_id: input.propertyId,
      label: input.label,
      bedrooms: input.bedrooms ?? null,
      bathrooms: input.bathrooms ?? null,
      sqft: input.sqft ?? null,
    })
    .select('id, property_id, label, bedrooms, bathrooms, sqft, status')
    .single()
  if (error) throw error
  return data as Unit
}
