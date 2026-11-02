import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { money } from '../lib/charges'
import {
  END_REASONS, EVENT_TYPES, eventTypeLabel,
  endLease, fetchLeaseBalance,
  fetchLeaseEvents, addLeaseEvent, deleteLeaseEvent,
  uploadEventFile, listEventFiles, eventFileUrl,
  fetchDeposit, addDeduction, deleteDeduction, applyDepositToBalance,
  recordDepositReturn, undoDepositReturn,
  type EndReason, type EventType, type LeaseEvent, type EventFile,
  type DepositSummary, type DepositDeduction, type DepositReturn,
} from '../lib/leaseEnd'

const today = () => new Date().toLocaleDateString('en-CA') // YYYY-MM-DD, local

// ================================================================ ending ==

/**
 * Recording that a tenancy is over: the move-out date, why, and whether
 * the tenant keeps their sign-in. See end_lease() in
 * db/migrations/033_lease_endings.sql for what it does to the ledger.
 */
export function EndLeaseForm({
  leaseId, tenantNames, onDone, onCancel,
}: {
  leaseId: string
  tenantNames: string
  onDone: () => void
  onCancel: () => void
}) {
  const [moveOut, setMoveOut] = useState(today())
  const [reason, setReason] = useState<EndReason>('moved_out_early')
  const [note, setNote] = useState('')
  const [owed, setOwed] = useState<number | null>(null)
  const [keepAccess, setKeepAccess] = useState(true)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Keeping access defaults to "yes" when money is owed — a former tenant
  // with a balance needs to be able to see it and pay it — and to "no"
  // when nothing is.
  useEffect(() => {
    fetchLeaseBalance(leaseId)
      .then((o) => { setOwed(o); setKeepAccess(o > 0) })
      .catch(() => setOwed(null))
  }, [leaseId])

  async function submit() {
    setBusy(true)
    setError(null)
    try {
      await endLease({ leaseId, moveOut, reason, note, keepAccess })
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
      setConfirming(false)
    }
  }

  return (
    <div className="card-list" style={{ marginTop: '0.75rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>End this lease</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          Record this once the tenant has actually left. Rent stops billing
          after the move-out date, the unit shows as vacant, and you can
          start a new lease on it. Anything owed up to that date stays owed.
        </p>
        {reason === 'eviction' && (
          <p className="muted">
            This records the outcome — it doesn't file or serve anything.
            An eviction goes through the courts; keep the notices and
            filings in the lease record.
          </p>
        )}

        <div className="field">
          <label htmlFor="el-date">Move-out date</label>
          <input id="el-date" type="date" required value={moveOut} max={today()}
            onChange={(e) => setMoveOut(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="el-reason">Reason</label>
          <select id="el-reason" value={reason}
            onChange={(e) => setReason(e.target.value as EndReason)}>
            {END_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="el-note">Note (optional)</label>
          <textarea id="el-note" rows={2} value={note}
            placeholder="e.g. Keys returned, forwarding address…"
            onChange={(e) => setNote(e.target.value)} />
        </div>

        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
          <input type="checkbox" checked={keepAccess}
            onChange={(e) => setKeepAccess(e.target.checked)} style={{ marginTop: '0.25rem' }} />
          <span>
            Let {tenantNames || 'the tenant'} keep signing in to see and pay
            what they owe
            {owed !== null && (
              <span className="muted" style={{ display: 'block' }}>
                {owed > 0 ? `${money(owed)} is owed on this lease right now.` : 'Nothing is owed right now.'}
                {' '}They won't be able to report repairs either way.
              </span>
            )}
          </span>
        </label>

        {error && <p className="error-text">{error}</p>}

        {confirming ? (
          <>
            <p style={{ fontWeight: 600 }}>
              End this lease as of {moveOut}? This can't be undone from the app.
            </p>
            <button className="primary" disabled={busy} onClick={submit}
              style={{ background: 'var(--danger)' }}>
              {busy ? 'Ending…' : 'Yes, end the lease'}
            </button>
          </>
        ) : (
          <button className="primary" onClick={() => setConfirming(true)} disabled={!moveOut}>
            End lease
          </button>
        )}
        <button className="link" type="button" onClick={onCancel} style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ============================================================ the record ==

/**
 * A dated timeline against a lease: notices, filings, hearings, notes, with
 * documents attached. Office only (RLS in 033).
 */
export function LeaseRecord({ leaseId, memberId }: { leaseId: string; memberId: string }) {
  const [events, setEvents] = useState<LeaseEvent[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function load() {
    fetchLeaseEvents(leaseId).then(setEvents).catch((e) => setError(errorMessage(e)))
  }
  useEffect(load, [leaseId])

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <p className="muted" style={{ marginTop: 0 }}>
        Notices served, court dates, agreements and notes — with copies
        attached. Only you and your property managers can see this.
      </p>
      {error && <p className="error-text">{error}</p>}
      {events === null && !error && <p className="muted">Loading…</p>}
      {events?.length === 0 && !adding && <p className="empty-state" style={{ padding: 0 }}>Nothing recorded yet.</p>}

      {adding ? (
        <EventForm leaseId={leaseId} memberId={memberId}
          onDone={() => { setAdding(false); load() }} onCancel={() => setAdding(false)} />
      ) : (
        <button className="link" onClick={() => setAdding(true)}>+ Add to record</button>
      )}

      {events && events.length > 0 && (
        <ol style={{ listStyle: 'none', padding: 0, margin: '0.75rem 0 0',
                     borderLeft: '2px solid var(--line)' }}>
          {events.map((ev) => (
            <EventItem key={ev.id} event={ev} onChanged={load} />
          ))}
        </ol>
      )}
    </div>
  )
}

function EventItem({ event, onChanged }: { event: LeaseEvent; onChanged: () => void }) {
  const [files, setFiles] = useState<EventFile[]>([])
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listEventFiles(event.lease_id, event.id).then(setFiles).catch(() => setFiles([]))
  }, [event.id])

  async function open(path: string) {
    // Opened synchronously so a phone's popup blocker allows it, then
    // pointed at the signed URL once it exists.
    const w = window.open('', '_blank')
    try {
      const url = await eventFileUrl(path)
      if (url && w) w.location.href = url
      else w?.close()
    } catch (e) {
      w?.close()
      setError(errorMessage(e))
    }
  }

  return (
    <li style={{ padding: '0 0 1rem 0.9rem', position: 'relative' }}>
      <span aria-hidden style={{ position: 'absolute', left: '-0.4rem', top: '0.35rem', width: '0.7rem',
        height: '0.7rem', borderRadius: '50%', background: 'var(--accent)' }} />
      <div className="muted" style={{ margin: 0 }}>
        {event.event_date} · {eventTypeLabel(event.event_type)}
      </div>
      <strong>{event.title}</strong>
      {event.details && <div style={{ whiteSpace: 'pre-wrap' }}>{event.details}</div>}
      {files.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem', marginTop: '0.25rem' }}>
          {files.map((f) => (
            <button key={f.path} className="link" style={{ textAlign: 'left' }} onClick={() => open(f.path)}>
              📎 {f.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="error-text">{error}</p>}
      <div style={{ marginTop: '0.25rem' }}>
        {confirming ? (
          <span style={{ display: 'inline-flex', gap: '1rem' }}>
            <button className="link" style={{ color: 'var(--danger)' }} onClick={async () => {
              try { await deleteLeaseEvent(event.lease_id, event.id); onChanged() }
              catch (e) { setError(errorMessage(e)); setConfirming(false) }
            }}>Yes, delete</button>
            <button className="link" onClick={() => setConfirming(false)}>Keep</button>
          </span>
        ) : (
          <button className="link" style={{ fontSize: '0.8rem' }} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

function EventForm({
  leaseId, memberId, onDone, onCancel,
}: { leaseId: string; memberId: string; onDone: () => void; onCancel: () => void }) {
  const [type, setType] = useState<EventType>('notice_served')
  const [date, setDate] = useState(today())
  const [title, setTitle] = useState('')
  const [details, setDetails] = useState('')
  const [files, setFiles] = useState<File[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const id = await addLeaseEvent({
        leaseId, type, date, title: title || eventTypeLabel(type), details, memberId,
      })
      for (const f of files) await uploadEventFile(leaseId, id, f)
      onDone()
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '0.5rem' }}>
      <div>
        <div className="field">
          <label htmlFor="ev-type">What happened</label>
          <select id="ev-type" value={type} onChange={(e) => setType(e.target.value as EventType)}>
            {EVENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ev-date">Date</label>
          <input id="ev-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ev-title">Title</label>
          <input id="ev-title" value={title} placeholder={eventTypeLabel(type)}
            onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ev-details">Details</label>
          <textarea id="ev-details" rows={3} value={details}
            placeholder="How it was served, case number, what was agreed…"
            onChange={(e) => setDetails(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ev-files">Attach documents or photos (optional)</label>
          <input id="ev-files" type="file" multiple accept="image/*,application/pdf"
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Add to record'}
        </button>
        <button className="link" type="button" onClick={onCancel} style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}

// =========================================================== the deposit ==

/**
 * The security deposit after a move-out: what was held, what's deducted
 * and why, what went to unpaid rent, and the refund.
 */
export function DepositPanel({ leaseId, memberId }: { leaseId: string; memberId: string }) {
  const [summary, setSummary] = useState<DepositSummary | null>(null)
  const [deductions, setDeductions] = useState<DepositDeduction[]>([])
  const [refund, setRefund] = useState<DepositReturn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [desc, setDesc] = useState('')
  const [amount, setAmount] = useState('')
  const [refunding, setRefunding] = useState(false)

  function load() {
    fetchDeposit(leaseId)
      .then((d) => { setSummary(d.summary); setDeductions(d.deductions); setRefund(d.refund) })
      .catch((e) => setError(errorMessage(e)))
  }
  useEffect(load, [leaseId])

  async function run(fn: () => Promise<unknown>) {
    setBusy(true)
    setError(null)
    try { await fn(); load() } catch (e) { setError(errorMessage(e)) }
    setBusy(false)
  }

  if (!summary) return error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>

  if (summary.held === 0 && deductions.length === 0 && !refund) {
    return <p className="muted" style={{ marginTop: '0.5rem' }}>No deposit was paid on this lease.</p>
  }

  const row = (label: string, value: string, strong = false) => (
    <tr className={strong ? 'total' : undefined}>
      <td>{label}</td><td className="amount">{value}</td>
    </tr>
  )

  return (
    <div style={{ marginTop: '0.5rem' }}>
      <table className="lease-doc-table">
        <tbody>
          {row('Deposit held', money(summary.held))}
          {deductions.map((d) => (
            <tr key={d.id}>
              <td>
                − {d.description}
                {!d.applied_to_balance && !refund && (
                  <button className="link" style={{ marginLeft: '0.5rem', fontSize: '0.8rem' }}
                    disabled={busy} onClick={() => run(() => deleteDeduction(d.id))}>remove</button>
                )}
              </td>
              <td className="amount">−{money(d.amount)}</td>
            </tr>
          ))}
          {refund && row(`− Refunded ${refund.returned_on}${refund.method ? ` (${refund.method})` : ''}`,
                         `−${money(refund.amount)}`)}
          {row(refund ? 'Left over' : 'Left to refund', money(summary.remaining), true)}
        </tbody>
      </table>
      {summary.owed > 0 && (
        <p className="muted">The tenant still owes {money(summary.owed)} on this lease.</p>
      )}
      {error && <p className="error-text">{error}</p>}

      {!refund && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              const n = Number(amount)
              if (!desc.trim() || !(n > 0)) return
              run(async () => { await addDeduction(leaseId, desc, n, memberId); setDesc(''); setAmount('') })
            }}
            style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}
          >
            <input aria-label="Deduction reason" placeholder="Deduction, e.g. carpet cleaning"
              value={desc} onChange={(e) => setDesc(e.target.value)}
              style={{ flex: '2 1 10rem', padding: '0.45rem' }} />
            <input aria-label="Deduction amount" type="number" min="0.01" step="0.01" placeholder="$"
              value={amount} onChange={(e) => setAmount(e.target.value)}
              style={{ flex: '1 1 5rem', padding: '0.45rem' }} />
            <button className="seg-item" type="submit" disabled={busy} style={{ flex: '0 0 auto' }}>
              + Deduct
            </button>
          </form>

          {summary.remaining > 0 && summary.owed > 0 && (
            <button className="link" disabled={busy} style={{ marginTop: '0.75rem', display: 'block' }}
              onClick={() => run(() => applyDepositToBalance(leaseId))}>
              Apply {money(Math.min(summary.remaining, summary.owed))} of the deposit to unpaid rent and fees
            </button>
          )}

          {refunding ? (
            <RefundForm leaseId={leaseId} max={summary.remaining}
              onDone={() => { setRefunding(false); load() }} onCancel={() => setRefunding(false)} />
          ) : (
            <button className="link" style={{ marginTop: '0.75rem', display: 'block' }}
              onClick={() => setRefunding(true)}>
              Record the refund{summary.remaining === 0 ? ' (nothing left to return)' : ''}
            </button>
          )}
          <p className="muted" style={{ marginTop: '0.75rem' }}>
            Kentucky law sets deadlines and itemization rules for returning a
            deposit — check them before you settle it.
          </p>
        </>
      )}

      {refund && (
        <button className="link" disabled={busy} style={{ marginTop: '0.5rem' }}
          onClick={() => run(() => undoDepositReturn(leaseId))}>
          Undo the recorded refund
        </button>
      )}
    </div>
  )
}

function RefundForm({
  leaseId, max, onDone, onCancel,
}: { leaseId: string; max: number; onDone: () => void; onCancel: () => void }) {
  const [amount, setAmount] = useState(max.toFixed(2))
  const [date, setDate] = useState(today())
  const [method, setMethod] = useState('check')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <form className="card-list" style={{ marginTop: '0.5rem' }} onSubmit={async (e) => {
      e.preventDefault()
      setBusy(true); setError(null)
      try {
        await recordDepositReturn({ leaseId, amount: Number(amount), date, method, note })
        onDone()
      } catch (err) { setError(errorMessage(err)); setBusy(false) }
    }}>
      <div>
        <div className="field">
          <label htmlFor="dr-amount">Amount returned</label>
          <input id="dr-amount" type="number" min="0" step="0.01" max={max} required value={amount}
            onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dr-date">Date sent</label>
          <input id="dr-date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="dr-method">How</label>
          <select id="dr-method" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="check">Check</option>
            <option value="bank_transfer">Bank transfer</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="dr-note">Note</label>
          <input id="dr-note" value={note} placeholder="Check number, where it was mailed…"
            onChange={(e) => setNote(e.target.value)} />
        </div>
        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Record refund'}
        </button>
        <button className="link" type="button" onClick={onCancel} style={{ marginTop: '0.5rem' }}>
          Cancel
        </button>
      </div>
    </form>
  )
}
