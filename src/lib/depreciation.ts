/**
 * Estimated depreciation for a rental, by tax year.
 *
 * Import-free, so db/test/finance-math.mjs can run it under plain Node.
 *
 * The rules, from IRS Publication 527 and 946 (MACRS, general depreciation
 * system):
 *
 *   - The building, and improvements that become part of it (roof, HVAC,
 *     windows), are residential rental property: 27.5 years, straight
 *     line, mid-month convention. The first year gets the months from the
 *     middle of the month it was placed in service.
 *   - Appliances and carpet are 5-year property, furniture 7-year, land
 *     improvements (fences, driveways) 15-year: the IRS percentage tables
 *     for the half-year convention.
 *   - Land is never depreciated, so its value comes off the basis.
 *
 * What this leaves out, deliberately: bonus depreciation, section 179, the
 * mid-quarter convention, and anything already claimed under a different
 * method. It is an estimate for the year-end summary, labelled as one —
 * the accountant's figure wins.
 */

export type RecoveryYears = 5 | 7 | 15 | 27.5

/** IRS Pub 946 Table A-1: half-year convention, percent per year. */
const HALF_YEAR_TABLES: Record<5 | 7 | 15, number[]> = {
  5: [20.0, 32.0, 19.2, 11.52, 11.52, 5.76],
  7: [14.29, 24.49, 17.49, 12.49, 8.93, 8.92, 8.93, 4.46],
  15: [5.0, 9.5, 8.55, 7.7, 6.93, 6.23, 5.9, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 5.9, 5.91, 2.95],
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Depreciation for one asset in one tax year.
 *
 * @param basis      what is being depreciated (cost, less land for a building)
 * @param inService  YYYY-MM-DD it was first ready to rent
 * @param disposedOn YYYY-MM-DD it was sold, if it was. Depreciation stops
 *                   there: mid-month for the building (half of the month of
 *                   sale), half a year for 5/7/15-year property, and none
 *                   for anything bought and sold in the same year.
 */
export function depreciationForYear(
  basis: number,
  inService: string,
  recoveryYears: RecoveryYears,
  taxYear: number,
  disposedOn: string | null = null,
): number {
  if (!(basis > 0) || !isDate(inService)) return 0
  const startYear = Number(inService.slice(0, 4))
  const startMonth = Number(inService.slice(5, 7))
  const sold = disposedOn && isDate(disposedOn) ? disposedOn : null
  const soldYear = sold ? Number(sold.slice(0, 4)) : null
  if (taxYear < startYear) return 0
  if (soldYear !== null && taxYear > soldYear) return 0

  if (recoveryYears === 27.5) {
    const perYear = basis / 27.5
    // Months of service in each year, mid-month at both ends: placed in
    // service in March counts from mid-March; sold in June counts to
    // mid-June.
    const monthsIn = (y: number) => {
      const from = y === startYear ? startMonth - 0.5 : 0
      const to = soldYear !== null && y === soldYear ? Number(sold!.slice(5, 7)) - 0.5 : 12
      return Math.max(0, to - from)
    }
    let before = 0
    for (let y = startYear; y < taxYear; y++) before += perYear * monthsIn(y) / 12
    const thisYear = perYear * monthsIn(taxYear) / 12
    return round2(Math.max(0, Math.min(thisYear, basis - before)))
  }

  if (soldYear !== null && soldYear === startYear) return 0
  const pct = HALF_YEAR_TABLES[recoveryYears][taxYear - startYear]
  if (pct === undefined) return 0
  // Half-year convention applies to the year of sale too.
  const share = soldYear !== null && taxYear === soldYear ? 0.5 : 1
  return round2(basis * pct / 100 * share)
}

/** Everything claimed from the start through the end of `throughYear`. */
export function accumulatedThrough(
  basis: number,
  inService: string,
  recoveryYears: RecoveryYears,
  throughYear: number,
  disposedOn: string | null = null,
): number {
  if (!isDate(inService)) return 0
  let sum = 0
  for (let y = Number(inService.slice(0, 4)); y <= throughYear; y++) {
    sum += depreciationForYear(basis, inService, recoveryYears, y, disposedOn)
  }
  return round2(sum)
}

function isDate(s: string | null | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

/** The building's depreciable basis: price plus closing costs, less land. */
export function buildingBasis(f: {
  purchase_price: number | null
  closing_costs: number | null
  land_value: number | null
}): number {
  const b = (f.purchase_price ?? 0) + (f.closing_costs ?? 0) - (f.land_value ?? 0)
  return b > 0 ? round2(b) : 0
}

export type SaleAsset = { cost: number; inService: string; recoveryYears: RecoveryYears }

/**
 * The gain on selling a rental, for Form 4797.
 *
 *   amount realized   sale price less selling costs
 *   adjusted basis    purchase price + closing costs + improvements,
 *                     less all depreciation through the sale (land included
 *                     in the price, and never depreciated)
 *   gain              realized less adjusted basis
 *
 * Of a gain, the part that came from depreciation is taxed differently:
 * on the building and its structural improvements it is "unrecaptured
 * section 1250 gain", taxed at up to 25%; on 5/7/15-year property it is
 * recaptured as ordinary income (section 1245). The rest is ordinary
 * long-term capital gain if held over a year.
 *
 * Uses the depreciation this app estimates. The IRS uses depreciation
 * "allowed or allowable" — what was or should have been claimed — so the
 * accountant's own schedule is the one that counts.
 */
export function saleGain(input: {
  salePrice: number
  sellingCosts: number
  purchasePrice: number
  closingCosts: number
  landValue: number
  soldOn: string
  buildingInService: string
  improvements: SaleAsset[]
}) {
  const soldYear = Number(input.soldOn.slice(0, 4))
  const building = Math.max(0, input.purchasePrice + input.closingCosts - input.landValue)
  const buildingDep = accumulatedThrough(building, input.buildingInService, 27.5, soldYear, input.soldOn)
  let structuralDep = buildingDep
  let personalDep = 0
  let improvementCost = 0
  for (const i of input.improvements) {
    if (i.inService > input.soldOn) continue
    improvementCost += i.cost
    const d = accumulatedThrough(i.cost, i.inService, i.recoveryYears, soldYear, input.soldOn)
    if (i.recoveryYears === 27.5) structuralDep += d
    else personalDep += d
  }
  const realized = round2(input.salePrice - input.sellingCosts)
  const depreciation = round2(structuralDep + personalDep)
  const adjustedBasis = round2(input.purchasePrice + input.closingCosts + improvementCost - depreciation)
  const gain = round2(realized - adjustedBasis)
  // Recapture can't exceed the gain: on a loss, there is none.
  const positive = Math.max(0, gain)
  const recapture1245 = round2(Math.min(positive, personalDep))
  const unrecaptured1250 = round2(Math.min(positive - recapture1245, structuralDep))
  return {
    realized,
    depreciation,
    adjustedBasis,
    gain,
    recapture1245,
    unrecaptured1250,
    capitalGain: round2(positive - recapture1245 - unrecaptured1250),
  }
}
