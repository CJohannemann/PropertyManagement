import { useEffect, useState } from 'react'
import {
  fetchDefaultTemplate, createTemplate, updateClause, deleteClause, addClause,
  AVAILABLE_PLACEHOLDERS, type TemplateWithClauses,
} from '../lib/leaseTemplates'
import { STARTER_CLAUSES } from '../lib/starterClauses'
import { splitIntoClauses } from '../lib/splitClauses'

type Props = { organizationId: string; onBack: () => void }

export function LeaseTemplates({ organizationId, onBack }: Props) {
  const [template, setTemplate] = useState<TemplateWithClauses | null | 'loading'>('loading')
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
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

  async function generate() {
    setBusy(true); setError(null)
    try {
      await createTemplate(
        organizationId,
        'Residential lease',
        STARTER_CLAUSES.map((c) => ({
          heading: c.heading, body: c.body, omit_if_empty: c.omitIfEmpty ?? [],
        })),
        true,
      )
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    setBusy(false)
  }

  async function importPasted(text: string) {
    setBusy(true); setError(null)
    try {
      const clauses = splitIntoClauses(text)
      await createTemplate(
        organizationId,
        'My lease',
        clauses.length ? clauses : [{ heading: 'Agreement', body: text }],
        true,
      )
      setPasting(false)
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
        <p className="muted">
          The app fills in the figures — rent, dates, deposits, late fees —
          but the wording is your document. Requirements differ by state,
          and a lease is something you and your attorney are responsible
          for, so it isn't something the app can supply on your behalf.
        </p>
        {error && <p className="error-text">{error}</p>}

        {pasting ? (
          <PasteLease busy={busy} onImport={importPasted} onCancel={() => setPasting(false)} />
        ) : (
          <div className="card-list">
            <div>
              <strong>Use the lease you already have</strong>
              <p className="muted">
                Paste it in and it's split into clauses automatically, so
                each part can be edited on its own. Works from Word, Google
                Docs, or a PDF — copy the text, not the file.
              </p>
              <button className="primary" disabled={busy} onClick={() => setPasting(true)}>
                Paste my lease
              </button>
            </div>

            <div>
              <strong>Generate one to start from</strong>
              <p className="muted">
                A {STARTER_CLAUSES.length}-clause residential lease covering
                the usual ground — term, rent, deposits, utilities,
                maintenance, access, notices. Adapted from a Kentucky lease,
                so treat it as a skeleton to edit rather than something to
                use as-is, and have your attorney read it before anyone
                signs. It may be wrong for your state.
              </p>
              <button className="primary" disabled={busy} onClick={generate}>
                Generate a starter lease
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <button className="link" onClick={onBack}>← Back</button>
      <h2>{template.name}</h2>
      <p className="muted">
        {'Insert lease figures with {braces}: '}
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

function PasteLease({
  busy, onImport, onCancel,
}: { busy: boolean; onImport: (t: string) => void; onCancel: () => void }) {
  const [text, setText] = useState('')
  // Shown before importing, so it's obvious the split is a guess that can
  // be corrected rather than something that happened to the document.
  const preview = text.trim() ? splitIntoClauses(text) : []

  return (
    <div className="card-list">
      <div>
        <h3 style={{ marginTop: 0 }}>Paste your lease</h3>
        <div className="field">
          <textarea rows={14} value={text} onChange={(e) => setText(e.target.value)}
            placeholder="Paste the full text of your lease agreement here…" />
        </div>

        {preview.length > 0 && (
          <p className="muted">
            Found {preview.length} clause{preview.length === 1 ? '' : 's'}:{' '}
            {preview.slice(0, 6).map((c) => c.heading).join(', ')}
            {preview.length > 6 ? ', …' : ''}. You can edit, merge or delete
            any of them afterwards.
          </p>
        )}

        <button className="primary" disabled={busy || text.trim() === ''}
          onClick={() => onImport(text)}>
          {busy ? 'Importing…' : 'Import this lease'}
        </button>
        <button className="link" type="button" onClick={onCancel}
          style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
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
