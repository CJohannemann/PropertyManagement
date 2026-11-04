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
 */
export function depreciationForYear(
  basis: number,
  inService: string,
  recoveryYears: RecoveryYears,
  taxYear: number,
): number {
  if (!(basis > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(inService)) return 0
  const startYear = Number(inService.slice(0, 4))
  const startMonth = Number(inService.slice(5, 7))
  if (taxYear < startYear) return 0

  if (recoveryYears === 27.5) {
    const perYear = basis / 27.5
    // Mid-month: placed in service in March = 9.5 months in year one.
    const first = perYear * (12 - startMonth + 0.5) / 12
    if (taxYear === startYear) return round2(first)
    const before = first + perYear * (taxYear - startYear - 1)
    return round2(Math.max(0, Math.min(perYear, basis - before)))
  }

  const pct = HALF_YEAR_TABLES[recoveryYears][taxYear - startYear]
  return pct === undefined ? 0 : round2(basis * pct / 100)
}

/** Everything claimed from the start through the end of `throughYear`. */
export function accumulatedThrough(
  basis: number,
  inService: string,
  recoveryYears: RecoveryYears,
  throughYear: number,
): number {
  if (!/^\d{4}/.test(inService)) return 0
  let sum = 0
  for (let y = Number(inService.slice(0, 4)); y <= throughYear; y++) {
    sum += depreciationForYear(basis, inService, recoveryYears, y)
  }
  return round2(sum)
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
