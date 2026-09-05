import { useState } from 'react'
import { submitRequest, uploadRequestPhoto, REQUEST_CATEGORIES } from '../lib/maintenance'

type Props = { unitId: string; memberId: string; onDone: () => void }

/** The tenant's side: reporting something that needs fixing. */
export function RequestRepair({ unitId, memberId, onDone }: Props) {
  const [category, setCategory] = useState<string>('other')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('normal')
  const [photos, setPhotos] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const requestId = await submitRequest({
        unitId, submittedBy: memberId, category,
        description: description.trim(), priority,
      })
      // The request is what matters; a photo that fails to upload
      // shouldn't undo a report that already went through.
      try {
        for (const photo of photos) await uploadRequestPhoto(requestId, photo)
      } catch {
        setError("The problem was reported, but a photo didn't upload.")
      }
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
        <div className="field">
          <label htmlFor="r-photo">Add a photo (optional)</label>
          <input
            id="r-photo"
            type="file"
            // `capture` opens the camera directly on a phone rather than
            // the file browser — most reports get filed standing in front
            // of the problem.
            accept="image/*"
            capture="environment"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) setPhotos((prev) => [...prev, file])
              e.target.value = ''
            }}
          />
          {photos.length > 0 && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
              {photos.map((file, i) => (
                <div key={i} style={{ position: 'relative' }}>
                  <img
                    src={URL.createObjectURL(file)}
                    alt=""
                    style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }}
                  />
                  <button
                    type="button"
                    className="link"
                    aria-label="Remove photo"
                    onClick={() => setPhotos((prev) => prev.filter((_, j) => j !== i))}
                    style={{
                      position: 'absolute', top: -8, right: -8, margin: 0,
                      background: 'var(--bg)', borderRadius: '50%', lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
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
