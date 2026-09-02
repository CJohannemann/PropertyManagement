import { useEffect, useState } from 'react'
import {
  fetchDefaultTemplate, createTemplate, updateClause, deleteClause, addClause,
  AVAILABLE_PLACEHOLDERS, type TemplateWithClauses,
} from '../lib/leaseTemplates'
import { STARTER_CLAUSES } from '../lib/starterClauses'

type Props = { organizationId: string; onBack: () => void }

export function LeaseTemplates({ organizationId, onBack }: Props) {
  const [template, setTemplate] = useState<TemplateWithClauses | null | 'loading'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    try {
      setTemplate(await fetchDefaultTemplate())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setTemplate(null)
    }
  }

  useEffect(() => { load() }, [organizationId])

  async function start(from: 'sample' | 'blank') {
    setBusy(true)
    setError(null)
    try {
      await createTemplate(
        organizationId,
        from === 'sample' ? 'Residential lease' : 'My lease',
        from === 'sample'
          ? STARTER_CLAUSES.map((c) => ({
              heading: c.heading, body: c.body, omit_if_empty: c.omitIfEmpty ?? [],
            }))
          : [{ heading: 'Agreement', body: 'Paste your lease here.' }],
        true,
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  if (template === 'loading') return <p className="muted">Loading…</p>

  if (template === null) {
    return (
      <div>
        <button className="link" onClick={onBack}>← Back</button>
        <h2>Lease template</h2>
        {error && <p className="error-text">{error}</p>}
        <p className="muted">
          Your lease wording lives here. The app fills in the figures — rent,
          dates, deposits, late fees — but the clauses themselves are your
          document, because requirements differ by state and a lease is
          something you and your attorney are responsible for.
        </p>
        <div className="card-list">
          <div>
            <strong>Paste in the lease you already use</strong>
            <p className="muted">
              Start with a single clause you can paste your existing
              agreement into, then split it up if you want the figures
              filled in automatically.
            </p>
            <button className="primary" disabled={busy} onClick={() => start('blank')}>
              Start from blank
            </button>
          </div>
          <div>
            <strong>Start from a sample and edit it</strong>
            <p className="muted">
              A ~30 clause residential lease skeleton, adapted from a
              Kentucky lease. It is a starting point, not advice — it may be
              wrong for your state, and needs your attorney's review before
              you sign anyone to it.
            </p>
            <button className="primary" disabled={busy} onClick={() => start('sample')}>
              Start from sample
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div>
      <button className="link" onClick={onBack}>← Back</button>
      <h2>{template.name}</h2>
      <p className="muted">
        {'Use {braces} to insert lease figures: '}
        {AVAILABLE_PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}
      </p>
      {error && <p className="error-text">{error}</p>}

      <div className="card-list">
        {template.clauses.map((c) => (
          <ClauseEditor key={c.id} clause={c} onChanged={load} onError={setError} />
        ))}
      </div>

      <button className="link" style={{ marginTop: '1rem' }} onClick={async () => {
        try {
          await addClause(template.id, template.clauses.length, 'New clause', '')
          await load()
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }}>
        + Add clause
      </button>
    </div>
  )
}

function ClauseEditor({
  clause, onChanged, onError,
}: {
  clause: { id: string; heading: string; body: string }
  onChanged: () => void
  onError: (m: string) => void
}) {
  const [heading, setHeading] = useState(clause.heading)
  const [body, setBody] = useState(clause.body)
  const [saving, setSaving] = useState(false)
  const dirty = heading !== clause.heading || body !== clause.body

  return (
    <div>
      <div className="field">
        <input value={heading} onChange={(e) => setHeading(e.target.value)} />
      </div>
      <div className="field">
        <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '1rem' }}>
        <button className="link" disabled={!dirty || saving} onClick={async () => {
          setSaving(true)
          try {
            await updateClause(clause.id, { heading, body })
            onChanged()
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e))
          }
          setSaving(false)
        }}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <button className="link" onClick={async () => {
          try {
            await deleteClause(clause.id)
            onChanged()
          } catch (e) {
            onError(e instanceof Error ? e.message : String(e))
          }
        }}>
          Delete
        </button>
      </div>
    </div>
  )
}
