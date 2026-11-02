import { supabase } from './supabase'

/**
 * Ending a lease, the lease record, and the deposit wrap-up — see
 * db/migrations/033_lease_endings.sql for the rules each of these relies on.
 */

export const END_REASONS = [
  { value: 'term_ended', label: 'Lease term ended' },
  { value: 'moved_out_early', label: 'Tenant moved out early' },
  { value: 'mutual_agreement', label: 'Ended by mutual agreement' },
  { value: 'eviction', label: 'Eviction' },
  { value: 'abandoned', label: 'Unit abandoned' },
  { value: 'other', label: 'Other' },
] as const

export type EndReason = (typeof END_REASONS)[number]['value']

export function endReasonLabel(r: string | null | undefined): string {
  return END_REASONS.find((x) => x.value === r)?.label ?? 'Ended'
}

const DEPOSIT_TYPES = ['security_deposit', 'pet_deposit', 'other_deposit']

/**
 * What the tenant still owes on a lease, deposits aside — the same figure
 * deposit_summary() calls `owed`.
 */
export async function fetchLeaseBalance(leaseId: string): Promise<number> {
  if (!supabase) return 0
  const { data, error } = await supabase
    .from('rent_charges').select('amount, amount_paid, charge_type').eq('lease_id', leaseId)
  if (error) throw error
  return (data as { amount: number; amount_paid: number; charge_type: string }[])
    .filter((c) => !DEPOSIT_TYPES.includes(c.charge_type))
    .reduce((s, c) => s + Math.max(0, Number(c.amount) - Number(c.amount_paid)), 0)
}

export async function endLease(input: {
  leaseId: string
  moveOut: string
  reason: EndReason
  note: string
  keepAccess: boolean
}): Promise<{ removed_charges: number; access_removed: number; still_owed: number }> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('end_lease', {
    target_lease: input.leaseId,
    move_out: input.moveOut,
    reason: input.reason,
    note: input.note || null,
    keep_access: input.keepAccess,
  })
  if (error) throw error
  return data
}

// ------------------------------------------------------- the record --

export const EVENT_TYPES = [
  { value: 'notice_served', label: 'Notice served' },
  { value: 'court_filing', label: 'Court filing' },
  { value: 'hearing', label: 'Hearing' },
  { value: 'judgment', label: 'Judgment' },
  { value: 'writ', label: 'Writ / order to vacate' },
  { value: 'payment_plan', label: 'Payment plan' },
  { value: 'inspection', label: 'Inspection' },
  { value: 'move_out', label: 'Move-out' },
  { value: 'deposit', label: 'Deposit' },
  { value: 'note', label: 'Note' },
  { value: 'other', label: 'Other' },
] as const

export type EventType = (typeof EVENT_TYPES)[number]['value']

export function eventTypeLabel(t: string): string {
  return EVENT_TYPES.find((x) => x.value === t)?.label ?? 'Note'
}

export type LeaseEvent = {
  id: string
  lease_id: string
  event_type: EventType
  event_date: string
  title: string
  details: string | null
  created_at: string
}

export async function fetchLeaseEvents(leaseId: string): Promise<LeaseEvent[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('lease_events')
    .select('id, lease_id, event_type, event_date, title, details, created_at')
    .eq('lease_id', leaseId)
    .order('event_date', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as LeaseEvent[]
}

export async function addLeaseEvent(input: {
  leaseId: string
  type: EventType
  date: string
  title: string
  details: string
  memberId: string
}): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.from('lease_events').insert({
    lease_id: input.leaseId,
    event_type: input.type,
    event_date: input.date,
    title: input.title.trim(),
    details: input.details.trim() || null,
    created_by: input.memberId,
  }).select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

export async function deleteLeaseEvent(leaseId: string, eventId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const files = await listEventFiles(leaseId, eventId)
  if (files.length > 0) {
    const { error } = await supabase.storage.from('lease-files')
      .remove(files.map((f) => f.path))
    if (error) throw error
  }
  const { error } = await supabase.from('lease_events').delete().eq('id', eventId)
  if (error) throw error
}

/**
 * Files live at <lease_id>/<event_id>/<name>. The first segment is what
 * the storage policies in 033 decide access by, so this shape must not
 * change without them.
 */
export async function uploadEventFile(leaseId: string, eventId: string, file: File): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const safe = file.name.replace(/[^\w.-]+/g, '_').slice(-80) || 'file'
  const path = `${leaseId}/${eventId}/${Date.now()}-${safe}`
  const { error } = await supabase.storage.from('lease-files').upload(path, file, {
    contentType: file.type || 'application/octet-stream',
  })
  if (error) throw error
}

export type EventFile = { name: string; path: string }

export async function listEventFiles(leaseId: string, eventId: string): Promise<EventFile[]> {
  if (!supabase) return []
  const prefix = `${leaseId}/${eventId}`
  const { data, error } = await supabase.storage.from('lease-files').list(prefix)
  if (error) throw error
  return (data ?? [])
    .filter((f) => f.name && !f.name.startsWith('.'))
    .map((f) => ({ name: f.name.replace(/^\d+-/, ''), path: `${prefix}/${f.name}` }))
}

export async function eventFileUrl(path: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage.from('lease-files').createSignedUrl(path, 60 * 60)
  if (error) throw error
  return data?.signedUrl ?? null
}

// ------------------------------------------------------ the deposit --

export type DepositSummary = {
  held: number
  deducted: number
  returned: number
  remaining: number
  owed: number
}

export type DepositDeduction = {
  id: string
  description: string
  amount: number
  applied_to_balance: boolean
}

export type DepositReturn = {
  amount: number
  returned_on: string
  method: string | null
  note: string | null
}

export async function fetchDeposit(leaseId: string): Promise<{
  summary: DepositSummary
  deductions: DepositDeduction[]
  refund: DepositReturn | null
}> {
  if (!supabase) throw new Error('Supabase not configured')
  const [s, d, r] = await Promise.all([
    supabase.rpc('deposit_summary', { target_lease: leaseId }).single(),
    supabase.from('deposit_deductions')
      .select('id, description, amount, applied_to_balance')
      .eq('lease_id', leaseId).order('created_at'),
    supabase.from('deposit_returns')
      .select('amount, returned_on, method, note').eq('lease_id', leaseId).maybeSingle(),
  ])
  if (s.error) throw s.error
  if (d.error) throw d.error
  if (r.error) throw r.error
  const raw = s.data as Record<keyof DepositSummary, number | string>
  const summary = Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k, Number(v)]),
  ) as DepositSummary
  return {
    summary,
    deductions: (d.data as DepositDeduction[]).map((x) => ({ ...x, amount: Number(x.amount) })),
    refund: r.data ? { ...(r.data as DepositReturn), amount: Number((r.data as DepositReturn).amount) } : null,
  }
}

export async function addDeduction(leaseId: string, description: string, amount: number, memberId: string) {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('deposit_deductions').insert({
    lease_id: leaseId, description: description.trim(), amount, created_by: memberId,
  })
  if (error) throw error
}

export async function deleteDeduction(id: string) {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.from('deposit_deductions').delete().eq('id', id).select('id')
  if (error) throw error
  if (!data || data.length === 0) {
    throw new Error('That deduction can’t be removed — undo the recorded refund first.')
  }
}

export async function applyDepositToBalance(leaseId: string): Promise<number> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('apply_deposit_to_balance', { target_lease: leaseId })
  if (error) throw error
  return Number(data)
}

export async function recordDepositReturn(input: {
  leaseId: string; amount: number; date: string; method: string; note: string
}) {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.rpc('record_deposit_return', {
    target_lease: input.leaseId,
    amount: input.amount,
    returned_on: input.date,
    method: input.method || null,
    note: input.note || null,
  })
  if (error) throw error
}

export async function undoDepositReturn(leaseId: string) {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('deposit_returns').delete().eq('lease_id', leaseId)
  if (error) throw error
}
