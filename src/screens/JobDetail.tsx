import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import {
  fetchJobEntries, addJobEntry, fetchJobTotals, setJobStatus, setCompletionNotes,
  JOB_STATUS_LABEL, friendlyDate,
  uploadReceipt, listReceipts, receiptUrl,
  type Job, type JobEntry, type JobTotals,
} from '../lib/maintenance'
import { money } from '../lib/charges'
import { vendorLabel } from '../lib/finance'
import { EquipmentList } from './EquipmentList'

type Props = {
  job: Job
  /** The viewer's own org_members id — job entries are attributed to it. */
  memberId: string
  canEdit: boolean
  onBack: () => void
  onChanged: () => void
}

/** The choices in Log work, in the order a technician usually needs them. */
const ENTRY_CHOICES: [JobEntry['entry_type'], string][] = [
  ['material', 'Materials'], ['mileage', 'Mileage'], ['labor', 'Time'], ['note', 'Note'],
]

/**
 * On a job an outside company was hired for, the office is recording
 * their bill, not anyone's time or driving. An invoice is stored as a
 * labor entry with a cost and no hours (039).
 */
const VENDOR_ENTRY_CHOICES: [JobEntry['entry_type'], string][] = [
  ['labor', 'Invoice'], ['material', 'Materials'], ['note', 'Note'],
]

const ENTRY_LABEL: Record<JobEntry['entry_type'], string> = {
  labor: 'Labor', mileage: 'Mileage', material: 'Materials', note: 'Note',
}

export function JobDetail({ job, memberId, canEdit, onBack, onChanged }: Props) {
  const hired = job.vendor_id != null
  const [completing, setCompleting] = useState(false)
  const [entries, setEntries] = useState<JobEntry[] | null>(null)
  const [totals, setTotals] = useState<JobTotals | null>(null)
  const [receipts, setReceipts] = useState<string[]>([])
  const [receiptsError, setReceiptsError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Each part loads on its own. With Promise.all, one failure — receipts,
  // which come from the separate file storage service — left the log on
  // "Loading…" forever and put a bare error at the top of the job.
  async function load() {
    const [e, t, r] = await Promise.allSettled([
      fetchJobEntries(job.id), fetchJobTotals(job.id), listReceipts(job.id),
    ])
    if (e.status === 'fulfilled') setEntries(e.value)
    else setError(errorMessage(e.reason))
    if (t.status === 'fulfilled') setTotals(t.value)
    if (r.status === 'fulfilled') { setReceipts(r.value); setReceiptsError(null) }
    else setReceiptsError(errorMessage(r.reason))
  }

  useEffect(() => { load() }, [job.id])

  return (
    <div>
      <button className="link" onClick={onBack}>← All jobs</button>
      <h2 style={{ marginBottom: '0.25rem' }}>
        {job.properties?.name}{job.units?.label ? ` · ${job.units.label}` : ''}
      </h2>
      <p className="muted" style={{ marginTop: 0 }}>
        {JOB_STATUS_LABEL[job.status] ?? job.status}
        {job.completed_date ? ` · finished ${friendlyDate(job.completed_date)}`
          : job.scheduled_date ? ` · booked for ${friendlyDate(job.scheduled_date)}` : ''}
      </p>
      {job.notes && <p>{job.notes}</p>}
      {job.vendors && (
        <p>
          Hired: <strong>{vendorLabel(job.vendors)}</strong>
          {job.vendors.phone && (
            <> · <a href={`tel:${job.vendors.phone}`}>{job.vendors.phone}</a></>
          )}
          {job.vendors.email && (
            <> · <a href={`mailto:${job.vendors.email}`}>{job.vendors.email}</a></>
          )}
        </p>
      )}

      {error && <p className="error-text">{error}</p>}

      {/* Assigned jobs are simply the technician's (034) — no accept or
          decline step, so the work controls are there from the start. */}
      {canEdit && !completing && job.status !== 'completed' && job.status !== 'declined'
        && job.status !== 'canceled' && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1rem' }}>
          {job.status !== 'in_progress' && (
            <button className="link" onClick={async () => {
              await setJobStatus(job.id, 'in_progress'); onChanged()
            }}>Start work</button>
          )}
          <button className="link" onClick={() => setCompleting(true)}>
            Mark complete
          </button>
        </div>
      )}

      {/* Finishing asks what was done, while it is fresh. Optional: a
          dripping tap needs no write-up. */}
      {completing && (
        <WorkDoneForm
          initial={job.completion_notes ?? ''}
          submitLabel="Mark complete"
          onCancel={() => setCompleting(false)}
          onSave={async (notes) => {
            await setCompletionNotes(job.id, notes)
            await setJobStatus(job.id, 'completed')
            setCompleting(false)
            onChanged()
          }}
        />
      )}

      {!completing && (canEdit || job.completion_notes) && (
        <WorkDone job={job} canEdit={canEdit} onChanged={onChanged} />
      )}

      {/* What is installed where the work is, so the make and model are
          in front of whoever is about to look up a part. Deleting is left
          to the property screen; here it is look-up and record. */}
      <h3 style={{ marginTop: '1.5rem' }}>
        {job.unit_id ? 'Equipment in this unit' : 'Equipment at this property'}
      </h3>
      <EquipmentList propertyId={job.property_id} unitId={job.unit_id}
        memberId={memberId} canDelete={false} readOnly={!canEdit} />

      {totals && hired && (
        <div className="card-list">
          <div>
            <strong>{money(Number(totals.total_cost))}</strong> spent
            <div className="muted">The company's invoice plus any materials.</div>
          </div>
        </div>
      )}
      {totals && !hired && (
        <div className="card-list">
          <div>
            <strong>{money(Number(totals.total_cost))}</strong> spent
            <div className="muted">
              {/* A job that has been started counts as at least one hour,
                  however little time is logged against it — the minimum
                  for showing up. Display only: the logged entries keep
                  the real figures. */}
              {job.status === 'in_progress' || job.status === 'completed'
                ? Math.max(1, Number(totals.total_hours))
                : Number(totals.total_hours)} hour(s) · {Number(totals.total_miles)} mile(s)
            </div>
            {/* Labor is counted but not priced: technicians are paid
                outside the app, so pricing hours here would produce a
                total that looks authoritative and is wrong. */}
            <div className="muted">
              Cost is materials plus mileage. Hours are tracked, not costed.
            </div>
          </div>
        </div>
      )}

      {canEdit && <AddEntry jobId={job.id} memberId={memberId} hired={hired} onAdded={load} />}

      <h3 style={{ marginTop: '2rem' }}>Log</h3>
      {entries === null ? <p className="muted">Loading…</p>
        : entries.length === 0 ? <p className="empty-state">Nothing logged yet.</p> : (
        <div className="card-list">
          {entries.map((e) => (
            <div key={e.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {e.entry_type === 'labor' && (hired || e.hours == null)
                    ? 'Invoice' : ENTRY_LABEL[e.entry_type]}
                </strong>
                <span className="muted" style={{ margin: 0 }}>
                  {friendlyDate(e.created_at)}
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

      {/* Receipts are added with the purchase they belong to, in Log work
          above; this section only shows what has been attached. */}
      <h3 style={{ marginTop: '2rem' }}>Receipts</h3>
      {/* Said here, under Receipts, rather than at the top of the job: it
          is the file service that is unreachable, not the job. */}
      {receiptsError ? (
        <p className="error-text">
          Receipts can't be loaded right now ({receiptsError}). The rest of
          the job is unaffected.
        </p>
      ) : receipts.length === 0 ? (
        <p className="empty-state">No receipts yet.</p>
      ) : (
        <div className="card-list">
          {receipts.map((p) => <ReceiptRow key={p} path={p} />)}
        </div>
      )}
    </div>
  )
}

/** What was done: read by anyone who opens the job, edited by the office. */
function WorkDone({
  job, canEdit, onChanged,
}: { job: Job; canEdit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <WorkDoneForm
        initial={job.completion_notes ?? ''}
        submitLabel="Save"
        onCancel={() => setEditing(false)}
        onSave={async (notes) => {
          await setCompletionNotes(job.id, notes)
          setEditing(false)
          onChanged()
        }}
      />
    )
  }
  return (
    <div style={{ marginBottom: '1rem' }}>
      <h3 style={{ marginBottom: '0.25rem' }}>What was done</h3>
      {job.completion_notes
        ? <p style={{ marginTop: 0, whiteSpace: 'pre-wrap' }}>{job.completion_notes}</p>
        : <p className="empty-state" style={{ marginTop: 0 }}>Nothing written yet.</p>}
      {canEdit && (
        <button className="link" onClick={() => setEditing(true)}>
          {job.completion_notes ? 'Edit' : 'Add notes'}
        </button>
      )}
    </div>
  )
}

function WorkDoneForm({
  initial, submitLabel, onSave, onCancel,
}: {
  initial: string
  submitLabel: string
  onSave: (notes: string) => Promise<void>
  onCancel: () => void
}) {
  const [notes, setNotes] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <form className="card-list" style={{ marginBottom: '1rem' }} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError(null)
      try {
        await onSave(notes)
      } catch (err) {
        setError(errorMessage(err))
        setBusy(false)
      }
    }}>
      <div>
        <div className="field">
          <label htmlFor="work-done">What was done (optional)</label>
          <textarea id="work-done" rows={4} value={notes}
            placeholder="Treated kitchen and basement. Follow-up visit in 30 days."
            onChange={(e) => setNotes(e.target.value)} />
          <span className="muted">For your records — the tenant doesn't see this.</span>
        </div>
        {error && <p className="error-text">{error}</p>}
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
          <button className="link" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </form>
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

function AddEntry({
  jobId, memberId, hired, onAdded,
}: { jobId: string; memberId: string; hired: boolean; onAdded: () => void }) {
  const choices = hired ? VENDOR_ENTRY_CHOICES : ENTRY_CHOICES
  const [type, setType] = useState<JobEntry['entry_type']>(choices[0][0])
  // A vendor's invoice: labor with a cost and no hours.
  const invoice = hired && type === 'labor'
  const [description, setDescription] = useState('')
  const [hours, setHours] = useState('')
  const [miles, setMiles] = useState('')
  const [cost, setCost] = useState('')
  const [vendor, setVendor] = useState('')
  const [receipt, setReceipt] = useState<File | null>(null)
  // Bumped after a save to remount the file input, which is the only way
  // to clear what it shows as chosen.
  const [receiptKey, setReceiptKey] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    const num = (s: string) => (s.trim() === '' ? null : Number(s))
    // A purchase needs its receipt. Checked here as well as by `required`
    // on the input, since that is the attribute some phone browsers skip.
    if (type === 'material' && !receipt) {
      setError('Add a photo of the receipt for this purchase.')
      setBusy(false)
      return
    }
    try {
      // The receipt goes up first: if it fails, nothing is logged and the
      // technician can retry the whole thing, rather than ending up with a
      // purchase in the log and no receipt behind it.
      const attach = type === 'material' || type === 'labor' ? receipt : null
      if (attach) await uploadReceipt(jobId, attach)
      await addJobEntry({
        jobId, technicianId: memberId, entryType: type,
        description: description.trim() || null,
        // Only the figure this entry type is for is sent; the database
        // rejects an entry that carries nothing measurable.
        hours: type === 'labor' && !invoice ? num(hours) : null,
        miles: type === 'mileage' ? num(miles) : null,
        // Both materials and labor can carry a cost now; the database has
        // always allowed it and job_totals has always counted it.
        cost: type === 'material' || type === 'labor' ? num(cost) : null,
        vendor: type === 'material' ? (vendor.trim() || null) : null,
      })
      setDescription(''); setHours(''); setMiles(''); setCost(''); setVendor('')
      setReceipt(null); setReceiptKey((k) => k + 1)
      onAdded()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '1rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>{hired ? 'Record a cost' : 'Log work'}</h3>
        {/* All four kinds side by side, not in a dropdown: behind a
            select reading "Materials bought", mileage and time were easy
            to miss entirely — the form looked like it only took receipts. */}
        <div className="field">
          <span className="muted">What are you recording?</span>
          <div className="seg" role="radiogroup" aria-label="What are you recording?">
            {choices.map(([value, label]) => (
              <button key={value} type="button" role="radio"
                aria-checked={type === value}
                className={type === value ? 'seg-item is-current' : 'seg-item'}
                onClick={() => setType(value)}>
                {label}
              </button>
            ))}
          </div>
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
        {invoice && (
          <div className="field">
            <label htmlFor="e-invoice">Invoice amount ($)</label>
            <input id="e-invoice" type="number" min="0" step="0.01" required
              value={cost} onChange={(e) => setCost(e.target.value)} />
          </div>
        )}
        {type === 'labor' && !invoice && (
          <>
            <div className="field">
              <label htmlFor="e-hours">Hours</label>
              <input id="e-hours" type="number" min="0" step="0.25" required
                value={hours} onChange={(e) => setHours(e.target.value)} />
            </div>
            {/* What the technician charged, if anything. Optional because
                hours worked and money owed are not the same claim — a
                landlord doing the work themselves logs hours and pays
                nobody. Without this box the only way to record a $75
                invoice was to file it as materials and misdescribe it.
                job_totals() has always summed cost across every entry
                type, so this needed no schema change. */}
            <div className="field">
              <label htmlFor="e-labor-cost">What you paid for it ($)</label>
              <input id="e-labor-cost" type="number" min="0" step="0.01"
                value={cost} onChange={(e) => setCost(e.target.value)} />
              <span className="muted">
                Leave blank if nobody was paid — the hours are still recorded.
              </span>
            </div>
          </>
        )}

        {(type === 'material' || type === 'labor') && (
          <div className="field">
            <label htmlFor="e-receipt">
              {type === 'material' ? 'Receipt photo'
                : invoice ? 'Invoice photo or PDF (optional)' : 'Invoice or receipt (optional)'}
            </label>
            <input
              key={receiptKey}
              id="e-receipt"
              type="file"
              // No `capture`, which limited a phone to the camera: a receipt
              // photographed earlier, or emailed as a PDF, has to be pickable
              // too. The phone still offers Take Photo first.
              accept="image/*,application/pdf"
              required={type === 'material'}
              onChange={(e) => setReceipt(e.target.files?.[0] ?? null)}
            />
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
