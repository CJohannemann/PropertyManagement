import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import {
  fetchRequests, createJobFromRequest, fetchJobs,
  listRequestPhotos, requestPhotoUrl,
  type MaintenanceRequest, type Job,
} from '../lib/maintenance'
import { JobDetail } from './JobDetail'

type Props = { organizationId: string; memberId: string }

type Technician = { id: string; full_name: string | null }

/**
 * What admins and property managers see: everything tenants have
 * reported, and the jobs doing something about it.
 */
export function MaintenanceRequests({ organizationId, memberId }: Props) {
  const [requests, setRequests] = useState<MaintenanceRequest[] | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [technicians, setTechnicians] = useState<Technician[]>([])
  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [assigning, setAssigning] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    if (!supabase) return
    try {
      const [reqs, js] = await Promise.all([fetchRequests(), fetchJobs()])
      setRequests(reqs)
      setJobs(js)
      if (selectedJob) setSelectedJob(js.find((j) => j.id === selectedJob.id) ?? null)
      const { data } = await supabase
        .from('org_members')
        .select('id, full_name')
        .eq('role', 'technician')
        .eq('status', 'active')
      setTechnicians((data ?? []) as Technician[])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => { load() }, [organizationId])

  if (selectedJob) {
    return (
      <JobDetail
        job={selectedJob}
        memberId={memberId}
        canEdit
        onBack={() => { setSelectedJob(null); load() }}
        onChanged={load}
      />
    )
  }

  const unassigned = requests?.filter((r) => r.status === 'open') ?? []
  const activeJobs = jobs.filter((j) => j.status !== 'completed' && j.status !== 'canceled')

  return (
    <div>
      {/* "Open requests" on its own read as though it might mean unpaid
          rent, since it sits directly under the rent status on the admin
          and property-manager dashboards. It never did — these are repairs
          tenants have reported. Named for what they are. */}
      <h2>Maintenance requests</h2>
      {error && <p className="error-text">{error}</p>}
      {requests === null && !error && <p className="muted">Loading…</p>}
      {requests !== null && unassigned.length === 0 && (
        <p className="empty-state">Nothing waiting to be assigned.</p>
      )}

      <div className="card-list">
        {unassigned.map((r) => (
          <div key={r.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <strong>
                {r.units?.properties?.name}
                {r.units?.label ? ` · ${r.units.label}` : ''}
              </strong>
              <span className={r.priority === 'urgent' ? 'error-text' : 'muted'}
                    style={{ margin: 0 }}>
                {r.priority}
              </span>
            </div>
            <div>{r.description}</div>
            <div className="muted">
              {r.category} · reported {r.created_at.slice(0, 10)}
            </div>
            <RequestPhotos requestId={r.id} />

            {assigning === r.id ? (
              <AssignForm
                requestId={r.id}
                technicians={technicians}
                onDone={() => { setAssigning(null); load() }}
                onError={setError}
              />
            ) : (
              <button className="link" onClick={() => setAssigning(r.id)}>
                Assign to a technician
              </button>
            )}
          </div>
        ))}
      </div>

      <h2 style={{ marginTop: '2rem' }}>Jobs in progress</h2>
      {activeJobs.length === 0 ? (
        <p className="empty-state">No jobs underway.</p>
      ) : (
        <div className="card-list">
          {activeJobs.map((j) => (
            <div key={j.id} onClick={() => setSelectedJob(j)} style={{ cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong>
                  {j.properties?.name}{j.units?.label ? ` · ${j.units.label}` : ''}
                </strong>
                <span className="muted" style={{ margin: 0 }}>{j.status}</span>
              </div>
              {j.notes && <div className="muted">{j.notes}</div>}
              {!j.assigned_technician_id && (
                <div className="muted">Not assigned to anyone yet</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Thumbnails for whatever the tenant photographed when they reported this. */
function RequestPhotos({ requestId }: { requestId: string }) {
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => { listRequestPhotos(requestId).then(setPaths).catch(() => setPaths([])) }, [requestId])
  if (paths.length === 0) return null
  return (
    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
      {paths.map((p) => <RequestPhoto key={p} path={p} />)}
    </div>
  )
}

function RequestPhoto({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  // Signed on demand, same reasoning as receipts: the bucket is private
  // and a signed link should not be minted for photos nobody opens.
  useEffect(() => { requestPhotoUrl(path).then(setUrl).catch(() => setUrl(null)) }, [path])
  if (!url) return null
  return (
    <a href={url} target="_blank" rel="noreferrer">
      <img src={url} alt="Reported problem" style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 6 }} />
    </a>
  )
}

function AssignForm({
  requestId, technicians, onDone, onError,
}: {
  requestId: string
  technicians: Technician[]
  onDone: () => void
  onError: (m: string) => void
}) {
  const [tech, setTech] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)

  return (
    <form
      style={{ marginTop: '0.75rem' }}
      onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true)
        try {
          await createJobFromRequest(requestId, tech || null, date || null)
          onDone()
        } catch (err) {
          // The database refuses a technician who has no access to the
          // property — they would be handed a job they cannot open.
          onError(err instanceof Error ? err.message : String(err))
          setBusy(false)
        }
      }}
    >
      <div className="field">
        <label htmlFor={`tech-${requestId}`}>Technician</label>
        <select id={`tech-${requestId}`} value={tech} onChange={(e) => setTech(e.target.value)}>
          <option value="">Decide later</option>
          {technicians.map((t) => (
            <option key={t.id} value={t.id}>{t.full_name ?? 'Unnamed technician'}</option>
          ))}
        </select>
        {technicians.length === 0 && (
          <span className="muted">
            No technicians yet — invite one, or leave this unassigned and
            handle it yourself.
          </span>
        )}
      </div>
      <div className="field">
        <label htmlFor={`date-${requestId}`}>Scheduled for</label>
        <input id={`date-${requestId}`} type="date" value={date}
          onChange={(e) => setDate(e.target.value)} />
      </div>
      <button className="primary" type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create job'}
      </button>
    </form>
  )
}
