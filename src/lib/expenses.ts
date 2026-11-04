import { supabase } from './supabase'

/**
 * The expense categories, in Schedule E order.
 *
 * Schedule E (Form 1040) is where a landlord reports rental income and
 * expenses, one column per property. Each category here is one of its
 * lines, so the yearly totals on the Expenses screen are the figures an
 * accountant copies across. Line 18, depreciation, is deliberately absent:
 * it is worked out from the purchase price, not paid as a bill.
 *
 * Must match the check constraint in db/migrations/036_expenses.sql.
 */
export const EXPENSE_CATEGORIES = [
  { value: 'advertising', line: 5, label: 'Advertising',
    hint: 'Listings, signs, ads for a vacancy' },
  { value: 'auto_travel', line: 6, label: 'Auto and travel',
    hint: 'Driving to the properties; repair-job mileage lands here' },
  { value: 'cleaning_maintenance', line: 7, label: 'Cleaning and maintenance',
    hint: 'Cleaning, lawn care, snow removal, pest control' },
  { value: 'commissions', line: 8, label: 'Commissions',
    hint: 'Leasing or finder’s fees' },
  { value: 'insurance', line: 9, label: 'Insurance',
    hint: 'Landlord or umbrella policy premiums' },
  { value: 'legal_professional', line: 10, label: 'Legal and professional fees',
    hint: 'Accountant, lawyer, eviction filing' },
  { value: 'management_fees', line: 11, label: 'Management fees',
    hint: 'A property manager’s fee' },
  { value: 'mortgage_interest', line: 12, label: 'Mortgage interest',
    hint: 'The interest part of the payment only, not the principal' },
  { value: 'other_interest', line: 13, label: 'Other interest',
    hint: 'Interest on other loans for the property' },
  { value: 'repairs', line: 14, label: 'Repairs',
    hint: 'Fixes paid outside a repair job; job costs are added for you' },
  { value: 'supplies', line: 15, label: 'Supplies',
    hint: 'Smoke detectors, light bulbs, cleaning supplies' },
  { value: 'taxes', line: 16, label: 'Taxes',
    hint: 'Property tax, rental licence fees' },
  { value: 'utilities', line: 17, label: 'Utilities',
    hint: 'Water, trash, gas or electric you pay for the property' },
  { value: 'other', line: 19, label: 'Other',
    hint: 'HOA dues, bank fees, anything else' },
] as const

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]['value']

export function categoryInfo(value: string) {
  return EXPENSE_CATEGORIES.find((c) => c.value === value)
    ?? { value, line: 19, label: value, hint: '' }
}

/**
 * One cost in the list: either an expense someone entered ('expense'), or
 * a cost logged on a repair job ('job'), which is shown here but edited on
 * the job.
 */
export type ExpenseLine = {
  id: string
  source: 'expense' | 'job'
  spent_on: string
  category: string
  property_id: string | null
  property_name: string | null
  payee: string | null
  description: string | null
  amount: number
  receipt_path: string | null
  job_id: string | null
  vendor_id: string | null
  paid_by: string | null
}

export async function fetchExpenseLines(
  organizationId: string,
  from: string,
  to: string,
  propertyId: string | null = null,
): Promise<ExpenseLine[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('expense_lines', {
    org: organizationId, from_date: from, to_date: to, property: propertyId,
  })
  if (error) throw error
  // numeric arrives as a string; coerced once, here.
  return ((data ?? []) as ExpenseLine[]).map((l) => ({ ...l, amount: Number(l.amount) }))
}

export type CategoryTotal = { category: string; line: number; label: string; amount: number }

/** Totals by category, in Schedule E line order, leaving out empty ones. */
export function totalsByCategory(lines: ExpenseLine[]): CategoryTotal[] {
  const sums = new Map<string, number>()
  for (const l of lines) sums.set(l.category, (sums.get(l.category) ?? 0) + l.amount)
  return [...sums.entries()]
    .map(([category, amount]) => {
      const info = categoryInfo(category)
      return { category, line: info.line, label: info.label, amount }
    })
    .sort((a, b) => a.line - b.line)
}

/** How a bill was paid. Card matters: the card company reports it, not you. */
export const PAID_BY = [
  { value: 'check', label: 'Check' },
  { value: 'bank_transfer', label: 'Bank transfer' },
  { value: 'cash', label: 'Cash' },
  { value: 'card', label: 'Credit or debit card' },
  { value: 'other', label: 'Other' },
] as const

export type ExpenseInput = {
  organizationId: string
  propertyId: string | null
  category: ExpenseCategory
  spentOn: string
  amount: number
  payee: string | null
  description: string | null
  receiptPath: string | null
  vendorId: string | null
  paidBy: string | null
}

/** The stored row, for filling in the edit form exactly as entered. */
export type ExpenseRecord = {
  id: string
  property_id: string | null
  category: ExpenseCategory
  spent_on: string
  amount: number
  payee: string | null
  description: string | null
  receipt_path: string | null
  vendor_id: string | null
  paid_by: string | null
}

export async function fetchExpense(id: string): Promise<ExpenseRecord> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.from('expenses')
    .select('id, property_id, category, spent_on, amount, payee, description, receipt_path, vendor_id, paid_by')
    .eq('id', id).single()
  if (error) throw error
  return { ...(data as ExpenseRecord), amount: Number((data as ExpenseRecord).amount) }
}

/** Adds an expense, or updates it when an id is given. */
export async function saveExpense(input: ExpenseInput, id?: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  // recorded_by is filled in by the database from who is signed in.
  const row = {
    property_id: input.propertyId,
    category: input.category,
    spent_on: input.spentOn,
    amount: input.amount,
    payee: input.payee,
    description: input.description,
    receipt_path: input.receiptPath,
    vendor_id: input.vendorId,
    paid_by: input.paidBy,
  }
  const { error } = id
    ? await supabase.from('expenses').update(row).eq('id', id)
    : await supabase.from('expenses').insert({ ...row, organization_id: input.organizationId })
  if (error) throw error
}

/** Removes a stored receipt file; a failure only leaves a stray file. */
export async function removeExpenseReceipt(path: string): Promise<void> {
  await supabase?.storage.from('expense-receipts').remove([path])
}

/** Deletes an expense and, best effort, its receipt file. */
export async function deleteExpense(id: string, receiptPath: string | null): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('expenses').delete().eq('id', id)
  if (error) throw error
  // The row is what the books read; a receipt left behind is only a stray
  // file, so failing to remove it doesn't undo the delete.
  if (receiptPath) await supabase.storage.from('expense-receipts').remove([receiptPath])
}

/**
 * Uploads a receipt or bill. Keyed by organization id, which is what the
 * storage policies in 036 check — change the shape and access quietly
 * breaks, so it is built here and nowhere else.
 */
export async function uploadExpenseReceipt(organizationId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${organizationId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('expense-receipts').upload(path, file, {
    contentType: file.type || 'image/jpeg',
  })
  if (error) throw error
  return path
}

/** A short-lived link to a stored receipt; the bucket is private. */
export async function expenseReceiptUrl(path: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage
    .from('expense-receipts').createSignedUrl(path, 60 * 60)
  if (error) throw error
  return data?.signedUrl ?? null
}

/** The organization's per-mile rate for repair-job mileage, or null. */
export async function fetchMileageRate(organizationId: string): Promise<number | null> {
  if (!supabase) return null
  const { data, error } = await supabase.from('organizations')
    .select('mileage_rate').eq('id', organizationId).single()
  if (error) throw error
  return data?.mileage_rate == null ? null : Number(data.mileage_rate)
}

/** Admin only — organizations are updatable by admins alone (schema RLS). */
export async function setMileageRate(organizationId: string, rate: number | null): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('organizations')
    .update({ mileage_rate: rate }).eq('id', organizationId)
  if (error) throw error
}
