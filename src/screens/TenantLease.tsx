import { useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { fetchSigningStatus, type SigningStatus } from '../lib/signatures'
import { LeaseDocument } from './LeaseDocument'
import type { Lease } from '../lib/leases'

type Props = { leaseId: string; onBack: () => void }

type Place = {
  organizationName: string
  propertyName: string
  premises: string
  stateCode: string
}

/**
 * The tenant's view of their own lease: read it, sign it, and read it back
 * afterwards.
 *
 * Loads the lease and the place it refers to separately from
 * LeaseDocument, which is otherwise only ever reached from the landlord's
 * side where that context is already to hand.
 */
export function TenantLease({ leaseId, onBack }: Props) {
  const [lease, setLease] = useState<Lease | null>(null)
  const [place, setPlace] = useState<Place | null>(null)
  const [status, setStatus] = useState<SigningStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    if (!supabase) return
    try {
      const { data, error: e } = await supabase
        .from('leases')
        .select('*, units(label, properties(name, address_line1, city, state, zip, organizations(name)))')
        .eq('id', leaseId)
        .single()
      if (e) throw e

      const row = data as unknown as Lease & {
        units: {
          label: string
          properties: {
            name: string; address_line1: string; city: string; state: string; zip: string
            organizations: { name: string } | null
          } | null
        } | null
      }
      const p = row.units?.properties
      setLease(row)
      setPlace({
        organizationName: p?.organizations?.name ?? 'Landlord',
        propertyName: p?.name ?? '',
        premises: p
          ? `${p.address_line1}, ${p.city}, ${p.state} ${p.zip}${
              row.units?.label ? ` (${row.units.label})` : ''}`
          : '',
        stateCode: p?.state ?? '',
      })
      setStatus(await fetchSigningStatus(leaseId))
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  useEffect(() => { load() }, [leaseId])

  if (error) return <p className="error-text">{error}</p>
  if (!lease || !place) return <p className="muted">Loading your lease…</p>

  // Handed to LeaseDocument rather than rendered above it: the document
  // already has its own Back link, and a second one here stacked two
  // "← Back" links on top of each other.
  const intro = status?.fully_executed
    ? 'This lease is fully signed. Use Print / Save as PDF to keep a copy.'
    : status?.tenant_signed
      ? 'You have signed. Waiting for your landlord to countersign.'
      : 'Read this agreement, then sign at the bottom. Nothing is agreed until you do.'

  return (
    <div>
      <LeaseDocument
        intro={intro}
        lease={lease}
        propertyName={place.propertyName}
        premises={place.premises}
        stateCode={place.stateCode}
        organizationName={place.organizationName}
        signable
        onSigned={load}
        onClose={onBack}
      />
    </div>
  )
}
