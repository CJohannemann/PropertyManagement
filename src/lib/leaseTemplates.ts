import { supabase } from './supabase'

export type TemplateClause = {
  id: string
  position: number
  heading: string
  body: string
  omit_if_empty: string[]
}

export type LeaseTemplate = {
  id: string
  organization_id: string
  name: string
  is_default: boolean
}

export type TemplateWithClauses = LeaseTemplate & { clauses: TemplateClause[] }

/**
 * The organization's default lease template, or null when the landlord
 * hasn't set one up. Null is a normal state, not an error: the app cannot
 * supply lease wording on a landlord's behalf, so a new organization has
 * none until it provides one.
 */
export async function fetchDefaultTemplate(): Promise<TemplateWithClauses | null> {
  if (!supabase) return null
  const { data, error } = await supabase
    .from('lease_templates')
    .select('id, organization_id, name, is_default, lease_template_clauses(id, position, heading, body, omit_if_empty)')
    .eq('is_default', true)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as unknown as LeaseTemplate & {
    lease_template_clauses: TemplateClause[]
  }
  return {
    ...row,
    clauses: [...row.lease_template_clauses].sort((a, b) => a.position - b.position),
  }
}

export async function fetchTemplates(): Promise<LeaseTemplate[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lease_templates')
    .select('id, organization_id, name, is_default')
    .order('created_at')
  if (error) throw error
  return data as LeaseTemplate[]
}

export async function createTemplate(
  organizationId: string,
  name: string,
  clauses: { heading: string; body: string; omit_if_empty?: string[] }[],
  makeDefault: boolean,
): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')

  // Clearing any existing default first: the partial unique index will
  // otherwise reject the insert, and "you already have a default" is not a
  // useful thing to make the landlord resolve by hand.
  if (makeDefault) {
    const { error: clearErr } = await supabase
      .from('lease_templates')
      .update({ is_default: false })
      .eq('organization_id', organizationId)
      .eq('is_default', true)
    if (clearErr) throw clearErr
  }

  const { data, error } = await supabase
    .from('lease_templates')
    .insert({ organization_id: organizationId, name, is_default: makeDefault })
    .select('id')
    .single()
  if (error) throw error
  const templateId = (data as { id: string }).id

  if (clauses.length) {
    const { error: clauseErr } = await supabase.from('lease_template_clauses').insert(
      clauses.map((c, i) => ({
        template_id: templateId,
        position: i,
        heading: c.heading,
        body: c.body,
        omit_if_empty: c.omit_if_empty ?? [],
      })),
    )
    if (clauseErr) throw clauseErr
  }
  return templateId
}

export async function updateClause(
  id: string,
  patch: { heading?: string; body?: string },
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('lease_template_clauses').update(patch).eq('id', id)
  if (error) throw error
}

export async function deleteClause(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('lease_template_clauses').delete().eq('id', id)
  if (error) throw error
}

export async function addClause(
  templateId: string,
  position: number,
  heading: string,
  body: string,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase
    .from('lease_template_clauses')
    .insert({ template_id: templateId, position, heading, body })
  if (error) throw error
}

/** Every placeholder the document can substitute, for the editor's help text. */
export const AVAILABLE_PLACEHOLDERS = [
  'landlord', 'tenants', 'premises', 'agreementDate', 'startDate', 'termEnd',
  'rentAmount', 'rentDueDayOrdinal', 'petRentClause', 'petsClause',
  'smokingClause', 'insuranceClause', 'parkingDescription', 'additionalTerms',
  'lateFeeClause', 'feeClause', 'state',
] as const
