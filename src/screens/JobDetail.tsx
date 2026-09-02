import { useEffect, useState } from 'react'
import {
  fetchJobEntries, addJobEntry, fetchJobTotals, setJobStatus,
  uploadReceipt, listReceipts, receiptUrl,
  type Job, type JobEntry, type JobTotals,
} from '../lib/maintenance'
import { money } from '../lib/charges'

type Props = {
  job: Job
  /** The viewer's own org_members id — job entries are attributed to it. */
  memberId: string
  canEdit: boolean
  onBack: () => void
  onChanged: () => void
}

const ENTRY_LABEL: Record<JobEntry['entry_type'], string> = {
  labor: 'Labor', mileage: 'Mileage', material: 'Materials', note: 'Note',
}

export function JobDetail({ job, memberId, canEdit, onBack, onChanged }: Props) {
  const [entries, setEntries] = useState<JobEntry[] | null>(null)
  const [totals, setTotals] = useState<JobTotals | null>(null)
  const [receipts, setReceipts] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const [e, t, r] = await Promise.all([
        fetchJobEntries(job.id), fetchJobTotals(job.id), listReceipts(job.id),
      ])
      setEntries(e); setTotals(t); setReceipts(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { load() }, [job.id])

  return (
    <div>
      <button className="link" onClick={onBack}>← All jobs</button>
      <h2 style={{ marginBottom: '0.25rem' }}>
        {job.properties?.name}{job.units?.label ? ` · ${job.units.label}` : ''}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {job.status}
        {job.scheduled_date ? ` · scheduled ${job.scheduled_date}` : ''}
        {job.completed_date ? ` · completed ${job.completed_date}` : ''}
      </p>
      {job.notes && <p>{job.notes}</p>}

      {error && <p className="error-text">{error}</p>}

      {canEdit && job.status !== 'completed' && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          {job.status !== 'in_progress' && (
            <button className="link" onClick={async () => {
              await setJobStatus(job.id, 'in_progress'); onChanged()
            }}>Start work</button>
          )}
          <button className="link" onClick={async () => {
            await setJobStatus(job.id, 'completed'); onChanged()
          }}>Mark complete</button>
        </div>
      )}

      {totals && (
        <div className="card-list">
          <div>
            <strong>{money(Number(totals.total_cost))}</strong> spent
            <div className="muted">
              {Number(totals.total_hours)} hour(s) · {Number(totals.total_miles)} mile(s)
            </div>
            {/* Labour is counted but not priced: technicians are paid
                outside the app, so pricing hours here would produce a
                total that looks authoritative and is wrong. */}
            <div className="muted">
              Cost is materials plus mileage. Hours are tracked, not costed.
            </div>
          </div>
        </div>
      )}

      {canEdit && <AddEntry jobId={job.id} memberId={memberId} onAdded={load} />}

      <h3 style={{ marginTop: '2rem' }}>Log</h3>
      {entries === null ? <p className="muted">Loading…</p>
        : entries.length === 0 ? <p className="empty-state">Nothing logged yet.</p> : (
        <div className="card-list">
          {entries.map((e) => (
            <div key={e.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>{ENTRY_LABEL[e.entry_type]}</strong>
                <span className="muted" style={{ margin: 0 }}>
                  {e.created_at.slice(0, 10)}
                </span>
              </div>
              {e.description && <div>{e.description}</div>}
              <div className="muted">
                {[
                  e.hours != null ? `${e.hours} hr` : null,
                  e.miles != null ? `${e.miles} mi` : null,
                  e.cost != null ? money(Number(e.cost)) : null,
                  e.vendor,
                ].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ marginTop: '2rem' }}>Receipts</h3>
      {canEdit && <ReceiptUpload jobId={job.id} onUploaded={load} onError={setError} />}
      {receipts.length === 0 ? (
        <p className="empty-state">No receipts yet.</p>
      ) : (
        <div className="card-list">
          {receipts.map((p) => <ReceiptRow key={p} path={p} />)}
        </div>
      )}
    </div>
  )
}

function ReceiptRow({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  // Signed on demand rather than eagerly: the bucket is private, links
  // expire, and generating one per receipt on load would be a burst of
  // requests for images mostly never opened.
  useEffect(() => { receiptUrl(path).then(setUrl).catch(() => setUrl(null)) }, [path])
  return (
    <div>
      {url
        ? <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt="Receipt" style={{ maxWidth: '100%', borderRadius: 6 }} />
          </a>
        : <span className="muted">Loading…</span>}
    </div>
  )
}

function ReceiptUpload({
  jobId, onUploaded, onError,
}: { jobId: string; onUploaded: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="field">
      <label htmlFor="receipt">Add a receipt photo</label>
      <input
        id="receipt"
        type="file"
        // `capture` opens the camera directly on a phone rather than the
        // file browser — this is used standing in someone's kitchen.
        accept="image/*,application/pdf"
        capture="environment"
        disabled={busy}
        onChange={async (e) => {
          const file = e.target.files?.[0]
          if (!file) return
          setBusy(true)
          try {
            await uploadReceipt(jobId, file)
            onUploaded()
          } catch (err) {
            onError(err instanceof Error ? err.message : String(err))
          }
          setBusy(false)
          e.target.value = ''
        }}
      />
      {busy && <span className="muted">Uploading…</span>}
    </div>
  )
}

function AddEntry({
  jobId, memberId, onAdded,
}: { jobId: string; memberId: string; onAdded: () => void }) {
  const [type, setType] = useState<JobEntry['entry_type']>('material')
  const [description, setDescription] = useState('')
  const [hours, setHours] = useState('')
  const [miles, setMiles] = useState('')
  const [cost, setCost] = useState('')
  const [vendor, setVendor] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const num = (s: string) => (s.trim() === '' ? null : Number(s))
    try {
      await addJobEntry({
        jobId, technicianId: memberId, entryType: type,
        description: description.trim() || null,
        // Only the figure this entry type is for is sent; the database
        // rejects an entry that carries nothing measurable.
        hours: type === 'labor' ? num(hours) : null,
        miles: type === 'mileage' ? num(miles) : null,
        cost: type === 'material' ? num(cost) : null,
        vendor: type === 'material' ? (vendor.trim() || null) : null,
      })
      setDescription(''); setHours(''); setMiles(''); setCost(''); setVendor('')
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>Log work</h3>
        <div className="field">
          <label htmlFor="e-type">What are you recording?</label>
          <select id="e-type" value={type}
            onChange={(e) => setType(e.target.value as JobEntry['entry_type'])}>
            <option value="material">Materials bought</option>
            <option value="mileage">Mileage</option>
            <option value="labor">Time worked</option>
            <option value="note">A note</option>
          </select>
        </div>

        {type === 'material' && (
          <>
            <div className="field">
              <label htmlFor="e-cost">Cost ($)</label>
              <input id="e-cost" type="number" min="0" step="0.01" required
                value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="e-vendor">Bought from</label>
              <input id="e-vendor" type="text" value={vendor}
                onChange={(e) => setVendor(e.target.value)} />
            </div>
          </>
        )}
        {type === 'mileage' && (
          <div className="field">
            <label htmlFor="e-miles">Miles</label>
            <input id="e-miles" type="number" min="0" step="0.1" required
              value={miles} onChange={(e) => setMiles(e.target.value)} />
          </div>
        )}
        {type === 'labor' && (
          <div className="field">
            <label htmlFor="e-hours">Hours</label>
            <input id="e-hours" type="number" min="0" step="0.25" required
              value={hours} onChange={(e) => setHours(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label htmlFor="e-desc">
            {type === 'note' ? 'Note' : 'Description (optional)'}
          </label>
          <input id="e-desc" type="text" required={type === 'note'}
            value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add to log'}
        </button>
      </div>
    </form>
  )
}
