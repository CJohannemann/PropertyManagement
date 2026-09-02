import { useState } from 'react'
import { submitRequest, REQUEST_CATEGORIES } from '../lib/maintenance'

type Props = { unitId: string; memberId: string; onDone: () => void }

/** The tenant's side: reporting something that needs fixing. */
export function RequestRepair({ unitId, memberId, onDone }: Props) {
  const [category, setCategory] = useState<string>('other')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      await submitRequest({
        unitId, submittedBy: memberId, category,
        description: description.trim(), priority,
      })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Report a problem</h3>
        <div className="field">
          <label htmlFor="r-cat">What kind of problem?</label>
          <select id="r-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
            {REQUEST_CATEGORIES.map((c) => (
              <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="r-desc">What's wrong?</label>
          <textarea id="r-desc" rows={4} required value={description}
            placeholder="Where it is and what happens — the more detail, the fewer visits."
            onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="r-pri">How urgent is it?</label>
          <select id="r-pri" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option value="low">Low — whenever convenient</option>
            <option value="normal">Normal</option>
            <option value="high">High — needs attention soon</option>
            <option value="urgent">Urgent — unsafe or unusable</option>
          </select>
          {/* An app is the wrong channel for an emergency, and saying so
              is more useful than a priority level that implies otherwise. */}
          <span className="muted">
            For a gas leak, flood, or anything dangerous, call rather than
            submitting this.
          </span>
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
        <button className="link" type="button" onClick={onDone}
          style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
