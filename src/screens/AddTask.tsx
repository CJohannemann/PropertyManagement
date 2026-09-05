import { useState } from 'react'
import { errorMessage } from '../lib/supabase'
import {
  createTask, TASK_CATEGORIES, REPEAT_OPTIONS, type TaskCategory,
} from '../lib/tasks'

type Props = {
  organizationId: string
  propertyChoices: { id: string; name: string }[]
  onAdded: () => void
  onCancel: () => void
}

/** Anything with a date that the rest of the app doesn't already know about. */
export function AddTask({ organizationId, propertyChoices, onAdded, onCancel }: Props) {
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<TaskCategory>('inspection')
  const [propertyId, setPropertyId] = useState('')
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10))
  const [repeat, setRepeat] = useState('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await createTask({
        organizationId,
        propertyId: propertyId || null,
        title,
        category,
        dueDate,
        repeatMonths: repeat ? Number(repeat) : null,
        notes,
      })
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <div className="field">
          <label htmlFor="t-title">What needs doing?</label>
          <input id="t-title" required value={title}
                 placeholder="Roof inspection"
                 onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="t-cat">What kind of thing is it?</label>
          <select id="t-cat" value={category}
                  onChange={(e) => setCategory(e.target.value as TaskCategory)}>
            {TASK_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="t-prop">Which property?</label>
          <select id="t-prop" value={propertyId}
                  onChange={(e) => setPropertyId(e.target.value)}>
            {/* Insurance and tax belong to the business, not a building —
                which is why a task's property is optional. */}
            <option value="">All properties / the business</option>
            {propertyChoices.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="t-due">When is it due?</label>
          <input id="t-due" type="date" required value={dueDate}
                 onChange={(e) => setDueDate(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="t-repeat">Does it come round again?</label>
          <select id="t-repeat" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
            {REPEAT_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <span className="muted">
            A repeating task reappears on its next date as soon as you mark
            it done.
          </span>
        </div>

        <div className="field">
          <label htmlFor="t-notes">Notes (optional)</label>
          <input id="t-notes" type="text" value={notes}
                 onChange={(e) => setNotes(e.target.value)} />
        </div>

        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add task'}
        </button>
        <button className="link" type="button" onClick={onCancel}
                style={{ marginTop: '0.5rem' }} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
