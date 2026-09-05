import { supabase } from './supabase'

export type MaintenanceRequest = {
  id: string
  unit_id: string
  category: string
  description: string
  priority: 'low' | 'normal' | 'high' | 'urgent'
  status: 'open' | 'assigned' | 'in_progress' | 'completed' | 'closed'
  created_at: string
  units?: { label: string; properties?: { name: string } } | null
}

export type Job = {
  id: string
  property_id: string
  unit_id: string | null
  request_id: string | null
  assigned_technician_id: string | null
  status: 'scheduled' | 'in_progress' | 'completed' | 'canceled'
  scheduled_date: string | null
  completed_date: string | null
  notes: string | null
  properties?: { name: string } | null
  units?: { label: string } | null
}

export type JobEntry = {
  id: string
  job_id: string
  entry_type: 'labor' | 'mileage' | 'material' | 'note'
  description: string | null
  hours: number | null
  miles: number | null
  cost: number | null
  vendor: string | null
  created_at: string
}

export const REQUEST_CATEGORIES = [
  'plumbing', 'electrical', 'appliance', 'hvac', 'pest', 'structural', 'other',
] as const

export async function fetchRequests(): Promise<MaintenanceRequest[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('maintenance_requests')
    .select('id, unit_id, category, description, priority, status, created_at, units(label, properties(name))')
    .order('created_at', { ascending: false })
  if (error) throw error
  return data as unknown as MaintenanceRequest[]
}

/** Returns the new request's id, so a photo can be attached to it. */
export async function submitRequest(input: {
  unitId: string
  submittedBy: string
  category: string
  description: string
  priority: string
}): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.from('maintenance_requests').insert({
    unit_id: input.unitId,
    submitted_by: input.submittedBy,
    category: input.category,
    description: input.description,
    priority: input.priority,
  }).select('id').single()
  if (error) throw error
  return (data as { id: string }).id
}

export async function fetchJobs(): Promise<Job[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('maintenance_jobs')
    .select('id, property_id, unit_id, request_id, assigned_technician_id, status, scheduled_date, completed_date, notes, properties(name), units(label)')
    .order('scheduled_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data as unknown as Job[]
}

/** Wraps create_job_from_request(), which also marks the request assigned. */
export async function createJobFromRequest(
  requestId: string, technicianId: string | null, scheduledDate: string | null,
): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await supabase.rpc('create_job_from_request', {
    request: requestId,
    technician: technicianId,
    when_scheduled: scheduledDate,
  })
  if (error) throw error
  return data as string
}

export async function setJobStatus(jobId: string, status: Job['status']): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const patch: Record<string, unknown> = { status }
  // Recording when it finished, so "how long did that take" is answerable
  // later without reconstructing it from entry timestamps.
  if (status === 'completed') patch.completed_date = new Date().toISOString().slice(0, 10)
  const { error } = await supabase.from('maintenance_jobs').update(patch).eq('id', jobId)
  if (error) throw error
}

export async function fetchJobEntries(jobId: string): Promise<JobEntry[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('job_entries')
    .select('id, job_id, entry_type, description, hours, miles, cost, vendor, created_at')
    .eq('job_id', jobId)
    .order('created_at')
  if (error) throw error
  return data as JobEntry[]
}

export async function addJobEntry(input: {
  jobId: string
  technicianId: string
  entryType: JobEntry['entry_type']
  description: string | null
  hours: number | null
  miles: number | null
  cost: number | null
  vendor: string | null
}): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('job_entries').insert({
    job_id: input.jobId,
    technician_id: input.technicianId,
    entry_type: input.entryType,
    description: input.description,
    hours: input.hours,
    miles: input.miles,
    cost: input.cost,
    vendor: input.vendor,
  })
  if (error) throw error
}

export type JobTotals = { total_cost: number; total_hours: number; total_miles: number }

export async function fetchJobTotals(jobId: string): Promise<JobTotals> {
  if (!supabase) return { total_cost: 0, total_hours: 0, total_miles: 0 }
  const { data, error } = await supabase.rpc('job_totals', { job: jobId })
  if (error) throw error
  const rows = data as JobTotals[]
  return rows[0] ?? { total_cost: 0, total_hours: 0, total_miles: 0 }
}

// ------------------------------------------------------------ receipts --

/**
 * Uploads a receipt photo for a job. The path's first segment is the job
 * id, which is what the storage RLS policies key off — see
 * db/migrations/011_receipt_storage.sql. Changing this shape silently
 * breaks those permissions rather than erroring, so it is deliberately
 * built here in one place rather than at call sites.
 */
export async function uploadReceipt(jobId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${jobId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('receipts').upload(path, file, {
    contentType: file.type || 'image/jpeg',
  })
  if (error) throw error
  return path
}

/**
 * A time-limited URL for a stored receipt. The bucket is private, so
 * there is no permanent public link — the signed URL is checked against
 * the caller's own permissions when it is created.
 */
export async function receiptUrl(path: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage
    .from('receipts').createSignedUrl(path, 60 * 60)
  if (error) throw error
  return data?.signedUrl ?? null
}

export async function listReceipts(jobId: string): Promise<string[]> {
  if (!supabase) return []
  const { data, error } = await supabase.storage.from('receipts').list(jobId)
  if (error) throw error
  return (data ?? []).map((f) => `${jobId}/${f.name}`)
}

// ------------------------------------------------------ request photos --

/**
 * Uploads a photo of the reported problem. Same path shape as
 * uploadReceipt, keyed by request id instead of job id — see
 * db/migrations/015_request_photo_storage.sql for the RLS policies that
 * depend on it.
 */
export async function uploadRequestPhoto(requestId: string, file: File): Promise<string> {
  if (!supabase) throw new Error('Supabase not configured')
  const ext = file.name.split('.').pop()?.toLowerCase() || 'jpg'
  const path = `${requestId}/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from('request-photos').upload(path, file, {
    contentType: file.type || 'image/jpeg',
  })
  if (error) throw error
  return path
}

export async function requestPhotoUrl(path: string): Promise<string | null> {
  if (!supabase) return null
  const { data, error } = await supabase.storage
    .from('request-photos').createSignedUrl(path, 60 * 60)
  if (error) throw error
  return data?.signedUrl ?? null
}

export async function listRequestPhotos(requestId: string): Promise<string[]> {
  if (!supabase) return []
  const { data, error } = await supabase.storage.from('request-photos').list(requestId)
  if (error) throw error
  return (data ?? []).map((f) => `${requestId}/${f.name}`)
}
