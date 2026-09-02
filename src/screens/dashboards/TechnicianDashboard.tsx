import { useEffect, useState } from 'react'
import { supabase, describeError } from '../../lib/supabase'

type Job = {
  id: string
  status: string
  scheduled_date: string | null
  notes: string | null
}

export function TechnicianDashboard() {
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    supabase
      .from('maintenance_jobs')
      .select('id, status, scheduled_date, notes')
      .order('scheduled_date', { ascending: true })
      .then(({ data, error }) => {
        if (error) setError(describeError(error))
        else setJobs(data)
      })
  }, [])

  return (
    <div>
      <h2>Your jobs</h2>
      {error && <p className="error-text">{error}</p>}
      {jobs === null && !error && <p className="muted">Loading…</p>}
      {jobs?.length === 0 && (
        <p className="empty-state">No jobs assigned to you yet.</p>
      )}
      <div className="card-list">
        {jobs?.map((j) => (
          <div key={j.id}>
            <strong>{j.status}</strong>
            {j.scheduled_date && <div className="muted">Scheduled: {j.scheduled_date}</div>}
            {j.notes && <div className="muted">{j.notes}</div>}
          </div>
        ))}
      </div>
    </div>
  )
}
