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
