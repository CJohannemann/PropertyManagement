import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { money } from '../lib/charges'
import { expenseReceiptUrl, removeExpenseReceipt } from '../lib/expenses'
import {
  fetchVendors, fetchVendorTotals, saveVendor, deleteVendor, uploadW9,
  fetchTechnicians, nec1099Threshold, vendorLabel,
  type Vendor, type VendorInput, type VendorTotal,
} from '../lib/finance'

type Props = { organizationId: string; year: number }

/**
 * The people and businesses paid to work on the properties, and who needs
 * a 1099-NEC.
 *
 * A landlord who pays a contractor (not a corporation) past the yearly
 * threshold has to send them a 1099-NEC by January 31 and file it with the
 * IRS. That needs their legal name and tax id, from the W-9 they fill in —
 * so the W-9 is kept here, and only the last four digits are typed in.
 */
export function Vendors({ organizationId, year }: Props) {
  const [vendors, setVendors] = useState<Vendor[] | null>(null)
  const [totals, setTotals] = useState<VendorTotal[]>([])
  const [techs, setTechs] = useState<{ id: string; full_name: string | null }[]>([])
  const [editing, setEditing] = useState<'new' | Vendor | null>(null)
  const [error, setError] = useState<string | null>(null)

  function load() {
    setError(null)
    fetchVendors(organizationId).then(setVendors)
      .catch((e) => { setError(errorMessage(e)); setVendors([]) })
    fetchVendorTotals(organizationId, year).then(setTotals).catch((e) => setError(errorMessage(e)))
  }

  useEffect(load, [organizationId, year])
  useEffect(() => {
    fetchTechnicians(organizationId).then(setTechs).catch(() => setTechs([]))
  }, [organizationId])

  const threshold = nec1099Threshold(year)
  const byId = new Map(totals.map((t) => [t.vendor_id, t]))
  const owed1099 = totals.filter((t) => t.gets_1099 && t.reportable >= threshold)
  const missingW9 = owed1099.filter((t) => !t.has_w9 || !t.has_tin)

  return (
    <div>
      {editing ? (
        <VendorForm
          key={editing === 'new' ? 'new' : editing.id}
          organizationId={organizationId}
          existing={editing === 'new' ? null : editing}
          techs={techs}
          onDone={(saved) => { setEditing(null); if (saved) load() }}
        />
      ) : (
        <button className="primary" onClick={() => setEditing('new')} style={{ marginBottom: '1rem' }}>
          + Add vendor
        </button>
      )}

      <div className="card-list">
        <div>
          <strong>1099-NEC for {year}</strong>
          <div className="muted" style={{ marginTop: '0.25rem' }}>
            Anyone you paid {money(threshold)} or more for work in {year} — not a
            corporation, and not by card — needs a 1099-NEC by January 31, {year + 1}.
          </div>
          {owed1099.length === 0 ? (
            <p style={{ marginBottom: 0 }}>Nobody has reached {money(threshold)} yet.</p>
          ) : (
            <ul style={{ paddingLeft: '1.1rem', marginBottom: 0 }}>
              {owed1099.map((t) => (
                <li key={t.vendor_id}>
                  <strong>{t.name}</strong> — {money(t.reportable)}
                  {(!t.has_w9 || !t.has_tin) && (
                    <span className="error-text"> · {!t.has_w9 ? 'no W-9 on file' : 'no tax id'}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {missingW9.length > 0 && (
            <p className="error-text" style={{ marginBottom: 0 }}>
              Ask for a W-9 before you pay them again — it's much harder in January.
            </p>
          )}
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            The threshold was $600 through 2025 and is $2,000 from 2026, adjusted
            for inflation after that. Counts bills linked to the vendor and a
            linked technician's paid labor; leaves out card payments and
            supplies. Check the list with your accountant.
          </p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}
      {vendors === null && !error && <p className="muted">Loading…</p>}

      {vendors !== null && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Vendors</h3>
          {vendors.length === 0 ? (
            <p className="empty-state">
              No vendors yet. Add the contractors you pay — plumbers,
              electricians, cleaners, handymen — then pick them when adding an
              expense.
            </p>
          ) : (
            <div className="card-list">
              {vendors.map((v) => {
                const t = byId.get(v.id)
                return (
                  <div key={v.id}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                      <strong>{vendorLabel(v)}</strong>
                      <span style={{ whiteSpace: 'nowrap' }}>{money(t?.reportable ?? 0)}</span>
                    </div>
                    <div className="muted">
                      {v.business_name ? `${v.name} · ` : ''}
                      {v.gets_1099 ? 'Gets a 1099' : 'No 1099 (corporation)'}
                      {' · '}{v.w9_path ? 'W-9 on file' : 'no W-9'}
                      {v.tin_last4 ? ` · tax id ••${v.tin_last4}` : ''}
                    </div>
                    {t && t.card_payments > 0 && (
                      <div className="muted">{money(t.card_payments)} paid by card, not counted</div>
                    )}
                    <div style={{ display: 'flex', gap: '1rem', marginTop: '0.25rem' }}>
                      {v.w9_path && <W9Link path={v.w9_path} onError={setError} />}
                      <button className="link" onClick={() => setEditing(v)}>Edit</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function W9Link({ path, onError }: { path: string; onError: (m: string) => void }) {
  return (
    <button className="link" onClick={async () => {
      const w = window.open('', '_blank')
      try {
        const url = await expenseReceiptUrl(path)
        if (url && w) w.location.href = url
        else w?.close()
      } catch (e) {
        w?.close()
        onError(errorMessage(e))
      }
    }}>View W-9</button>
  )
}

function VendorForm({
  organizationId, existing, techs, onDone,
}: {
  organizationId: string
  existing: Vendor | null
  techs: { id: string; full_name: string | null }[]
  onDone: (saved: boolean) => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [business, setBusiness] = useState(existing?.business_name ?? '')
  const [email, setEmail] = useState(existing?.email ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [address, setAddress] = useState(existing?.address ?? '')
  const [last4, setLast4] = useState(existing?.tin_last4 ?? '')
  const [gets1099, setGets1099] = useState(existing?.gets_1099 ?? true)
  const [memberId, setMemberId] = useState(existing?.member_id ?? '')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [w9, setW9] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null)
    try {
      const uploaded = w9 ? await uploadW9(organizationId, w9) : null
      const input: VendorInput = {
        name: name.trim(),
        business_name: business.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        address: address.trim() || null,
        tin_last4: last4.trim() || null,
        w9_path: uploaded ?? existing?.w9_path ?? null,
        gets_1099: gets1099,
        member_id: memberId || null,
        notes: notes.trim() || null,
      }
      await saveVendor(organizationId, input, existing?.id)
      if (uploaded && existing?.w9_path) await removeExpenseReceipt(existing.w9_path)
      onDone(true)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  async function remove() {
    if (!existing || !window.confirm(`Delete ${vendorLabel(existing)}? Their expenses stay, unlinked.`)) return
    setBusy(true)
    try {
      await deleteVendor(existing.id)
      if (existing.w9_path) await removeExpenseReceipt(existing.w9_path)
      onDone(true)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="card-list" style={{ marginBottom: '1.5rem' }}>
      <div>
        <h3 style={{ marginTop: 0 }}>{existing ? 'Edit vendor' : 'Add a vendor'}</h3>
        <div className="field">
          <label htmlFor="v-name">Name</label>
          <input id="v-name" required value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="v-biz">Business name (optional)</label>
          <input id="v-biz" value={business} onChange={(e) => setBusiness(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="v-addr">Mailing address (optional)</label>
          <input id="v-addr" value={address} onChange={(e) => setAddress(e.target.value)}
            placeholder="Where the 1099 gets mailed" />
        </div>
        <div className="field">
          <label htmlFor="v-email">Email (optional)</label>
          <input id="v-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="v-phone">Phone (optional)</label>
          <input id="v-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="v-w9">{existing?.w9_path ? 'Replace W-9 (optional)' : 'W-9 (optional)'}</label>
          <input id="v-w9" type="file" accept="image/*,application/pdf"
            onChange={(e) => setW9(e.target.files?.[0] ?? null)} />
          <span className="muted">The form with their tax id. Kept private, for your accountant.</span>
        </div>
        <div className="field">
          <label htmlFor="v-last4">Last 4 of SSN or EIN (optional)</label>
          <input id="v-last4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4}
            value={last4} onChange={(e) => setLast4(e.target.value.replace(/\D/g, ''))} />
          <span className="muted">Only the last four — the full number stays on the W-9.</span>
        </div>
        <div className="field">
          <span className="muted">Do they get a 1099?</span>
          <div className="seg" role="radiogroup" aria-label="Do they get a 1099?">
            <button type="button" role="radio" aria-checked={gets1099}
              className={gets1099 ? 'seg-item is-current' : 'seg-item'}
              onClick={() => setGets1099(true)}>Yes</button>
            <button type="button" role="radio" aria-checked={!gets1099}
              className={!gets1099 ? 'seg-item is-current' : 'seg-item'}
              onClick={() => setGets1099(false)}>No — a corporation</button>
          </div>
          <span className="muted">
            Individuals, sole proprietors and most LLCs do. The W-9 says which.
          </span>
        </div>
        {techs.length > 0 && (
          <div className="field">
            <label htmlFor="v-member">Technician login (optional)</label>
            <select id="v-member" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
              <option value="">Not one of your technicians</option>
              {techs.map((t) => <option key={t.id} value={t.id}>{t.full_name ?? 'Unnamed technician'}</option>)}
            </select>
            <span className="muted">Their paid labor on repair jobs then counts toward this total.</span>
          </div>
        )}
        <div className="field">
          <label htmlFor="v-notes">Notes (optional)</label>
          <input id="v-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        {error && <p className="error-text">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : existing ? 'Save changes' : 'Add vendor'}
        </button>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
          <button className="link" type="button" onClick={() => onDone(false)} disabled={busy}>
            Cancel
          </button>
          {existing && (
            <button className="link" type="button" onClick={remove} disabled={busy}
              style={{ color: 'var(--danger)' }}>
              Delete vendor
            </button>
          )}
        </div>
      </div>
    </form>
  )
}
