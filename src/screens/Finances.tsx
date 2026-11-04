import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { fetchPropertyRows, type PropertyRow } from '../lib/finance'
import { Expenses } from './Expenses'
import { Reports } from './Reports'
import { TaxPackage } from './TaxPackage'
import { Vendors } from './Vendors'

type Props = { organizationId: string; isAdmin: boolean }

const VIEWS = [
  { value: 'expenses', label: 'Expenses' },
  { value: 'reports', label: 'Reports' },
  { value: 'taxes', label: 'Taxes' },
  { value: 'vendors', label: 'Vendors' },
] as const
type View = (typeof VIEWS)[number]['value']

const VIEW_KEY = 'finances.view'

function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    if (VIEWS.some((x) => x.value === v)) return v as View
  } catch { /* private mode: start on Expenses */ }
  return 'expenses'
}

/**
 * The money side of the business, past rent: what it costs, how each
 * property is doing, what goes to the accountant, and who gets a 1099.
 *
 * One tab with four views rather than four tabs: the nav bar was already
 * at the five a phone fits. The year is shared, since every view answers
 * a question about the same tax year.
 */
export function Finances({ organizationId, isAdmin }: Props) {
  const thisYear = new Date().getFullYear()
  const [view, setView] = useState<View>(savedView)
  const [year, setYear] = useState(thisYear)
  const [properties, setProperties] = useState<PropertyRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchPropertyRows(organizationId).then(setProperties)
      .catch((e) => { setError(errorMessage(e)); setProperties([]) })
  }, [organizationId])

  function choose(v: View) {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* not remembered, fine */ }
  }

  const years = Array.from({ length: 6 }, (_, i) => thisYear - i)

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
        <h2>Finances</h2>
        <select aria-label="Year" value={year} onChange={(e) => setYear(Number(e.target.value))}
          style={{ minHeight: 40, padding: '0.4rem 0.5rem', borderRadius: 8 }}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      </div>

      <div className="seg" role="tablist" aria-label="Finances" style={{ marginBottom: '1.25rem' }}>
        {VIEWS.map((v) => (
          <button key={v.value} type="button" role="tab" aria-selected={view === v.value}
            className={view === v.value ? 'seg-item is-current' : 'seg-item'}
            onClick={() => choose(v.value)}>
            {v.label}
          </button>
        ))}
      </div>

      {error && <p className="error-text">{error}</p>}
      {properties === null ? <p className="muted">Loading…</p> : (
        <>
          {view === 'expenses' && (
            <Expenses organizationId={organizationId} isAdmin={isAdmin}
              year={year} properties={properties} />
          )}
          {view === 'reports' && (
            <Reports organizationId={organizationId} year={year} properties={properties} />
          )}
          {view === 'taxes' && (
            <TaxPackage organizationId={organizationId} year={year} properties={properties} />
          )}
          {view === 'vendors' && <Vendors organizationId={organizationId} year={year} />}
        </>
      )}
    </div>
  )
}
