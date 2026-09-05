import { daysUntil, type DashboardSummary } from '../lib/dashboard'
import { money } from '../lib/charges'

type Props = {
  summary: DashboardSummary
  onViewRent: () => void
  onViewMaintenance: () => void
}

type Item = {
  key: string
  urgency: 'high' | 'medium' | 'low'
  headline: string
  detail: string
  action: string
  onClick: () => void
}

/**
 * The action centre: what the landlord should do something about today.
 *
 * This is the only place urgency is expressed. The sections below it report
 * the same facts as reference — overdue rent appears in the rent list and
 * in the property rows too — and if every one of them shouted, none of them
 * would mean anything.
 *
 * Ordered by how much it costs to ignore, not by category: rent that is
 * already late outranks rent about to be due, and a tenant with no hot
 * water outranks a lease that needs renewing next month.
 */
export function NeedsAttention({ summary, onViewRent, onViewMaintenance }: Props) {
  const items: Item[] = []
  const { rent, maintenance, top_request: top, expiring_leases: expiring } = summary

  if (rent.overdue > 0) {
    items.push({
      key: 'overdue',
      urgency: 'high',
      headline: `${rent.overdue_leases} ${rent.overdue_leases === 1 ? 'tenant has' : 'tenants have'} overdue rent`,
      detail: `${money(rent.overdue)} outstanding`,
      action: 'View balances',
      onClick: onViewRent,
    })
  }

  if (maintenance.urgent > 0 && top) {
    items.push({
      key: 'urgent-maintenance',
      urgency: 'high',
      headline: `${maintenance.urgent} high-priority ${maintenance.urgent === 1 ? 'repair' : 'repairs'}`,
      detail: `${top.property_name}${top.unit_label ? ` · ${top.unit_label}` : ''} — ${top.description}`,
      action: 'View request',
      onClick: onViewMaintenance,
    })
  }

  // Something reported that nobody has picked up. Distinct from the urgent
  // count above: a normal-priority request left sitting for a week is its
  // own kind of failure.
  if (maintenance.unassigned > 0 && maintenance.urgent === 0) {
    items.push({
      key: 'unassigned',
      urgency: 'medium',
      headline: `${maintenance.unassigned} ${maintenance.unassigned === 1 ? 'repair is' : 'repairs are'} waiting to be assigned`,
      detail: top ? `${top.property_name} — ${top.description}` : '',
      action: 'Assign work',
      onClick: onViewMaintenance,
    })
  }

  for (const lease of expiring) {
    const days = daysUntil(lease.end_date)
    items.push({
      key: `lease-${lease.lease_id}`,
      urgency: days <= 30 ? 'medium' : 'low',
      headline: days <= 0
        ? 'A lease has ended'
        : `Lease ends in ${days} ${days === 1 ? 'day' : 'days'}`,
      detail: `${lease.property_name}${lease.unit_label ? ` · ${lease.unit_label}` : ''}`,
      action: 'Review lease',
      onClick: onViewRent,
    })
  }

  if (rent.due_soon > 0) {
    items.push({
      key: 'due-soon',
      urgency: 'low',
      headline: `Rent due this week from ${rent.due_soon_leases} ${rent.due_soon_leases === 1 ? 'tenant' : 'tenants'}`,
      detail: `${money(rent.due_soon)} expected`,
      action: 'View charges',
      onClick: onViewRent,
    })
  }

  const RANK = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => RANK[a.urgency] - RANK[b.urgency])

  // An empty action centre is the good outcome, and should read like one
  // rather than as a box that failed to load.
  if (items.length === 0) {
    return (
      <div className="card-list">
        <div>
          <strong>Nothing needs you right now</strong>
          <div className="muted">
            Rent is up to date, no repairs are waiting, and no leases are
            ending soon.
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="card-list">
      {items.map((item) => (
        <div
          key={item.key}
          role="button"
          tabIndex={0}
          onClick={item.onClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); item.onClick() }
          }}
          style={{ cursor: 'pointer' }}
        >
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline' }}>
            {/* Urgency is never colour alone — the dot is labelled for a
                screen reader and every item states its own severity in
                words. */}
            <span aria-hidden="true" style={{
              width: 9, height: 9, borderRadius: '50%', flexShrink: 0,
              background: item.urgency === 'high' ? 'var(--danger)'
                : item.urgency === 'medium' ? 'var(--series-outstanding)'
                  : 'var(--muted)',
            }} />
            <strong>{item.headline}</strong>
          </div>
          {item.detail && (
            <div className="muted" style={{ marginLeft: '1.5rem' }}>{item.detail}</div>
          )}
          <div style={{ marginLeft: '1.5rem' }}>
            <span className="link-text">{item.action} →</span>
          </div>
        </div>
      ))}
    </div>
  )
}
