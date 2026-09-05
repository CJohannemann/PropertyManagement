import { useEffect, useState } from 'react'
import { errorMessage } from '../lib/supabase'
import {
  fetchUpcoming, completeTask, deleteTask, type UpcomingEvent,
} from '../lib/tasks'
import { daysUntil } from '../lib/dashboard'
import { AddTask } from './AddTask'

type Props = { organizationId: string; propertyChoices: { id: string; name: string }[] }

/**
 * What is coming up, merged from tasks, rent falling due and leases ending.
 *
 * A landlord thinks in dates, not in tables. Rent and leases were already
 * derivable; tasks are the new part, and cover the things the spec listed
 * that had nowhere to live — inspections, insurance renewals, tax
 * deadlines, contractor appointments, recurring chores.
 */
export function Upcoming({ organizationId, propertyChoices }: Props) {
  const [events, setEvents] = useState<UpcomingEvent[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    fetchUpcoming(organizationId)
      .then(setEvents)
      .catch((e) => setError(errorMessage(e)))
  }

  useEffect(reload, [organizationId])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between',
                    alignItems: 'center' }}>
        <h2>Upcoming</h2>
        {!adding && (
          <button className="link" onClick={() => setAdding(true)}>+ Add a task</button>
        )}
      </div>

      {adding && (
        <AddTask
          organizationId={organizationId}
          propertyChoices={propertyChoices}
          onAdded={() => { setAdding(false); reload() }}
          onCancel={() => setAdding(false)}
        />
      )}

      {error && <p className="error-text">{error}</p>}
      {events === null && !error && <p className="muted">Loading…</p>}

      {events?.length === 0 && (
        <p className="empty-state">
          Nothing coming up. Rent dates, lease endings and anything you add
          here will appear as they approach.
        </p>
      )}

      <div className="card-list">
        {events?.map((e) => {
          const days = daysUntil(e.due_date)
          const late = days < 0

          return (
            <div key={`${e.kind}-${e.ref_id ?? e.due_date}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <strong>{e.title}</strong>
                <span className={late ? 'error-text' : 'muted'}
                      style={{ margin: 0, whiteSpace: 'nowrap' }}>
                  {/* Said in days, not just a date: "in 3 days" is the fact
                      a landlord acts on, and the date alone makes them do
                      the arithmetic. */}
                  {late ? `${-days} day${days === -1 ? '' : 's'} ago`
                    : days === 0 ? 'Today'
                      : `In ${days} day${days === 1 ? '' : 's'}`}
                </span>
              </div>
              <div className="muted">
                {e.detail} · {e.due_date}
              </div>

              {/* Only tasks can be ticked off. Rent and lease dates are
                  facts about other records, and "completing" one here would
                  mean nothing. */}
              {e.kind === 'task' && e.ref_id && (
                <div style={{ display: 'flex', gap: '1rem', marginTop: '0.4rem' }}>
                  <button
                    className="link"
                    disabled={busy === e.ref_id}
                    onClick={async () => {
                      setBusy(e.ref_id); setError(null)
                      try { await completeTask(e.ref_id!); reload() }
                      catch (err) { setError(errorMessage(err)) }
                      setBusy(null)
                    }}
                  >
                    {busy === e.ref_id ? 'Saving…' : 'Mark done'}
                  </button>
                  <button
                    className="link"
                    disabled={busy === e.ref_id}
                    onClick={async () => {
                      setBusy(e.ref_id); setError(null)
                      try { await deleteTask(e.ref_id!); reload() }
                      catch (err) { setError(errorMessage(err)) }
                      setBusy(null)
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
