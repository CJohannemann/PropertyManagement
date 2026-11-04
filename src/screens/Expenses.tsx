import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { money } from '../lib/charges'
import { navigate } from '../lib/route'
import {
  EXPENSE_CATEGORIES, PAID_BY, categoryInfo, totalsByCategory,
  fetchExpenseLines, fetchExpense, saveExpense, deleteExpense,
  uploadExpenseReceipt, removeExpenseReceipt, expenseReceiptUrl, fetchMileageRate,
  type ExpenseLine, type ExpenseCategory, type ExpenseRecord,
} from '../lib/expenses'
import {
  fetchVendors, vendorLabel, fetchClosedYears, confirmClosedYearChange,
  type Vendor, type PropertyRow,
} from '../lib/finance'

type Props = {
  organizationId: string
  /** Admins can set the per-mile rate; the hint about it says where. */
  isAdmin: boolean
  year: number
  properties: PropertyRow[]
}

function today(): string {
  // Local date, not UTC: a bill paid at 9pm is paid today, not tomorrow.
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * The expense log: what the properties cost to run in a year, by tax
 * category.
 *
 * The totals are in Schedule E order because that is the form they end up
 * on. Costs logged on repair jobs are listed too, so repairs never have to
 * be typed in twice; they are changed on the job, not here.
 */
export function Expenses({ organizationId, isAdmin, year, properties }: Props) {
  const [propertyId, setPropertyId] = useState<string>('')
  const [lines, setLines] = useState<ExpenseLine[] | null>(null)
  const [vendors, setVendors] = useState<Vendor[]>([])
  const [mileageRate, setMileageRate] = useState<number | null>(null)
  const [closedYears, setClosedYears] = useState<number[]>([])
  // null = no form; 'new' = adding; a record = editing that expense.
  const [editing, setEditing] = useState<'new' | ExpenseRecord | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchVendors(organizationId).then(setVendors).catch(() => setVendors([]))
    fetchClosedYears(organizationId).then((c) => setClosedYears(c.map((x) => x.year)))
      .catch(() => setClosedYears([]))
  }, [organizationId])
  useEffect(() => {
    fetchMileageRate(organizationId, year).then(setMileageRate).catch(() => setMileageRate(null))
  }, [organizationId, year])

  function load() {
    setError(null)
    fetchExpenseLines(organizationId, `${year}-01-01`, `${year}-12-31`, propertyId || null)
      .then(setLines)
      .catch((e) => { setError(errorMessage(e)); setLines([]) })
  }

  useEffect(load, [organizationId, year, propertyId])

  async function startEdit(id: string) {
    try {
      setEditing(await fetchExpense(id))
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const total = (lines ?? []).reduce((s, l) => s + l.amount, 0)
  const fromJobs = (lines ?? []).filter((l) => l.source === 'job')
    .reduce((s, l) => s + l.amount, 0)
  const byCategory = totalsByCategory(lines ?? [])

  return (
    <div>
      {editing ? (
        <ExpenseForm
          key={editing === 'new' ? 'new' : editing.id}
          organizationId={organizationId}
          properties={properties}
          vendors={vendors}
          closedYears={isAdmin ? closedYears : []}
          existing={editing === 'new' ? null : editing}
          onDone={(saved) => {
            setEditing(null)
            if (saved) load()
          }}
        />
      ) : (
        <button className="primary" onClick={() => setEditing('new')}
          style={{ marginBottom: '1rem' }}>
          + Add expense
        </button>
      )}

      <div className="filter-row" style={{ marginTop: editing ? '1.5rem' : 0 }}>
        <select aria-label="Property" value={propertyId}
          onChange={(e) => setPropertyId(e.target.value)}>
          <option value="">All properties</option>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {closedYears.includes(year) && (
        <p className="muted" style={{ marginTop: 0 }}>
          🔒 The books for {year} are closed.{' '}
          {isAdmin
            ? 'You can still change them; each change is recorded for your accountant.'
            : 'Only an admin can change them now.'}
        </p>
      )}
      {error && <p className="error-text">{error}</p>}
      {lines === null && !error && <p className="muted">Loading…</p>}

      {lines !== null && (
        <div className="card-list">
          <div>
            <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>{money(total)}</div>
            <div className="muted">
              spent in {year}{propertyId ? ` on ${properties.find((p) => p.id === propertyId)?.name ?? 'this property'}` : ''}
              {fromJobs > 0 && ` · ${money(fromJobs)} of it from repair jobs`}
            </div>
            {/* Shared bills (one insurance policy for everything) belong to
                no single property, so a property's view leaves them out —
                said, so its total isn't mistaken for the whole cost. */}
            {propertyId && (
              <div className="muted">Expenses shared across all properties aren't included.</div>
            )}

            {byCategory.length > 0 && (
              <table style={{ width: '100%', marginTop: '1rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr className="muted" style={{ fontSize: '0.8rem', textAlign: 'left' }}>
                    <th style={{ fontWeight: 400, paddingBottom: '0.25rem' }}>Category</th>
                    <th style={{ fontWeight: 400, textAlign: 'right' }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {byCategory.map((c) => (
                    <tr key={c.category} style={{ borderTop: '1px solid var(--line)' }}>
                      <td style={{ padding: '0.4rem 0' }}>
                        {c.label}
                        <span className="muted" style={{ fontSize: '0.8rem' }}> · line {c.line}</span>
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {money(c.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {byCategory.length > 0 && (
              <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
                Line numbers are Schedule E, where rental expenses go on a tax
                return. Depreciation is on the Taxes view.
              </p>
            )}
          </div>
        </div>
      )}

      {mileageRate === null && (
        <p className="muted" style={{ fontSize: '0.85rem' }}>
          Mileage logged on repair jobs in {year} isn't counted: there's no
          per-mile rate for {year} or earlier.{' '}
          {isAdmin
            ? <button className="link" onClick={() => navigate('/settings')}>Set one in Settings</button>
            : 'An admin can set one in Settings.'}
        </p>
      )}

      {lines !== null && (
        <>
          <h3 style={{ marginTop: '2rem' }}>All expenses</h3>
          {lines.length === 0 ? (
            <p className="empty-state">Nothing recorded for {year}.</p>
          ) : (
            <div className="card-list">
              {lines.map((l) => (
                <ExpenseRow key={`${l.source}-${l.id}`} line={l} onDeleted={load}
                  closedYears={isAdmin ? closedYears : []}
                  onEdit={() => startEdit(l.id)} onError={setError} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function ExpenseRow({
  line, onDeleted, onEdit, onError, closedYears,
}: {
  line: ExpenseLine
  /** Closed years to warn an admin about; empty for anyone else. */
  closedYears: number[]
  onDeleted: () => void
  onEdit: () => void
  onError: (m: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const info = categoryInfo(line.category)

  async function openReceipt() {
    if (!line.receipt_path) return
    // Opened before the await: Safari blocks a window opened after one.
    const w = window.open('', '_blank')
    try {
      const url = await expenseReceiptUrl(line.receipt_path)
      if (url && w) w.location.href = url
      else w?.close()
    } catch (e) {
      w?.close()
      onError(errorMessage(e))
    }
  }

  async function remove() {
    const y = Number(line.spent_on.slice(0, 4))
    if (closedYears.includes(y)) {
      if (!confirmClosedYearChange(y)) return
    } else if (!window.confirm(`Delete this ${money(line.amount)} expense?`)) return
    setBusy(true)
    try {
      await deleteExpense(line.id, line.receipt_path)
      onDeleted()
    } catch (e) {
      onError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
        <strong>{line.payee || line.description || info.label}</strong>
        <span style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {money(line.amount)}
        </span>
      </div>
      <div className="muted">
        {line.spent_on} · {info.label} · {line.property_name ?? 'All properties'}
      </div>
      {line.payee && line.description && <div className="muted">{line.description}</div>}
      {line.source === 'job' ? (
        <div className="muted" style={{ fontSize: '0.85rem' }}>
          From a repair job — change it on the job.
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem', flexWrap: 'wrap' }}>
          {line.receipt_path
            ? <button className="link" onClick={openReceipt}>View receipt</button>
            : <span className="muted" style={{ fontSize: '0.85rem' }}>No receipt</span>}
          <button className="link" onClick={onEdit} disabled={busy}>Edit</button>
          <button className="link" onClick={remove} disabled={busy}
            style={{ color: 'var(--danger)' }}>
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      )}
    </div>
  )
}

function ExpenseForm({
  organizationId, properties, vendors, existing, onDone, closedYears,
}: {
  organizationId: string
  properties: PropertyRow[]
  vendors: Vendor[]
  /** Closed years to warn an admin about; empty for anyone else. */
  closedYears: number[]
  existing: ExpenseRecord | null
  onDone: (saved: boolean) => void
}) {
  const [spentOn, setSpentOn] = useState(existing?.spent_on ?? today())
  const [amount, setAmount] = useState(existing ? String(existing.amount) : '')
  const [category, setCategory] = useState<ExpenseCategory>(existing?.category ?? 'repairs')
  // '' = shared across all properties. With one property there is nothing
  // to choose, so it is picked for them.
  const [propertyId, setPropertyId] = useState(
    existing ? existing.property_id ?? '' : properties.length === 1 ? properties[0].id : '')
  const [vendorId, setVendorId] = useState(existing?.vendor_id ?? '')
  const [payee, setPayee] = useState(existing?.payee ?? '')
  const [paidBy, setPaidBy] = useState(existing?.paid_by ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [receipt, setReceipt] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    // Both ends of a move: taking a bill out of a closed year changes it too.
    const touched = [spentOn, existing?.spent_on].filter(Boolean).map((d) => Number(d!.slice(0, 4)))
    const closedHit = touched.find((y) => closedYears.includes(y))
    if (closedHit && !confirmClosedYearChange(closedHit)) return
    setBusy(true); setError(null)
    try {
      // Receipt first: if it fails nothing is saved, rather than leaving
      // an expense that looks documented and isn't.
      const uploaded = receipt ? await uploadExpenseReceipt(organizationId, receipt) : null
      await saveExpense({
        organizationId,
        propertyId: propertyId || null,
        category,
        spentOn,
        amount: Number(amount),
        payee: payee.trim() || null,
        description: description.trim() || null,
        receiptPath: uploaded ?? existing?.receipt_path ?? null,
        vendorId: vendorId || null,
        paidBy: paidBy || null,
      }, existing?.id)
      // A replaced receipt's old file is no longer referenced.
      if (uploaded && existing?.receipt_path) await removeExpenseReceipt(existing.receipt_path)
      onDone(true)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const hint = categoryInfo(category).hint

  return (
    <form onSubmit={submit} className="card-list" style={{ marginTop: '0.5rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>{existing ? 'Edit expense' : 'Add an expense'}</h3>

        <div className="field">
          <label htmlFor="x-amount">Amount ($)</label>
          <input id="x-amount" type="number" min="0.01" step="0.01" required
            inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="x-category">Category</label>
          <select id="x-category" value={category}
            onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {EXPENSE_CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
          {hint && <span className="muted">{hint}</span>}
        </div>

        <div className="field">
          <label htmlFor="x-property">Which property?</label>
          <select id="x-property" value={propertyId}
            onChange={(e) => setPropertyId(e.target.value)}>
            <option value="">All properties (shared)</option>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.sold_on ? ' (sold)' : ''}</option>
            ))}
          </select>
          {!propertyId && (
            <span className="muted">
              For one bill that covers everything, like a single insurance policy.
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="x-date">Date paid</label>
          <input id="x-date" type="date" required
            value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          {/* Cash basis: an expense counts in the year the money left,
              which is what most small landlords report. */}
          <span className="muted">The day the money left, not the date on the bill.</span>
        </div>

        {vendors.length > 0 && (
          <div className="field">
            <label htmlFor="x-vendor">Vendor (optional)</label>
            <select id="x-vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
              <option value="">None</option>
              {vendors.map((v) => <option key={v.id} value={v.id}>{vendorLabel(v)}</option>)}
            </select>
            <span className="muted">Pick one for contractors, so their 1099 total adds up.</span>
          </div>
        )}

        {!vendorId && (
          <div className="field">
            <label htmlFor="x-payee">Paid to (optional)</label>
            <input id="x-payee" type="text" value={payee}
              placeholder="e.g. State Farm, Campbell County"
              onChange={(e) => setPayee(e.target.value)} />
          </div>
        )}

        <div className="field">
          <label htmlFor="x-paidby">Paid by (optional)</label>
          <select id="x-paidby" value={paidBy} onChange={(e) => setPaidBy(e.target.value)}>
            <option value="">Not recorded</option>
            {PAID_BY.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          {paidBy === 'card' && vendorId && (
            <span className="muted">
              Card payments don't count toward a 1099 — the card company reports them.
            </span>
          )}
        </div>

        <div className="field">
          <label htmlFor="x-desc">Note (optional)</label>
          <input id="x-desc" type="text" value={description}
            onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="x-receipt">
            {existing?.receipt_path ? 'Replace receipt (optional)' : 'Receipt or bill (optional)'}
          </label>
          <input id="x-receipt" type="file"
            // No `capture`, so a bill already saved as a photo or PDF can
            // be picked as well as photographed.
            accept="image/*,application/pdf"
            onChange={(e) => setReceipt(e.target.files?.[0] ?? null)} />
          <span className="muted">Worth keeping: it's what backs up the deduction.</span>
        </div>

        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Save expense'}
        </button>
        <button className="link" type="button" onClick={() => onDone(false)}
          style={{ marginTop: '0.5rem' }} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  )
}
