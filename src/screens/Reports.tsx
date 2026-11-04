import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { money, fetchCharges, outstanding, type ChargeWithPlace } from '../lib/charges'
import { fetchExpenseLines, type ExpenseLine } from '../lib/expenses'
import {
  fetchIncomeLines, isIncome, fetchFinancials, fetchImprovements,
  type IncomeLine, type PropertyFinancials, type Improvement, type PropertyRow,
} from '../lib/finance'

type Props = { organizationId: string; year: number; properties: PropertyRow[] }

type LeaseRow = {
  id: string
  rent_amount: number
  start_date: string
  end_date: string | null
  ended_on: string | null
  status: 'pending' | 'active' | 'ended'
  unit_id: string
  units: { id: string; label: string; property_id: string } | null
  lease_tenants: { org_members: { full_name: string | null } | null }[]
}

type JobRow = {
  id: string
  property_id: string
  status: string
  completed_date: string | null
  created_at: string
  maintenance_requests: { created_at: string } | null
}

/** Interest is financing, not running the building: left out of NOI. */
const FINANCING = new Set(['mortgage_interest', 'other_interest'])

const DAY = 86_400_000
const isoDay = (d: Date) => d.toISOString().slice(0, 10)
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)

/**
 * How the business is doing, for an owner: profit by property, where the
 * money comes and goes by month, who pays late, what sits empty, and what
 * repairs cost.
 *
 * Everything the Rent tab already answers (this month's collections,
 * what's overdue right now) is left there; this is the year-long view.
 */
export function Reports({ organizationId, year, properties }: Props) {
  const [income, setIncome] = useState<IncomeLine[] | null>(null)
  const [expenses, setExpenses] = useState<ExpenseLine[]>([])
  const [charges, setCharges] = useState<ChargeWithPlace[]>([])
  const [leases, setLeases] = useState<LeaseRow[]>([])
  const [jobs, setJobs] = useState<JobRow[]>([])
  const [financials, setFinancials] = useState<PropertyFinancials[]>([])
  const [improvements, setImprovements] = useState<Improvement[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setIncome(null); setError(null)
    const from = `${year}-01-01`, to = `${year}-12-31`
    Promise.all([
      fetchIncomeLines(organizationId, from, to),
      fetchExpenseLines(organizationId, from, to),
      fetchCharges(),
      supabase?.from('leases')
        .select('id, rent_amount, start_date, end_date, ended_on, status, unit_id, units(id, label, property_id), lease_tenants(org_members(full_name))')
        .in('status', ['active', 'ended']) ?? Promise.resolve({ data: [], error: null }),
      supabase?.from('maintenance_jobs')
        .select('id, property_id, status, completed_date, created_at, maintenance_requests(created_at)')
        .eq('organization_id', organizationId) ?? Promise.resolve({ data: [], error: null }),
      fetchFinancials(),
      fetchImprovements(),
    ]).then(([i, e, c, l, j, f, im]) => {
      if (l.error) throw l.error
      if (j.error) throw j.error
      setIncome(i); setExpenses(e); setCharges(c)
      setLeases(((l.data ?? []) as unknown as LeaseRow[]).map((x) => ({ ...x, rent_amount: Number(x.rent_amount) })))
      setJobs((j.data ?? []) as unknown as JobRow[])
      setFinancials(f); setImprovements(im)
    }).catch((e) => { setError(errorMessage(e)); setIncome([]) })
  }, [organizationId, year])

  if (income === null) return <p className="muted">Loading…</p>

  const today = isoDay(new Date())
  const yearEnd = `${year}-12-31`
  // A year in progress is measured up to today, not to December.
  const periodEnd = today < yearEnd ? today : yearEnd
  const periodStart = `${year}-01-01`
  const periodDays = Math.max(1, days(periodStart, periodEnd) + 1)

  // ------------------------------------------------ profit by property --
  const rows = properties.map((p) => {
    const inc = income.filter((l) => isIncome(l) && l.property_id === p.id).reduce((s, l) => s + l.amount, 0)
    const own = expenses.filter((e) => e.property_id === p.id)
    const opex = own.filter((e) => !FINANCING.has(e.category)).reduce((s, e) => s + e.amount, 0)
    const interest = own.filter((e) => FINANCING.has(e.category)).reduce((s, e) => s + e.amount, 0)
    const fin = financials.find((f) => f.property_id === p.id)
    const invested = fin?.purchase_price
      ? fin.purchase_price + (fin.closing_costs ?? 0)
        + improvements.filter((i) => i.property_id === p.id).reduce((s, i) => s + i.cost, 0)
      : null
    const noi = inc - opex
    return { p, inc, opex, interest, noi, cashFlow: noi - interest, invested }
  // A building sold before this year, with nothing in it, is history only.
  }).filter((r) => !(r.p.sold_on && r.p.sold_on < periodStart && r.inc === 0 && r.opex === 0 && r.interest === 0))
  const shared = expenses.filter((e) => !e.property_id)
  const sharedOpex = shared.filter((e) => !FINANCING.has(e.category)).reduce((s, e) => s + e.amount, 0)
  const sharedInterest = shared.filter((e) => FINANCING.has(e.category)).reduce((s, e) => s + e.amount, 0)
  const totalInc = rows.reduce((s, r) => s + r.inc, 0)
  const totalOpex = rows.reduce((s, r) => s + r.opex, 0) + sharedOpex
  const totalInterest = rows.reduce((s, r) => s + r.interest, 0) + sharedInterest

  // ---------------------------------------------------------- by month --
  const months = Array.from({ length: 12 }, (_, m) => {
    const key = `${year}-${String(m + 1).padStart(2, '0')}`
    const inc = income.filter((l) => isIncome(l) && l.received_on.startsWith(key)).reduce((s, l) => s + l.amount, 0)
    const out = expenses.filter((e) => e.spent_on.startsWith(key)).reduce((s, e) => s + e.amount, 0)
    return { key, label: new Date(year, m, 1).toLocaleString('en-US', { month: 'short' }), inc, out }
  }).filter((m) => m.key <= periodEnd.slice(0, 7))

  // ------------------------------------------------- what's owed, aged --
  const buckets = [
    { label: 'Not due yet', min: -Infinity, max: 0, amount: 0 },
    { label: '1–30 days late', min: 1, max: 30, amount: 0 },
    { label: '31–60 days', min: 31, max: 60, amount: 0 },
    { label: '61–90 days', min: 61, max: 90, amount: 0 },
    { label: 'Over 90 days', min: 91, max: Infinity, amount: 0 },
  ]
  for (const c of charges) {
    const owed = outstanding(c)
    if (owed <= 0) continue
    const late = days(c.due_date, today)
    buckets.find((b) => late >= b.min && late <= b.max)!.amount += owed
  }

  // ----------------------------------------------------- who pays late --
  const lateness = new Map<string, { name: string; total: number; n: number }>()
  for (const c of charges) {
    if (c.charge_type !== 'rent') continue
    for (const pay of c.payments ?? []) {
      if (pay.status !== 'succeeded' || !pay.paid_at || !pay.paid_at.startsWith(String(year))) continue
      const tenant = c.leases?.lease_tenants?.[0]?.org_members?.full_name ?? 'Unnamed tenant'
      const unit = c.leases?.units ? `${c.leases.units.properties.name} · ${c.leases.units.label}` : ''
      const key = c.lease_id
      const cur = lateness.get(key) ?? { name: `${tenant}${unit ? ` (${unit})` : ''}`, total: 0, n: 0 }
      cur.total += Math.max(0, days(c.due_date, pay.paid_at.slice(0, 10)))
      cur.n++
      lateness.set(key, cur)
    }
  }
  const latePayers = [...lateness.values()].map((v) => ({ name: v.name, avg: v.total / v.n, n: v.n }))
    .sort((a, b) => b.avg - a.avg)

  // ------------------------------------------------- occupancy & roll --
  // Each property counts until it was sold: a building sold in June is
  // measured to June, and one sold before this year not at all.
  const ownedUntil = new Map(properties.map((p) => [
    p.id, p.sold_on && p.sold_on < periodEnd ? p.sold_on : periodEnd,
  ]))
  const ownedDays = (propertyId: string) => {
    const end = ownedUntil.get(propertyId) ?? periodEnd
    return end < periodStart ? 0 : days(periodStart, end) + 1
  }
  const ownedUnits = properties.filter((p) => ownedDays(p.id) > 0)
  const totalUnitDays = ownedUnits.reduce((s, p) => s + p.unitCount * ownedDays(p.id), 0)
  let leasedDays = 0
  let lostRent = 0
  const leasesByUnit = new Map<string, LeaseRow[]>()
  for (const l of leases) {
    if (!l.units || ownedDays(l.units.property_id) === 0) continue
    if (!leasesByUnit.has(l.unit_id)) leasesByUnit.set(l.unit_id, [])
    leasesByUnit.get(l.unit_id)!.push(l)
  }
  for (const [, ls] of leasesByUnit) {
    const propertyId = ls[0].units!.property_id
    const unitEnd = ownedUntil.get(propertyId) ?? periodEnd
    const unitDays = ownedDays(propertyId)
    let covered = 0
    for (const l of ls) {
      const end = (l.status === 'ended' ? l.ended_on ?? l.end_date : l.end_date) ?? unitEnd
      const s = l.start_date > periodStart ? l.start_date : periodStart
      const e = end < unitEnd ? end : unitEnd
      if (e >= s) covered += days(s, e) + 1
    }
    covered = Math.min(covered, unitDays)
    leasedDays += covered
    // Lost rent at the unit's most recent rent, for the days it sat empty.
    const latest = [...ls].sort((a, b) => b.start_date.localeCompare(a.start_date))[0]
    lostRent += (unitDays - covered) * latest.rent_amount * 12 / 365
  }
  const totalUnits = ownedUnits.reduce((s, p) => s + p.unitCount, 0)
  const neverLeased = Math.max(0, totalUnits - leasesByUnit.size)
  const occupancy = totalUnitDays > 0 ? leasedDays / totalUnitDays : null

  const active = leases.filter((l) => l.status === 'active')
    .sort((a, b) => (propertyName(properties, a) + (a.units?.label ?? ''))
      .localeCompare(propertyName(properties, b) + (b.units?.label ?? '')))
  const balanceByLease = new Map<string, number>()
  for (const c of charges) balanceByLease.set(c.lease_id, (balanceByLease.get(c.lease_id) ?? 0) + outstanding(c))
  const soon = new Date(Date.now() + 90 * DAY).toISOString().slice(0, 10)

  // ------------------------------------------------------- maintenance --
  const repairsByProperty = properties.map((p) => {
    const spend = expenses.filter((e) => e.property_id === p.id && (e.category === 'repairs' || e.category === 'cleaning_maintenance'))
      .reduce((s, e) => s + e.amount, 0)
    const done = jobs.filter((j) => j.property_id === p.id && j.completed_date?.startsWith(String(year)))
    const turnaround = done.map((j) => days((j.maintenance_requests?.created_at ?? j.created_at).slice(0, 10), j.completed_date!))
    const avg = turnaround.length ? turnaround.reduce((s, d) => s + d, 0) / turnaround.length : null
    return { p, spend, jobs: done.length, avg, perUnit: p.unitCount ? spend / p.unitCount : null }
  }).filter((r) => !(r.p.sold_on && r.p.sold_on < periodStart && r.spend === 0 && r.jobs === 0))

  const pct = (n: number) => `${Math.round(n * 100)}%`

  return (
    <div>
      {error && <p className="error-text">{error}</p>}
      {year === new Date().getFullYear() && (
        <p className="muted" style={{ marginTop: 0 }}>{year} so far, through today.</p>
      )}

      <h3 style={{ marginTop: 0 }}>Profit by property</h3>
      <div className="card-list">
        {rows.map((r) => (
          <div key={r.p.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
              <strong>{r.p.name}</strong>
              <strong style={{ color: r.noi < 0 ? 'var(--danger)' : undefined }}>{money(r.noi)}</strong>
            </div>
            <div className="muted">
              {money(r.inc)} in · {money(r.opex)} operating costs
              {r.inc > 0 && ` (${pct(r.opex / r.inc)} of income)`}
            </div>
            {r.interest > 0 && <div className="muted">{money(r.cashFlow)} after {money(r.interest)} interest</div>}
            {r.invested && r.invested > 0 && (
              <div className="muted">
                {/* Annualised for a year in progress, so a March figure isn't read as a year's return. */}
                Return on cost {(r.noi / r.invested * 100 * (365 / periodDays)).toFixed(1)}% a year
              </div>
            )}
          </div>
        ))}
        {(sharedOpex > 0 || sharedInterest > 0) && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>Shared costs</strong>
              <strong>{money(-(sharedOpex + sharedInterest))}</strong>
            </div>
            <div className="muted">Bills covering every property, not split above.</div>
          </div>
        )}
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <strong>All properties</strong>
            <strong>{money(totalInc - totalOpex)}</strong>
          </div>
          <div className="muted">
            Net operating income: {money(totalInc)} in, {money(totalOpex)} operating costs.
            {totalInterest > 0 && ` ${money(totalInc - totalOpex - totalInterest)} after interest.`}
          </div>
        </div>
      </div>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Net operating income is income less the cost of running the building —
        before mortgage interest and depreciation. Return on cost needs the
        purchase price, entered on the Taxes view.
      </p>

      <h3 style={{ marginTop: '2rem' }}>Month by month</h3>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
        <thead>
          <tr className="muted" style={{ fontSize: '0.8rem', textAlign: 'right' }}>
            <th style={{ textAlign: 'left', fontWeight: 400 }}>Month</th>
            <th style={{ fontWeight: 400 }}>In</th>
            <th style={{ fontWeight: 400 }}>Out</th>
            <th style={{ fontWeight: 400 }}>Net</th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.key} style={{ borderTop: '1px solid var(--line)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              <td style={{ textAlign: 'left', padding: '0.35rem 0' }}>{m.label}</td>
              <td>{money(m.inc)}</td>
              <td>{money(m.out)}</td>
              <td style={{ color: m.inc - m.out < 0 ? 'var(--danger)' : undefined }}>{money(m.inc - m.out)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: '0.8rem' }}>
        Money as it arrived and left, deposits aside. Out includes mortgage interest.
      </p>

      <h3 style={{ marginTop: '2rem' }}>What's owed, by age</h3>
      <div className="card-list">
        <div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {buckets.map((b) => (
                <tr key={b.label} style={{ borderTop: '1px solid var(--line)' }}>
                  <td style={{ padding: '0.35rem 0' }}>{b.label}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                    color: b.min > 30 && b.amount > 0 ? 'var(--danger)' : undefined }}>
                    {money(b.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 0 }}>
            As of today. The older a balance, the less likely it is to be paid.
          </p>
        </div>
      </div>

      {latePayers.length > 0 && (
        <>
          <h3 style={{ marginTop: '2rem' }}>How quickly rent arrives</h3>
          <div className="card-list">
            {latePayers.map((t) => (
              <div key={t.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <span>{t.name}</span>
                <span className={t.avg > 5 ? 'error-text' : 'muted'} style={{ margin: 0, whiteSpace: 'nowrap' }}>
                  {t.avg < 0.5 ? 'on time' : `${t.avg.toFixed(1)} days late`}
                </span>
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: '0.8rem' }}>
            Average days after the due date, for rent paid in {year}.
          </p>
        </>
      )}

      <h3 style={{ marginTop: '2rem' }}>Occupancy</h3>
      <div className="card-list">
        <div>
          {occupancy === null ? <span className="muted">No units yet.</span> : (
            <>
              <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>{pct(occupancy)}</div>
              <div className="muted">of unit-days were leased in {year}</div>
              {lostRent >= 1 && (
                <div className="muted">About {money(lostRent)} of rent lost to empty units</div>
              )}
              {neverLeased > 0 && (
                <div className="muted">{neverLeased} unit(s) have never had a lease in the app</div>
              )}
            </>
          )}
        </div>
      </div>

      <h3 style={{ marginTop: '2rem' }}>Rent roll</h3>
      {active.length === 0 ? <p className="empty-state">No active leases.</p> : (
        <div className="card-list">
          {active.map((l) => {
            const bal = balanceByLease.get(l.id) ?? 0
            const ending = l.end_date && l.end_date <= soon
            return (
              <div key={l.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <strong>{propertyName(properties, l)} · {l.units?.label}</strong>
                  <span>{money(l.rent_amount)}/mo</span>
                </div>
                <div className="muted">
                  {l.lease_tenants.map((t) => t.org_members?.full_name).filter(Boolean).join(', ') || 'No tenant on the lease'}
                </div>
                <div className="muted">
                  {l.end_date ? `Lease ends ${l.end_date}` : 'Month to month'}
                  {ending && <span className="error-text"> · ending within 90 days</span>}
                  {bal > 0 && <span className="error-text"> · {money(bal)} owed</span>}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <h3 style={{ marginTop: '2rem' }}>Repairs</h3>
      <div className="card-list">
        {repairsByProperty.map((r) => (
          <div key={r.p.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
              <strong>{r.p.name}</strong>
              <span>{money(r.spend)}</span>
            </div>
            <div className="muted">
              {r.jobs} job(s) finished
              {r.avg !== null && ` · ${r.avg.toFixed(1)} days from report to done on average`}
              {r.perUnit !== null && r.spend > 0 && ` · ${money(r.perUnit)} per unit`}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function propertyName(properties: PropertyRow[], l: LeaseRow): string {
  return properties.find((p) => p.id === l.units?.property_id)?.name ?? ''
}
