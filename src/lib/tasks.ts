import { supabase } from './supabase'

export type UpcomingEvent = {
  kind: 'task' | 'rent' | 'lease'
  ref_id: string | null
  title: string
  detail: string
  due_date: string
  category: string
}

export type Task = {
  id: string
  property_id: string | null
  title: string
  notes: string | null
  category: TaskCategory
  due_date: string
  repeat_months: number | null
  completed_at: string | null
}

export type TaskCategory =
  | 'inspection' | 'insurance' | 'tax' | 'appointment' | 'maintenance' | 'other'

export const TASK_CATEGORIES: { value: TaskCategory; label: string }[] = [
  { value: 'inspection', label: 'Inspection' },
  { value: 'appointment', label: 'Appointment' },
  { value: 'maintenance', label: 'Maintenance' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'tax', label: 'Tax' },
  { value: 'other', label: 'Something else' },
]

export const REPEAT_OPTIONS: { value: string; label: string }[] = [
  { value: '', label: "Doesn't repeat" },
  { value: '1', label: 'Every month' },
  { value: '3', label: 'Every 3 months' },
  { value: '6', label: 'Every 6 months' },
  { value: '12', label: 'Every year' },
]

/**
 * What is coming up, from every source that has a date — tasks, rent
 * falling due, leases ending.
 *
 * Merged in SQL rather than in the browser: a landlord thinks in "what is
 * coming up", not in which table a date happens to live in, and doing it
 * here would mean three round trips and a sort.
 */
export async function fetchUpcoming(
  organizationId: string,
  daysAhead = 45,
): Promise<UpcomingEvent[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('upcoming_events', {
    org: organizationId,
    days_ahead: daysAhead,
  })
  if (error) throw error
  return (data as UpcomingEvent[]) ?? []
}

export async function fetchTasks(organizationId: string): Promise<Task[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('tasks')
    .select('id, property_id, title, notes, category, due_date, repeat_months, completed_at')
    .eq('organization_id', organizationId)
    .is('completed_at', null)
    .order('due_date')
  if (error) throw error
  return (data as Task[]) ?? []
}

export async function createTask(input: {
  organizationId: string
  propertyId: string | null
  title: string
  category: TaskCategory
  dueDate: string
  repeatMonths: number | null
  notes?: string | null
}): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('tasks').insert({
    organization_id: input.organizationId,
    property_id: input.propertyId,
    title: input.title.trim(),
    category: input.category,
    due_date: input.dueDate,
    repeat_months: input.repeatMonths,
    notes: input.notes?.trim() || null,
  })
  if (error) throw error
}

/**
 * Ticks a task off. Goes through complete_task() rather than an update
 * because a repeating task has to reappear on its next date, counted from
 * when it was due — an annual inspection should already be on the calendar
 * before anyone closes the app.
 */
export async function completeTask(taskId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.rpc('complete_task', { task: taskId })
  if (error) throw error
}

export async function deleteTask(taskId: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  const { error } = await supabase.from('tasks').delete().eq('id', taskId)
  if (error) throw error
}
