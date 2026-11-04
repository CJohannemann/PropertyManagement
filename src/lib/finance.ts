import { supabase } from './supabase'
import type { RecoveryYears } from './depreciation'

// ------------------------------------------------------------- income --

/**
 * One payment received, sorted by what kind of money it is — see
 * income_lines() in db/migrations/037_finances.sql for the rules.
 * 'deposit_received' is held, not income.
 */
export type IncomeLine = {
  id: string
  received_on: string
  kind: 'rent' | 'fees' | 'deposit_received' | 'deposit_kept'
  charge_type: string | null
  property_id: string
  property_name: string
  unit_label: string | null
  tenant_name: string | null
  method: string | null
  amount: number
  processing_fee: number
  note: string | null
}

export const INCOME_KIND_LABEL: Record<IncomeLine['kind'], string> = {
  rent: 'Rent',
  fees: 'Fees',
  deposit_received: 'Deposit received (held)',
  deposit_kept: 'Deposit kept',
}

/** Is this line income for the tax return? Deposits held are not. */
export function isIncome(l: IncomeLine): boolean {
  return l.kind !== 'deposit_received'
}

export async function fetchIncomeLines(
  organizationId: string, from: string, to: string, propertyId: string | null = null,
): Promise<IncomeLine[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('income_lines', {
    org: organizationId, from_date: from, to_date: to, property: propertyId,
  })
  if (error) throw error
  return ((data ?? []) as IncomeLine[]).map((l) => ({
    ...l, amount: Number(l.amount), processing_fee: Number(l.processing_fee),
  }))
}

// ------------------------------------------------------------ vendors --

export type Vendor = {
  id: string
  organization_id: string
  name: string
  business_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  tin_last4: string | null
  w9_path: string | null
  gets_1099: boolean
  member_id: string | null
  notes: string | null
}

export function vendorLabel(v: Pick<Vendor, 'name' | 'business_name'>): string {
  return v.business_name?.trim() || v.name
}

export async function fetchVendors(organizationId: string): Promise<Vendor[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('vendors').select('*')
    .eq('organization_id', organizationId).order('name')
  if (error) throw error
  return (data ?? []) as Vendor[]
}

export type VendorInput = Omit<Vendor, 'id' | 'organization_id'>

export async function saveVendor(
  organizationId: string, input: VendorInput, id?: string,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const row = { ...input, organization_id: organizationId }
  const { error } = id
    ? await supabase.from('vendors').update(input).eq('id', id)
    : await supabase.from('vendors').insert(row)
  if (error) throw error
}

export async function deleteVendor(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('vendors').delete().eq('id', id)
  if (error) throw error
}

/**
 * Uploads a W-9 into the expense-receipts bucket under <org>/w9/, which the
 * organization-keyed policies in 036 already cover.
 */
export async function uploadW9(organizationId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const ext = file.name.split('.').pop()?.toLowerCase() || 'pdf'
  const path = `${organizationId}/w9/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('expense-receipts').upload(path, file, {
    contentType: file.type || 'application/pdf',
  })
  if (error) throw error
  return path
}

export type VendorTotal = {
  vendor_id: string
  name: string
  gets_1099: boolean
  has_w9: boolean
  has_tin: boolean
  from_expenses: number
  from_jobs: number
  card_payments: number
  reportable: number
}

export async function fetchVendorTotals(organizationId: string, year: number): Promise<VendorTotal[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('vendor_totals', { org: organizationId, tax_year: year })
  if (error) throw error
  return ((data ?? []) as VendorTotal[]).map((v) => ({
    ...v,
    from_expenses: Number(v.from_expenses),
    from_jobs: Number(v.from_jobs),
    card_payments: Number(v.card_payments),
    reportable: Number(v.reportable),
  }))
}

/**
 * The 1099-NEC filing threshold for payments made in a tax year: $600
 * through 2025, $2,000 from 2026 under the One Big Beautiful Bill Act,
 * indexed for inflation after 2026 — so later years are a floor the
 * accountant should confirm.
 */
export function nec1099Threshold(year: number): number {
  return year <= 2025 ? 600 : 2000
}

/** Who a landlord can pick when linking a vendor to a login. */
export async function fetchTechnicians(organizationId: string):
  Promise<{ id: string; full_name: string | null }[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('org_members').select('id, full_name')
    .eq('organization_id', organizationId).eq('role', 'technician').order('full_name')
  if (error) throw error
  return (data ?? []) as { id: string; full_name: string | null }[]
}

// ------------------------------------------------------- depreciation --

export type PropertyFinancials = {
  property_id: string
  purchase_price: number | null
  closing_costs: number | null
  land_value: number | null
  placed_in_service: string | null
}

export type Improvement = {
  id: string
  property_id: string
  description: string
  cost: number
  placed_in_service: string
  recovery_years: RecoveryYears
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v))

export async function fetchFinancials(): Promise<PropertyFinancials[]> {
  if (!supabase) return []
  // RLS scopes both to the caller's organizations, admin/PM only.
  const { data, error } = await supabase.from('property_financials').select('*')
  if (error) throw error
  return ((data ?? []) as PropertyFinancials[]).map((f) => ({
    ...f,
    purchase_price: num(f.purchase_price),
    closing_costs: num(f.closing_costs),
    land_value: num(f.land_value),
  }))
}

export async function saveFinancials(f: PropertyFinancials): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('property_financials')
    .upsert({ ...f, updated_at: new Date().toISOString() })
  if (error) throw error
}

export async function fetchImprovements(): Promise<Improvement[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('capital_improvements').select('*')
    .order('placed_in_service')
  if (error) throw error
  return ((data ?? []) as Improvement[]).map((i) => ({
    ...i, cost: Number(i.cost), recovery_years: Number(i.recovery_years) as RecoveryYears,
  }))
}

export async function addImprovement(i: Omit<Improvement, 'id'>): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('capital_improvements').insert(i)
  if (error) throw error
}

export async function deleteImprovement(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('capital_improvements').delete().eq('id', id)
  if (error) throw error
}

export const RECOVERY_CHOICES: { value: RecoveryYears; label: string }[] = [
  { value: 27.5, label: '27.5 years — part of the building (roof, HVAC, windows)' },
  { value: 5, label: '5 years — appliances, carpet' },
  { value: 7, label: '7 years — furniture' },
  { value: 15, label: '15 years — fences, driveways, landscaping' },
]

// ------------------------------------------------------------- shared --

export type PropertyRow = { id: string; name: string; purchase_date: string | null; unitCount: number }

export async function fetchPropertyRows(organizationId: string): Promise<PropertyRow[]> {
  if (!supabase) return []
  const { data, error } = await supabase.from('properties')
    .select('id, name, purchase_date, units(id)')
    .eq('organization_id', organizationId).order('name')
  if (error) throw error
  return ((data ?? []) as { id: string; name: string; purchase_date: string | null; units: { id: string }[] }[])
    .map((p) => ({ id: p.id, name: p.name, purchase_date: p.purchase_date, unitCount: p.units?.length ?? 0 }))
}

/** Triggers a browser download of bytes or text. */
export function downloadFile(name: string, data: Uint8Array | string, type: string): void {
  const blob = new Blob([data as BlobPart], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
