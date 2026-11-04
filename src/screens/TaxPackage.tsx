import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { money } from '../lib/charges'
import {
  EXPENSE_CATEGORIES, categoryInfo, fetchExpenseLines, expenseReceiptUrl,
  type ExpenseLine,
} from '../lib/expenses'
import {
  fetchIncomeLines, isIncome, INCOME_KIND_LABEL, fetchFinancials, saveFinancials,
  fetchImprovements, addImprovement, deleteImprovement, fetchVendorTotals,
  nec1099Threshold, downloadFile, RECOVERY_CHOICES,
  fetchClosedYears, closeYear, reopenYear, fetchYearChanges, confirmClosedYearChange,
  type IncomeLine, type PropertyFinancials, type Improvement, type PropertyRow,
  type VendorTotal, type ClosedYear, type YearChange,
} from '../lib/finance'
import {
  depreciationForYear, buildingBasis, accumulatedThrough, saleGain, type RecoveryYears,
} from '../lib/depreciation'
import { toCsv, buildZip, safeFileName, type ZipEntry } from '../lib/fileExport'

type Props = { organizationId: string; year: number; properties: PropertyRow[]; isAdmin: boolean }

/** One column of Schedule E: a property, or the shared bills. */
type Column = {
  key: string
  name: string
  rents: number
  byCategory: Map<string, number>
  depreciation: number
  /** Why depreciation is missing, when it is. */
  depreciationNote: string | null
}

const SHARED = 'shared'

function depreciationFor(
  property: PropertyRow, year: number,
  fin: PropertyFinancials | undefined, improvements: Improvement[],
): { amount: number; note: string | null } {
  let amount = 0
  let note: string | null = null
  const basis = fin ? buildingBasis(fin) : 0
  const start = fin?.placed_in_service ?? property.purchase_date
  // Depreciation stops at a sale (038): mid-month in the month it sold.
  const sold = property.sold_on
  if (sold && Number(sold.slice(0, 4)) < year) return { amount: 0, note: null }
  if (basis > 0 && start) {
    amount += depreciationForYear(basis, start, 27.5, year, sold)
  } else {
    note = 'Add the purchase price and land value to estimate depreciation.'
  }
  for (const i of improvements.filter((x) => x.property_id === property.id)) {
    amount += depreciationForYear(i.cost, i.placed_in_service, i.recovery_years, year, sold)
  }
  return { amount: Math.round(amount * 100) / 100, note }
}

function buildColumns(
  properties: PropertyRow[], income: IncomeLine[], expenses: ExpenseLine[],
  financials: PropertyFinancials[], improvements: Improvement[], year: number,
): Column[] {
  const cols: Column[] = properties.map((p) => {
    const d = depreciationFor(p, year, financials.find((f) => f.property_id === p.id), improvements)
    return {
      key: p.id, name: p.sold_on ? `${p.name} (sold ${p.sold_on})` : p.name, rents: 0, byCategory: new Map(),
      depreciation: d.amount, depreciationNote: d.note,
    }
  })
  const shared: Column = {
    key: SHARED, name: 'Shared across properties', rents: 0, byCategory: new Map(),
    depreciation: 0, depreciationNote: null,
  }
  const find = (id: string | null) => (id ? cols.find((c) => c.key === id) : undefined) ?? shared
  for (const l of income.filter(isIncome)) find(l.property_id).rents += l.amount
  for (const e of expenses) {
    const c = find(e.property_id)
    c.byCategory.set(e.category, (c.byCategory.get(e.category) ?? 0) + e.amount)
  }
  // Sold before this year and nothing in it: not a column on this year's return.
  const live = cols.filter((c) => {
    const p = properties.find((x) => x.id === c.key)
    return !(p?.sold_on && Number(p.sold_on.slice(0, 4)) < year
      && c.rents === 0 && c.byCategory.size === 0 && c.depreciation === 0)
  })
  return shared.byCategory.size > 0 ? [...live, shared] : live
}

const totalExpenses = (c: Column) =>
  [...c.byCategory.values()].reduce((s, v) => s + v, 0) + c.depreciation

type Sale = { property: PropertyRow; result: ReturnType<typeof saleGain> | null }

/** Properties sold in `year`, with the gain where the purchase details allow it. */
function salesIn(
  year: number, properties: PropertyRow[], financials: PropertyFinancials[], improvements: Improvement[],
): Sale[] {
  return properties.filter((p) => p.sold_on?.startsWith(String(year))).map((p) => {
    const f = financials.find((x) => x.property_id === p.id)
    const inService = f?.placed_in_service ?? p.purchase_date
    if (!f?.purchase_price || f.sale_price == null || !inService) return { property: p, result: null }
    return {
      property: p,
      result: saleGain({
        salePrice: f.sale_price, sellingCosts: f.selling_costs ?? 0,
        purchasePrice: f.purchase_price, closingCosts: f.closing_costs ?? 0,
        landValue: f.land_value ?? 0, soldOn: p.sold_on!, buildingInService: inService,
        improvements: improvements.filter((i) => i.property_id === p.id)
          .map((i) => ({ cost: i.cost, inService: i.placed_in_service, recoveryYears: i.recovery_years })),
      }),
    }
  })
}

/**
 * The year-end tax package: what goes on Schedule E for each property,
 * and a download to hand the accountant.
 *
 * Cash basis: rent counts in the year it arrived, expenses in the year
 * they were paid. Deposits held are not income; deposit kept is. Every
 * figure is an estimate to check with the accountant — the screen says so
 * rather than looking like a filed return.
 */
export function TaxPackage({ organizationId, year, properties, isAdmin }: Props) {
  const [income, setIncome] = useState<IncomeLine[] | null>(null)
  const [expenses, setExpenses] = useState<ExpenseLine[]>([])
  const [financials, setFinancials] = useState<PropertyFinancials[]>([])
  const [improvements, setImprovements] = useState<Improvement[]>([])
  const [vendorTotals, setVendorTotals] = useState<VendorTotal[]>([])
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [editingProperty, setEditingProperty] = useState<string | null>(null)
  const [closed, setClosed] = useState<ClosedYear | null>(null)
  const [changes, setChanges] = useState<YearChange[]>([])
  const [showChanges, setShowChanges] = useState(false)

  function load() {
    setError(null)
    const from = `${year}-01-01`, to = `${year}-12-31`
    Promise.all([
      fetchIncomeLines(organizationId, from, to),
      fetchExpenseLines(organizationId, from, to),
      fetchFinancials(),
      fetchImprovements(),
      fetchVendorTotals(organizationId, year),
      fetchClosedYears(organizationId),
      fetchYearChanges(organizationId, year),
    ]).then(([i, e, f, im, v, c, ch]) => {
      setIncome(i); setExpenses(e); setFinancials(f); setImprovements(im); setVendorTotals(v)
      setClosed(c.find((x) => x.year === year) ?? null)
      setChanges(ch)
    }).catch((e) => { setError(errorMessage(e)); setIncome([]) })
  }

  useEffect(load, [organizationId, year])

  if (income === null) return error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>

  const columns = buildColumns(properties, income, expenses, financials, improvements, year)
  const totalRents = columns.reduce((s, c) => s + c.rents, 0)
  const totalCosts = columns.reduce((s, c) => s + totalExpenses(c), 0)
  const depositsReceived = income.filter((l) => l.kind === 'deposit_received').reduce((s, l) => s + l.amount, 0)
  const depositsKept = income.filter((l) => l.kind === 'deposit_kept').reduce((s, l) => s + l.amount, 0)
  const online = income.filter((l) => l.method === 'ach' || l.method === 'card')
  const onlineGross = online.reduce((s, l) => s + l.amount + l.processing_fee, 0)
  const onlineFees = online.reduce((s, l) => s + l.processing_fee, 0)
  const threshold = nec1099Threshold(year)
  const owed1099 = vendorTotals.filter((v) => v.gets_1099 && v.reportable >= threshold)
  const sales = salesIn(year, properties, financials, improvements)

  async function toggleClosed() {
    setError(null)
    try {
      if (closed) {
        if (!window.confirm(`Reopen ${year}? Property managers will be able to change it again.`)) return
        await reopenYear(organizationId, year)
      } else {
        if (!window.confirm(
          `Close the books for ${year}?\n\nDo this once your return is filed. Property managers `
          + `won't be able to change ${year} any more; you still can, and every change after `
          + 'closing is listed here for your accountant.',
        )) return
        await closeYear(organizationId, year)
      }
      load()
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  async function download() {
    setProgress('Building your package…')
    try {
      const files = buildPackageFiles(year, columns, income!, expenses, properties,
        financials, improvements, vendorTotals, sales, changes)
      const withReceipts = expenses.filter((e) => e.receipt_path)
      const missed: string[] = []
      const entries: ZipEntry[] = files.map((f) => ({ name: f.name, data: new TextEncoder().encode(f.text) }))
      let n = 0
      for (const e of withReceipts) {
        n++
        setProgress(`Adding receipts… ${n} of ${withReceipts.length}`)
        const ext = e.receipt_path!.split('.').pop() ?? 'jpg'
        const name = `receipts/${safeFileName(`${e.spent_on} ${e.payee ?? categoryInfo(e.category).label} ${e.amount.toFixed(2)} ${e.id.slice(0, 6)}`)}.${ext}`
        try {
          const url = await expenseReceiptUrl(e.receipt_path!)
          const res = url ? await fetch(url) : null
          if (!res?.ok) throw new Error('not found')
          entries.push({ name, data: new Uint8Array(await res.arrayBuffer()) })
        } catch {
          missed.push(`${e.spent_on} ${e.payee ?? ''} ${money(e.amount)}`)
        }
      }
      const readme = readmeText(year, columns, totalRents, totalCosts, depositsReceived,
        depositsKept, onlineGross, onlineFees, owed1099, threshold, missed, sales, closed, changes)
      entries.unshift({ name: 'README.txt', data: new TextEncoder().encode(readme) })
      downloadFile(`rental-tax-package-${year}.zip`, buildZip(entries), 'application/zip')
      setProgress(missed.length
        ? `Downloaded. ${missed.length} receipt(s) couldn't be fetched — listed in README.txt.`
        : 'Downloaded.')
    } catch (e) {
      setProgress(null)
      setError(errorMessage(e))
    }
  }

  return (
    <div className="tax-package">
      <div className="card-list" style={{ marginBottom: '1rem' }}>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'baseline' }}>
            <strong>{closed ? `🔒 ${year} is closed` : `${year} is open`}</strong>
            {isAdmin && (
              <button className="link no-print" onClick={toggleClosed}>
                {closed ? 'Reopen' : `Close ${year}`}
              </button>
            )}
          </div>
          <div className="muted">
            {closed
              ? `Closed ${new Date(closed.closed_at).toLocaleDateString('en-US')}. `
                + (isAdmin ? 'You can still make changes; each is listed below.' : 'Only an admin can change it.')
              : 'Close the year once your return is filed, so the numbers stop moving.'}
          </div>
          {closed && (
            changes.length === 0
              ? <div className="muted">Nothing has changed since.</div>
              : (
                <>
                  <button className="link" onClick={() => setShowChanges((v) => !v)}>
                    {changes.length} change(s) since closing {showChanges ? '▴' : '▾'}
                  </button>
                  {showChanges && (
                    <ul style={{ paddingLeft: '1.1rem', marginBottom: 0, fontSize: '0.9rem' }}>
                      {changes.map((c) => (
                        <li key={c.id}>
                          {c.summary}
                          <span className="muted">
                            {' · '}{new Date(c.changed_at).toLocaleDateString('en-US')}
                            {c.changed_by ? '' : ' · by Stripe / the bank'}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )
          )}
        </div>
      </div>

      <div className="card-list">
        <div>
          <strong>{year} at a glance</strong>
          <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse' }}>
            <tbody>
              <SumRow label="Rental income" value={totalRents} />
              <SumRow label="Expenses, including depreciation" value={-totalCosts} />
              <SumRow label="Net" value={totalRents - totalCosts} strong />
            </tbody>
          </table>
          <div className="no-print" style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginTop: '1rem' }}>
            <button className="primary" onClick={download} disabled={!!progress && progress.endsWith('…')}
              style={{ flex: '1 1 12rem' }}>
              Download for your accountant (.zip)
            </button>
            <button className="link" onClick={() => window.print()}>Print this page</button>
          </div>
          {progress && <p className="muted" style={{ marginBottom: 0 }}>{progress}</p>}
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            The download has spreadsheets of income, expenses, Schedule E by
            property, depreciation and 1099s, plus every receipt. These are
            estimates from what's in the app, on a cash basis — your accountant
            confirms them.
          </p>
        </div>
      </div>

      {error && <p className="error-text">{error}</p>}

      <h3 style={{ marginTop: '2rem' }}>Schedule E by property</h3>
      {columns.map((c) => (
        <div key={c.key} className="card-list" style={{ marginBottom: '1rem' }}>
          <div>
            <strong>{c.name}</strong>
            <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
              <tbody>
                {c.key !== SHARED && <LineRow line="3" label="Rents received" value={c.rents} />}
                {EXPENSE_CATEGORIES.filter((cat) => c.byCategory.get(cat.value))
                  .map((cat) => (
                    <LineRow key={cat.value} line={String(cat.line)} label={cat.label}
                      value={c.byCategory.get(cat.value)!} />
                  ))}
                {c.key !== SHARED && (
                  <LineRow line="18" label="Depreciation (estimate)" value={c.depreciation} />
                )}
                <LineRow line="20" label="Total expenses" value={totalExpenses(c)} strong />
                {c.key !== SHARED && (
                  <LineRow line="21" label="Net" value={c.rents - totalExpenses(c)} strong />
                )}
              </tbody>
            </table>
            {c.key === SHARED && (
              <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
                Bills that cover every property. Schedule E needs them split
                between properties — usually by rent or by number of units. Your
                accountant decides how.
              </p>
            )}
            {c.depreciationNote && (
              <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 0 }}>{c.depreciationNote}</p>
            )}
            {c.key !== SHARED && (
              <button className="link no-print" style={{ marginTop: '0.5rem' }}
                onClick={() => setEditingProperty(editingProperty === c.key ? null : c.key)}>
                {editingProperty === c.key ? 'Close purchase details' : 'Purchase details and improvements'}
              </button>
            )}
            {editingProperty === c.key && (
              <PurchaseDetails
                closedYears={isAdmin && closed ? [year] : []}
                property={properties.find((p) => p.id === c.key)!}
                financials={financials.find((f) => f.property_id === c.key)}
                improvements={improvements.filter((i) => i.property_id === c.key)}
                year={year}
                onChanged={load}
              />
            )}
          </div>
        </div>
      ))}

      {sales.length > 0 && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Property sold in {year}</h3>
          {sales.map(({ property, result }) => (
            <div key={property.id} className="card-list" style={{ marginBottom: '1rem' }}>
              <div>
                <strong>{property.name} · sold {property.sold_on}</strong>
                {!result ? (
                  <p className="muted" style={{ marginBottom: 0 }}>
                    Add the purchase price, land value and sale price (under
                    "Purchase details") to estimate the gain.
                  </p>
                ) : (
                  <>
                    <table style={{ width: '100%', marginTop: '0.5rem', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                      <tbody>
                        <SumRow label="Sale price less selling costs" value={result.realized} />
                        <SumRow label="Depreciation taken (estimate)" value={result.depreciation} />
                        <SumRow label="Adjusted basis" value={result.adjustedBasis} />
                        <SumRow label={result.gain >= 0 ? 'Gain' : 'Loss'} value={result.gain} strong />
                        {result.unrecaptured1250 > 0 && (
                          <SumRow label="of which depreciation recapture (§1250, up to 25%)" value={result.unrecaptured1250} />
                        )}
                        {result.recapture1245 > 0 && (
                          <SumRow label="of which ordinary income (§1245, appliances etc.)" value={result.recapture1245} />
                        )}
                        {result.capitalGain > 0 && (
                          <SumRow label="of which capital gain" value={result.capitalGain} />
                        )}
                      </tbody>
                    </table>
                    <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
                      Reported on Form 4797, not Schedule E. The recapture part is
                      taxed at a higher rate than the rest of the gain. Uses this
                      app's depreciation estimate; your accountant uses what was
                      actually claimed. A 1031 exchange would defer all of it.
                    </p>
                  </>
                )}
              </div>
            </div>
          ))}
        </>
      )}

      <h3 style={{ marginTop: '2rem' }}>Deposits</h3>
      <div className="card-list">
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <SumRow label="Received in deposits (held — not income)" value={depositsReceived} />
              <SumRow label="Kept at move-out (counted as income above)" value={depositsKept} />
            </tbody>
          </table>
        </div>
      </div>

      {onlineGross > 0 && (
        <>
          <h3 style={{ marginTop: '2rem' }}>Stripe's 1099-K</h3>
          <div className="card-list">
            <div>
              <p style={{ marginTop: 0 }}>
                Stripe reports online payments to the IRS on a 1099-K. Expect it
                to show about <strong>{money(onlineGross)}</strong> for {year}.
              </p>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  <SumRow label="Rent and deposits paid online" value={onlineGross - onlineFees} />
                  <SumRow label="Processing fees tenants paid on top" value={onlineFees} />
                </tbody>
              </table>
              <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
                The fees went straight back to Stripe, so they aren't rental
                income — but the 1099-K includes them, and so does the deposit
                money. Stripe's own fees are in your Stripe dashboard.
              </p>
            </div>
          </div>
        </>
      )}

      <h3 style={{ marginTop: '2rem' }}>1099-NEC</h3>
      <div className="card-list">
        <div>
          {owed1099.length === 0
            ? <p style={{ margin: 0 }}>Nobody you paid reached {money(threshold)} in {year}.</p>
            : (
              <ul style={{ paddingLeft: '1.1rem', margin: 0 }}>
                {owed1099.map((v) => (
                  <li key={v.vendor_id}>
                    {v.name} — {money(v.reportable)}
                    {!v.has_w9 && <span className="error-text"> · no W-9</span>}
                  </li>
                ))}
              </ul>
            )}
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            Due to them and the IRS by January 31, {year + 1}. Details on the Vendors view.
          </p>
        </div>
      </div>
    </div>
  )
}

function SumRow({ label, value, strong }: { label: string; value: number; strong?: boolean }) {
  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td style={{ padding: '0.35rem 0', fontWeight: strong ? 600 : 400 }}>{label}</td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 600 : 400 }}>
        {money(value)}
      </td>
    </tr>
  )
}

function LineRow({ line, label, value, strong }: { line: string; label: string; value: number; strong?: boolean }) {
  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td className="muted" style={{ width: '2.2rem', fontSize: '0.8rem' }}>{line}</td>
      <td style={{ padding: '0.35rem 0', fontWeight: strong ? 600 : 400 }}>{label}</td>
      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: strong ? 600 : 400 }}>
        {money(value)}
      </td>
    </tr>
  )
}

/** Purchase price, land value and improvements: what depreciation needs. */
function PurchaseDetails({
  property, financials, improvements, year, onChanged, closedYears,
}: {
  closedYears: number[]
  property: PropertyRow
  financials: PropertyFinancials | undefined
  improvements: Improvement[]
  year: number
  onChanged: () => void
}) {
  const s = (n: number | null | undefined) => (n == null ? '' : String(n))
  const [price, setPrice] = useState(s(financials?.purchase_price))
  const [closing, setClosing] = useState(s(financials?.closing_costs))
  const [land, setLand] = useState(s(financials?.land_value))
  const [inService, setInService] = useState(financials?.placed_in_service ?? property.purchase_date ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const [desc, setDesc] = useState('')
  const [cost, setCost] = useState('')
  const [when, setWhen] = useState('')
  const [life, setLife] = useState<RecoveryYears>(27.5)

  const n = (v: string) => (v.trim() === '' ? null : Number(v))
  const basis = buildingBasis({ purchase_price: n(price), closing_costs: n(closing), land_value: n(land) })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true); setError(null); setSaved(false)
    try {
      await saveFinancials({
        property_id: property.id,
        purchase_price: n(price), closing_costs: n(closing), land_value: n(land),
        placed_in_service: inService || null,
      })
      setSaved(true)
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  async function addImp(e: React.FormEvent) {
    e.preventDefault()
    const y = Number(when.slice(0, 4))
    if (closedYears.includes(y) && !confirmClosedYearChange(y)) return
    setBusy(true); setError(null)
    try {
      await addImprovement({
        property_id: property.id, description: desc.trim(), cost: Number(cost),
        placed_in_service: when, recovery_years: life,
      })
      setDesc(''); setCost(''); setWhen('')
      onChanged()
    } catch (err) {
      setError(errorMessage(err))
    }
    setBusy(false)
  }

  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--line)', paddingTop: '0.75rem' }}>
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor={`pp-${property.id}`}>Purchase price ($)</label>
          <input id={`pp-${property.id}`} type="number" min="0" step="0.01" inputMode="decimal"
            value={price} onChange={(e) => setPrice(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`cc-${property.id}`}>Closing costs added to the price ($, optional)</label>
          <input id={`cc-${property.id}`} type="number" min="0" step="0.01" inputMode="decimal"
            value={closing} onChange={(e) => setClosing(e.target.value)} />
          <span className="muted">Title, recording, transfer tax — from the closing statement.</span>
        </div>
        <div className="field">
          <label htmlFor={`lv-${property.id}`}>Land value ($)</label>
          <input id={`lv-${property.id}`} type="number" min="0" step="0.01" inputMode="decimal"
            value={land} onChange={(e) => setLand(e.target.value)} />
          <span className="muted">
            Land isn't depreciated. The county assessor's land/building split is the usual source.
          </span>
        </div>
        <div className="field">
          <label htmlFor={`pis-${property.id}`}>First ready to rent</label>
          <input id={`pis-${property.id}`} type="date" value={inService}
            onChange={(e) => setInService(e.target.value)} />
        </div>
        {basis > 0 && inService && (
          <p className="muted" style={{ fontSize: '0.85rem' }}>
            Depreciable basis {money(basis)} over 27.5 years: about{' '}
            {money(depreciationForYear(basis, inService, 27.5, year, property.sold_on))} for {year},
            {' '}{money(accumulatedThrough(basis, inService, 27.5, year, property.sold_on))} through {year}.
          </p>
        )}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : saved ? 'Saved' : 'Save purchase details'}
        </button>
      </form>

      <h4 style={{ marginBottom: '0.5rem' }}>Improvements</h4>
      <p className="muted" style={{ marginTop: 0, fontSize: '0.85rem' }}>
        Big one-off upgrades that last years — a roof, a furnace, new
        appliances — are depreciated rather than deducted as repairs.
      </p>
      {improvements.map((i) => (
        <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', padding: '0.3rem 0', borderTop: '1px solid var(--line)' }}>
          <span>
            {i.description}
            <span className="muted"> · {i.placed_in_service} · {i.recovery_years} yr · {money(depreciationForYear(i.cost, i.placed_in_service, i.recovery_years, year, property.sold_on))} in {year}</span>
          </span>
          <span style={{ whiteSpace: 'nowrap' }}>
            {money(i.cost)}{' '}
            <button className="link" aria-label={`Remove ${i.description}`} style={{ color: 'var(--danger)' }}
              onClick={async () => {
                const y = Number(i.placed_in_service.slice(0, 4))
                if (closedYears.includes(y) ? !confirmClosedYearChange(y) : !window.confirm(`Remove ${i.description}?`)) return
                try { await deleteImprovement(i.id); onChanged() } catch (err) { setError(errorMessage(err)) }
              }}>×</button>
          </span>
        </div>
      ))}
      <form onSubmit={addImp} style={{ marginTop: '0.75rem' }}>
        <div className="field">
          <label htmlFor={`imp-d-${property.id}`}>What was it?</label>
          <input id={`imp-d-${property.id}`} required value={desc} onChange={(e) => setDesc(e.target.value)}
            placeholder="e.g. New roof" />
        </div>
        <div className="field">
          <label htmlFor={`imp-c-${property.id}`}>Cost ($)</label>
          <input id={`imp-c-${property.id}`} type="number" min="0.01" step="0.01" required inputMode="decimal"
            value={cost} onChange={(e) => setCost(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`imp-w-${property.id}`}>In use from</label>
          <input id={`imp-w-${property.id}`} type="date" required value={when} onChange={(e) => setWhen(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`imp-l-${property.id}`}>Kind</label>
          <select id={`imp-l-${property.id}`} value={life}
            onChange={(e) => setLife(Number(e.target.value) as RecoveryYears)}>
            {RECOVERY_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <button className="link" type="submit" disabled={busy}>+ Add improvement</button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  )
}

// --------------------------------------------------------- the download --

function buildPackageFiles(
  year: number, columns: Column[], income: IncomeLine[], expenses: ExpenseLine[],
  properties: PropertyRow[], financials: PropertyFinancials[], improvements: Improvement[],
  vendorTotals: VendorTotal[], sales: Sale[], changes: YearChange[],
): { name: string; text: string }[] {
  const r2 = (n: number) => Math.round(n * 100) / 100

  // Schedule E: one row per line, one column per property, as on the form.
  const header = ['Line', 'Item', ...columns.map((c) => c.name), 'Total']
  const row = (line: string, item: string, f: (c: Column) => number) => {
    const vals = columns.map((c) => r2(f(c)))
    return [line, item, ...vals, r2(vals.reduce((s, v) => s + v, 0))]
  }
  const schedule = [
    row('3', 'Rents received', (c) => c.rents),
    ...EXPENSE_CATEGORIES.map((cat) =>
      row(String(cat.line), cat.label, (c) => c.byCategory.get(cat.value) ?? 0)),
    row('18', 'Depreciation (estimate)', (c) => c.depreciation),
    row('20', 'Total expenses', totalExpenses),
    row('21', 'Net', (c) => c.rents - totalExpenses(c)),
  ].sort((a, b) => Number(a[0]) - Number(b[0]))

  const incomeCsv = toCsv(
    ['Date received', 'Kind', 'Counts as income', 'Charge', 'Property', 'Unit', 'Tenant', 'Method', 'Amount', 'Processing fee paid by tenant', 'Note'],
    income.map((l) => [l.received_on, INCOME_KIND_LABEL[l.kind], isIncome(l) ? 'yes' : 'no (held)',
      l.charge_type ?? '', l.property_name, l.unit_label ?? '', l.tenant_name ?? '', l.method ?? '',
      l.amount, l.processing_fee, l.note ?? '']),
  )
  const expensesCsv = toCsv(
    ['Date paid', 'Schedule E line', 'Category', 'Property', 'Paid to', 'Note', 'Amount', 'Paid by', 'Source', 'Has receipt'],
    expenses.map((e) => {
      const c = categoryInfo(e.category)
      return [e.spent_on, c.line, c.label, e.property_name ?? 'Shared', e.payee ?? '', e.description ?? '',
        e.amount, e.paid_by ?? '', e.source === 'job' ? 'Repair job' : 'Entered', e.receipt_path ? 'yes' : 'no']
    }),
  )
  const depRows: unknown[][] = []
  for (const p of properties) {
    const f = financials.find((x) => x.property_id === p.id)
    const basis = f ? buildingBasis(f) : 0
    const start = f?.placed_in_service ?? p.purchase_date
    if (p.sold_on && Number(p.sold_on.slice(0, 4)) < year) continue
    if (basis > 0 && start) {
      depRows.push([p.name, 'Building', start, f?.purchase_price ?? '', f?.land_value ?? '', basis, 27.5,
        depreciationForYear(basis, start, 27.5, year, p.sold_on),
        accumulatedThrough(basis, start, 27.5, year, p.sold_on)])
    } else {
      depRows.push([p.name, 'Building', start ?? '', f?.purchase_price ?? '', f?.land_value ?? '', '', 27.5,
        'missing purchase details', ''])
    }
    for (const i of improvements.filter((x) => x.property_id === p.id)) {
      depRows.push([p.name, i.description, i.placed_in_service, i.cost, '', i.cost, i.recovery_years,
        depreciationForYear(i.cost, i.placed_in_service, i.recovery_years, year, p.sold_on),
        accumulatedThrough(i.cost, i.placed_in_service, i.recovery_years, year, p.sold_on)])
    }
  }
  const depCsv = toCsv(
    ['Property', 'Asset', 'In service', 'Cost / price', 'Land value', 'Depreciable basis', 'Years', `Depreciation ${year}`, `Accumulated through ${year}`],
    depRows,
  )
  const threshold = nec1099Threshold(year)
  const vendorCsv = toCsv(
    ['Vendor', 'Gets a 1099', `Paid in ${year} (reportable)`, 'From bills', 'From repair-job labor', 'Paid by card (not counted)', `Over ${threshold}`, 'W-9 on file', 'Tax id last 4 on file'],
    vendorTotals.map((v) => [v.name, v.gets_1099 ? 'yes' : 'no', v.reportable, v.from_expenses, v.from_jobs,
      v.card_payments, v.gets_1099 && v.reportable >= threshold ? 'YES' : 'no', v.has_w9 ? 'yes' : 'no', v.has_tin ? 'yes' : 'no']),
  )

  const files = [
    { name: `schedule-e-${year}.csv`, text: toCsv(header, schedule) },
    { name: `income-${year}.csv`, text: incomeCsv },
    { name: `expenses-${year}.csv`, text: expensesCsv },
    { name: `depreciation-${year}.csv`, text: depCsv },
    { name: `1099-vendors-${year}.csv`, text: vendorCsv },
  ]
  if (sales.length) {
    files.push({
      name: `property-sales-${year}.csv`,
      text: toCsv(
        ['Property', 'Sold on', 'Amount realized', 'Depreciation taken (estimate)', 'Adjusted basis',
          'Gain or loss', 'Unrecaptured 1250 gain', '1245 recapture', 'Capital gain'],
        sales.map(({ property, result }) => result
          ? [property.name, property.sold_on, result.realized, result.depreciation, result.adjustedBasis,
              result.gain, result.unrecaptured1250, result.recapture1245, result.capitalGain]
          : [property.name, property.sold_on, 'missing purchase or sale details', '', '', '', '', '', '']),
      ),
    })
  }
  if (changes.length) {
    files.push({
      name: `changes-after-closing-${year}.csv`,
      text: toCsv(['When', 'By', 'What'], changes.map((c) => [
        c.changed_at, c.changed_by ? 'a user' : 'Stripe / the bank', c.summary])),
    })
  }
  return files
}

function readmeText(
  year: number, columns: Column[], rents: number, costs: number,
  depositsReceived: number, depositsKept: number, onlineGross: number, onlineFees: number,
  owed1099: VendorTotal[], threshold: number, missed: string[],
  sales: Sale[], closed: ClosedYear | null, changes: YearChange[],
): string {
  const m = (n: number) => money(n)
  const lines = [
    `RENTAL TAX PACKAGE — ${year}`,
    `Generated ${new Date().toLocaleString('en-US')}`,
    '',
    'Cash basis: income counted when received, expenses when paid.',
    'These are estimates from the property management app. Please review.',
    '',
    `Rental income (Schedule E line 3):     ${m(rents)}`,
    `Expenses incl. estimated depreciation: ${m(costs)}`,
    `Net:                                   ${m(rents - costs)}`,
    '',
    'BY PROPERTY',
    ...columns.map((c) => `  ${c.name}: income ${m(c.rents)}, expenses ${m(totalExpenses(c))}`
      + (c.key === SHARED ? ' (shared — needs splitting between properties)' : `, net ${m(c.rents - totalExpenses(c))}`)
      + (c.depreciationNote ? ' — depreciation missing: no purchase details' : '')),
    '',
    ...(closed ? [`BOOKS CLOSED ${closed.closed_at.slice(0, 10)}`
      + (changes.length ? ` — ${changes.length} change(s) since; see changes-after-closing-${year}.csv` : ' — no changes since'), ''] : []),
    ...(sales.length ? ['PROPERTY SOLD (Form 4797, not Schedule E)', ...sales.map(({ property, result }) => result
      ? `  ${property.name}, sold ${property.sold_on}: ${result.gain >= 0 ? 'gain' : 'loss'} ${m(result.gain)}`
        + ` (depreciation recapture ${m(result.unrecaptured1250 + result.recapture1245)}) — see property-sales-${year}.csv`
      : `  ${property.name}, sold ${property.sold_on}: purchase or sale details missing`), ''] : []),
    'DEPOSITS',
    `  Received and held (not income): ${m(depositsReceived)}`,
    `  Kept at move-out (included in income): ${m(depositsKept)}`,
    '',
  ]
  if (onlineGross > 0) {
    lines.push('STRIPE 1099-K',
      `  Online payments, gross: ${m(onlineGross)} (includes ${m(onlineFees)} of processing fees tenants paid,`,
      '  which went to Stripe, and any deposits paid online). Stripe\'s fees are in the Stripe dashboard.', '')
  }
  lines.push(`1099-NEC (paid ${m(threshold)} or more, not a corporation, not by card)`,
    ...(owed1099.length ? owed1099.map((v) => `  ${v.name}: ${m(v.reportable)}${v.has_w9 ? '' : ' — NO W-9 ON FILE'}`) : ['  None.']),
    '',
    'FILES',
    `  schedule-e-${year}.csv     one column per property, one row per Schedule E line`,
    `  income-${year}.csv         every payment received, and whether it counts as income`,
    `  expenses-${year}.csv       every expense, including costs logged on repair jobs`,
    `  depreciation-${year}.csv   building and improvements, estimated (MACRS, no bonus/179)`,
    `  1099-vendors-${year}.csv   yearly totals per vendor`,
    '  receipts/                 receipts and bills attached to expenses',
  )
  if (missed.length) {
    lines.push('', 'RECEIPTS THAT COULD NOT BE DOWNLOADED', ...missed.map((s) => `  ${s}`))
  }
  return lines.join('\r\n') + '\r\n'
}
