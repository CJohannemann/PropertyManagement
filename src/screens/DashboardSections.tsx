import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { fetchDashboard, type DashboardSummary } from '../lib/dashboard'
import { NeedsAttention } from './NeedsAttention'
import { PortfolioOverview } from './PortfolioOverview'

type Props = {
  organizationId: string
  onOpenProperty: (id: string) => void
}

/**
 * The action centre and the portfolio snapshot, sharing one request.
 *
 * Both read from dashboard_summary(), so they are fetched together rather
 * than twice — this is the first thing loaded and usually on a phone.
 *
 * "View" actions scroll to the relevant section rather than navigating.
 * The app has exactly one screen today and everything below is component
 * state, so there is nowhere to navigate TO; making these real links needs
 * routing, which is its own piece of work. Scrolling is honest about what
 * it does in the meantime, rather than a link that quietly does nothing.
 */
export function DashboardSections({ organizationId, onOpenProperty }: Props) {
  const [summary, setSummary] = useState<DashboardSummary | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchDashboard(organizationId)
      .then(setSummary)
      .catch((e) => setError(errorMessage(e)))
  }, [organizationId])

  if (error) {
    return (
      <p className="muted">
        This summary couldn't load, though everything below is current. ({error})
      </p>
    )
  }
  if (!summary) return <p className="muted">Loading…</p>

  const scrollTo = (heading: string) => () => {
    const target = Array.from(document.querySelectorAll('h2, h3'))
      .find((h) => h.textContent?.trim().toLowerCase().startsWith(heading))
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <>
      <NeedsAttention
        summary={summary}
        onViewRent={scrollTo('rent status')}
        onViewMaintenance={scrollTo('maintenance requests')}
      />

      <h2 style={{ marginTop: '2rem' }}>Your portfolio</h2>
      <PortfolioOverview
        summary={summary}
        onOpenProperty={onOpenProperty}
        onViewMaintenance={scrollTo('maintenance requests')}
      />
    </>
  )
}
