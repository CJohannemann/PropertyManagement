import { errorMessage } from '../lib/supabase'
import { useEffect, useState } from 'react'
import {
  fetchRentSummary, monthLabel, collectionRate, type RentMonth,
} from '../lib/analytics'
import { money } from '../lib/charges'

type Props = { organizationId: string }

/**
 * How the business is doing: this month, and the last twelve.
 *
 * Deliberately does NOT show an overdue figure. RentStatus sits directly
 * below this and already computes one exactly, from each charge's own due
 * date; anything derived here from monthly buckets would be close but not
 * identical, and two overdue numbers disagreeing on one screen is worse
 * than one shown once.
 */
export function RentOverview({ organizationId }: Props) {
  const [months, setMonths] = useState<RentMonth[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRentSummary(organizationId, 12)
      .then(setMonths)
      .catch((e) => setError(errorMessage(e)))
  }, [organizationId])

  // Muted rather than a red banner across the top of the page: this is a
  // summary of what the rent status below already shows in full, so
  // failing to load it degrades the dashboard rather than breaking it. The
  // reason is still printed — a missing function after a deploy says
  // exactly that, and hiding it would leave someone guessing.
  if (error) {
    return (
      <p className="muted">
        The rent overview couldn't load, though everything below is current.
        {' '}({error})
      </p>
    )
  }
  if (months === null) return <p className="muted">Loading…</p>

  const billedEver = months.reduce((s, m) => s + m.billed, 0)
  if (billedEver === 0) {
    return (
      <p className="empty-state">
        Nothing billed in the last year yet. Once a lease is running, rent
        is charged each month and this fills in.
      </p>
    )
  }

  const thisMonth = months[months.length - 1]
  const collectedYear = months.reduce((s, m) => s + m.collected, 0)
  const spentYear = months.reduce((s, m) => s + m.spent, 0)

  return (
    <div className="card-list">
      <div>
        <ThisMonth month={thisMonth} />
        <TwelveMonths months={months} />
        <div className="muted" style={{ marginTop: '0.75rem' }}>
          Last 12 months: {money(collectedYear)} collected of {money(billedEver)} billed
          {' '}({Math.round((collectedYear / billedEver) * 100)}%)
          {spentYear > 0 && (
            <>
              {' · '}{money(spentYear)} spent on repairs
              {' · '}<strong>{money(collectedYear - spentYear)} net</strong>
            </>
          )}
        </div>
        {spentYear > 0 && (
          <div className="muted" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
            Net is rent collected less what you paid out on repairs. It doesn't
            include your own unpaid time, a mortgage, tax or insurance.
          </div>
        )}
      </div>
    </div>
  )
}

function ThisMonth({ month }: { month: RentMonth }) {
  const rate = collectionRate(month)

  return (
    <div style={{ marginBottom: '1.25rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '1rem' }}>
        <div>
          <div style={{ fontSize: '1.6rem', fontWeight: 600 }}>
            {money(month.collected)}
          </div>
          <div className="muted">
            collected of {money(month.billed)} billed this month
          </div>
        </div>
        <div style={{ fontSize: '1.2rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
          {Math.round(rate * 100)}%
        </div>
      </div>

      {/* A proportion bar, not a donut: it reads at a glance on a phone and
          needs no legend of its own. */}
      <div
        role="img"
        aria-label={`${Math.round(rate * 100)} percent of this month's rent collected`}
        style={{
          marginTop: '0.6rem', height: 10, borderRadius: 5,
          background: 'var(--line)', overflow: 'hidden',
        }}
      >
        <div style={{
          width: `${rate * 100}%`, height: '100%', borderRadius: 5,
          background: 'var(--series-collected)',
        }} />
      </div>
      {month.outstanding > 0 && (
        <div className="muted" style={{ marginTop: '0.4rem' }}>
          {money(month.outstanding)} still to come in
        </div>
      )}
    </div>
  )
}

// Chart geometry. A viewBox plus width:100% means one set of numbers works
// from a 320px phone to a desktop column.
const W = 360
const H = 150
const PLOT_TOP = 8
const PLOT_BOTTOM = 118
const BAR_W = 16
const SEGMENT_GAP = 2

/** A rect with only its top corners rounded — the data end, per the mark spec. */
function topRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2)
  return `M${x},${y + h} L${x},${y + radius} Q${x},${y} ${x + radius},${y}`
    + ` L${x + w - radius},${y} Q${x + w},${y} ${x + w},${y + radius}`
    + ` L${x + w},${y + h} Z`
}

/** The same, mirrored: for a bar hanging below the zero line. */
function bottomRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const radius = Math.min(r, h, w / 2)
  return `M${x},${y} L${x},${y + h - radius} Q${x},${y + h} ${x + radius},${y + h}`
    + ` L${x + w - radius},${y + h} Q${x + w},${y + h} ${x + w},${y + h - radius}`
    + ` L${x + w},${y} Z`
}

function TwelveMonths({ months }: { months: RentMonth[] }) {
  const [selected, setSelected] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  // One dollar scale for both directions. Rent rises from the zero line,
  // repair spend hangs below it — never a second y-axis, which would let
  // a $60 repair draw taller than $1,200 of rent and mean nothing.
  const maxBilled = Math.max(...months.map((m) => m.billed), 0)
  const maxSpent = Math.max(...months.map((m) => m.spent), 0)
  const span = Math.max(maxBilled + maxSpent, 1)
  const perDollar = (PLOT_BOTTOM - PLOT_TOP) / span
  // With nothing spent this sits on the bottom and the chart looks exactly
  // as it did before repairs were tracked.
  const zeroY = PLOT_TOP + maxBilled * perDollar

  const slotW = W / months.length
  const scale = (v: number) => v * perDollar

  const anySpend = months.some((m) => m.spent > 0)
  const shown = selected != null ? months[selected] : null

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'baseline', gap: '1rem' }}>
        <strong>Rent by month</strong>
        <button className="link" style={{ margin: 0 }}
                onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {/* Identity is never colour alone: a legend for the two series, and
          the table view below carries the same numbers without colour. */}
      <div style={{ display: 'flex', gap: '1rem', margin: '0.5rem 0' }}>
        <Key colour="var(--series-collected)" label="Collected" />
        <Key colour="var(--series-outstanding)" label="Outstanding" />
        {anySpend && <Key colour="var(--series-spent)" label="Repairs" />}
      </div>

      {asTable ? (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr>
                <th style={cell('left')}>Month</th>
                <th style={cell()}>Billed</th>
                <th style={cell()}>Collected</th>
                <th style={cell()}>Outstanding</th>
                <th style={cell()}>Repairs</th>
                <th style={cell()}>Net</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td style={cell('left')}>{monthLabel(m.month, true)}</td>
                  <td style={cell()}>{money(m.billed)}</td>
                  <td style={cell()}>{money(m.collected)}</td>
                  <td style={cell()}>{m.outstanding > 0 ? money(m.outstanding) : '—'}</td>
                  <td style={cell()}>{m.spent > 0 ? money(m.spent) : '—'}</td>
                  <td style={cell()}>{money(m.collected - m.spent)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            width="100%"
            role="img"
            aria-label={`Rent billed and collected over the last ${months.length} months`}
            style={{ display: 'block', overflow: 'visible' }}
          >
            {/* Recessive zero line. No gridlines: at this size they compete
                with the marks rather than helping read them. */}
            <line x1={0} y1={zeroY} x2={W} y2={zeroY}
                  stroke="var(--line)" strokeWidth={1} />

            {months.map((m, i) => {
              const cx = i * slotW + slotW / 2
              const x = cx - BAR_W / 2
              const collectedH = scale(m.collected)
              const outstandingH = scale(m.outstanding)
              const spentH = scale(m.spent)
              const isLast = i === months.length - 1
              const isSelected = selected === i

              // Collected sits on the zero line; what is still owed stacks
              // above it, so the bar's full height is what was billed.
              const collectedY = zeroY - collectedH
              const outstandingY = collectedY - SEGMENT_GAP - outstandingH

              return (
                <g key={m.month}>
                  {outstandingH > 0.5 && (
                    <path
                      d={topRoundedPath(x, outstandingY, BAR_W, outstandingH, 4)}
                      fill="var(--series-outstanding)"
                    />
                  )}
                  {collectedH > 0.5 && (
                    <path
                      d={topRoundedPath(
                        x,
                        collectedY,
                        BAR_W,
                        collectedH,
                        outstandingH > 0.5 ? 0 : 4,
                      )}
                      fill="var(--series-collected)"
                    />
                  )}

                  {/* Repair spend hangs below the zero line — money going
                      the other way, on the same dollar scale, so the two
                      are directly comparable by eye. Rounded at its own
                      data end, which points downwards. */}
                  {spentH > 0.5 && (
                    <path
                      d={bottomRoundedPath(x, zeroY + SEGMENT_GAP, BAR_W, spentH, 4)}
                      fill="var(--series-spent)"
                    />
                  )}

                  {/* Full-height hit target, comfortably bigger than the
                      mark — a 16px bar is a poor thing to tap at. */}
                  <rect
                    x={cx - slotW / 2} y={0} width={slotW} height={PLOT_BOTTOM}
                    fill="transparent"
                    style={{ cursor: 'pointer' }}
                    onClick={() => setSelected(isSelected ? null : i)}
                  >
                    <title>
                      {`${monthLabel(m.month, true)}: ${money(m.collected)} collected of ${money(m.billed)} billed`}
                    </title>
                  </rect>

                  {/* Sparse labels — every third month plus the current one.
                      Twelve labels at this width collide. */}
                  {(i % 3 === 0 || isLast) && (
                    <text
                      x={cx} y={PLOT_BOTTOM + 14} textAnchor="middle"
                      fontSize={10} fill="var(--muted)"
                    >
                      {monthLabel(m.month)}
                    </text>
                  )}
                  {isSelected && (
                    <line x1={cx} y1={PLOT_TOP} x2={cx} y2={PLOT_BOTTOM}
                          stroke="var(--muted)" strokeWidth={1} strokeDasharray="2 2" />
                  )}
                </g>
              )
            })}
          </svg>

          {/* The detail a hover tooltip gives on a desktop, in a place a
              thumb can reach. */}
          <div className="muted" style={{ minHeight: '1.5em', marginTop: '0.25rem' }}>
            {shown
              ? `${monthLabel(shown.month, true)}: ${money(shown.collected)} collected`
                + ` of ${money(shown.billed)} billed`
                + (shown.outstanding > 0 ? ` · ${money(shown.outstanding)} outstanding` : '')
              + (shown.spent > 0 ? ` · ${money(shown.spent)} on repairs` : '')
              : 'Tap a month for its figures.'}
          </div>
        </>
      )}
    </div>
  )
}

function Key({ colour, label }: { colour: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: colour }} />
      {/* Label in text ink, never the series colour. */}
      <span className="muted" style={{ margin: 0 }}>{label}</span>
    </span>
  )
}

/** Money right-aligns so digits line up down the column; the month label doesn't. */
function cell(align: 'left' | 'right' = 'right'): React.CSSProperties {
  return {
    textAlign: align,
    padding: '0.3rem 0.5rem',
    borderBottom: '1px solid var(--line)',
    whiteSpace: 'nowrap',
  }
}
