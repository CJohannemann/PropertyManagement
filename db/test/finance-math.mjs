#!/usr/bin/env node
//
// The year-end calculations that run in the browser: depreciation, CSV
// and the zip the tax package downloads as.
//
//   npm run verify:finance
//
// Depreciation is checked against the IRS's own published percentages
// (Pub 946, Tables A-1 and A-6), not against itself. The zip is opened by
// Python's zipfile, an implementation this code had no part in writing.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  depreciationForYear, accumulatedThrough, buildingBasis, saleGain,
} from '../../src/lib/depreciation.ts'
import { toCsv, buildZip, crc32, safeFileName } from '../../src/lib/fileExport.ts'

let failures = 0
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
const near = (a, b, tol = 1) => Math.abs(a - b) <= tol

console.log('depreciation: residential rental, 27.5 years')
// $250,000 purchase, $50,000 land → $200,000 basis.
const basis = buildingBasis({ purchase_price: 250000, closing_costs: null, land_value: 50000 })
check('basis is price less land', basis, 200000)
check('closing costs add to basis',
  buildingBasis({ purchase_price: 250000, closing_costs: 4000, land_value: 50000 }), 204000)
check('land worth more than the price gives no basis, not a negative one',
  buildingBasis({ purchase_price: 10000, closing_costs: 0, land_value: 50000 }), 0)
// Table A-6, placed in service in March: 2.879% in year one, 3.636% after.
check('March, year one is 2.879% (Table A-6)',
  near(depreciationForYear(basis, '2024-03-15', 27.5, 2024), 200000 * 0.02879), true)
check('a full year is 3.636%',
  near(depreciationForYear(basis, '2024-03-15', 27.5, 2025), 200000 * 0.03636), true)
// December: half a month in year one, 0.152%.
check('December, year one is 0.152%',
  near(depreciationForYear(basis, '2024-12-01', 27.5, 2024), 200000 * 0.00152), true)
check('nothing before it was placed in service',
  depreciationForYear(basis, '2024-03-15', 27.5, 2023), 0)
check('it stops once the basis is used up',
  depreciationForYear(basis, '2024-03-15', 27.5, 2060), 0)
check('the whole life adds up to the basis',
  near(accumulatedThrough(basis, '2024-03-15', 27.5, 2060), 200000, 0.5), true)

console.log('\ndepreciation: 5, 7 and 15 year, half-year convention')
// Table A-1.
check('5-year, year one 20%', depreciationForYear(1000, '2026-07-01', 5, 2026), 200)
check('5-year, year two 32%', depreciationForYear(1000, '2026-07-01', 5, 2027), 320)
check('5-year, sixth year 5.76%', depreciationForYear(1000, '2026-07-01', 5, 2031), 57.6)
check('5-year, done after six', depreciationForYear(1000, '2026-07-01', 5, 2032), 0)
check('7-year adds up to the basis',
  near(accumulatedThrough(1000, '2026-01-01', 7, 2040), 1000, 0.05), true)
check('15-year adds up to the basis',
  near(accumulatedThrough(1000, '2026-01-01', 15, 2050), 1000, 0.05), true)
check('a bad date gives nothing rather than NaN', depreciationForYear(1000, '', 5, 2026), 0)

console.log('\nselling')
// Sold mid-June: the building gets five and a half months that year.
check('the year of sale stops mid-month',
  near(depreciationForYear(200000, '2021-03-15', 27.5, 2026, '2026-06-15'), 200000 / 27.5 * 5.5 / 12, 0.01), true)
check('and nothing after it', depreciationForYear(200000, '2021-03-15', 27.5, 2027, '2026-06-15'), 0)
check('5-year property gets half a year in the year of sale',
  depreciationForYear(1000, '2024-07-01', 5, 2026, '2026-06-15'), 96)
check('nothing for something bought and sold the same year',
  depreciationForYear(1000, '2026-02-01', 5, 2026, '2026-06-15'), 0)
// $250,000 with $50,000 land, in service March 2021, sold June 2026 for
// $300,000 less $18,000 costs. 63 months of depreciation on $200,000.
const sale = saleGain({
  salePrice: 300000, sellingCosts: 18000, purchasePrice: 250000, closingCosts: 0,
  landValue: 50000, soldOn: '2026-06-15', buildingInService: '2021-03-15', improvements: [],
})
const dep = Math.round(200000 / 27.5 * 63 / 12 * 100) / 100
check('depreciation taken is 63 months of it', near(sale.depreciation, dep, 0.02), true)
check('adjusted basis is price less depreciation (land included)', near(sale.adjustedBasis, 250000 - dep, 0.02), true)
check('gain is what was realized less adjusted basis', near(sale.gain, 282000 - (250000 - dep), 0.02), true)
check('the depreciation part is unrecaptured 1250 gain', near(sale.unrecaptured1250, dep, 0.02), true)
check('the rest is capital gain', near(sale.capitalGain, 32000, 0.02), true)
const loss = saleGain({
  salePrice: 150000, sellingCosts: 10000, purchasePrice: 250000, closingCosts: 0,
  landValue: 50000, soldOn: '2026-06-15', buildingInService: '2021-03-15',
  improvements: [{ cost: 3000, inService: '2024-01-10', recoveryYears: 5 }],
})
check('on a loss there is no recapture', [loss.recapture1245, loss.unrecaptured1250, loss.capitalGain], [0, 0, 0])
check('and the loss is reported as a negative gain', loss.gain < 0, true)

console.log('\nspreadsheet files')
const csv = toCsv(['Payee', 'Amount'], [['Joe, Inc', 12.5], ['Say "hi"', 1], ['=cmd()', 2], [null, -5]])
check('starts with a byte-order mark for Excel', csv.charCodeAt(0), 0xfeff)
check('commas and quotes are escaped, formulas are defused',
  csv.slice(1).split('\r\n'),
  ['Payee,Amount', '"Joe, Inc",12.5', '"Say ""hi""",1', "'=cmd(),2", ',-5', ''])
check('file names lose characters Windows refuses',
  safeFileName('Lowe\'s: 2026/11/03 "receipt"?'), 'Lowe\'s- 2026-11-03 -receipt-')

console.log('\nzip')
check('CRC-32 of "123456789" is the standard check value',
  crc32(new TextEncoder().encode('123456789')).toString(16), 'cbf43926')
const zip = buildZip([
  { name: 'summary.csv', data: new TextEncoder().encode(csv) },
  { name: 'receipts/Lowe\'s 2026-11-03.jpg', data: new Uint8Array([1, 2, 3, 255]) },
])
const dir = mkdtempSync(join(tmpdir(), 'pm-zip-'))
const zipPath = join(dir, 'pkg.zip')
writeFileSync(zipPath, zip)
const listed = execFileSync('python3', ['-I', '-c', `
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
assert z.testzip() is None, 'bad CRC'
print('|'.join(f"{i.filename}:{i.file_size}" for i in z.infolist()))
`, zipPath], { encoding: 'utf8' }).trim()
rmSync(dir, { recursive: true })
check('a separate zip reader opens it, with CRCs intact',
  listed, `summary.csv:${new TextEncoder().encode(csv).length}|receipts/Lowe's 2026-11-03.jpg:4`)

console.log(failures === 0
  ? '\n\x1b[32mAll finance calculations passed.\x1b[0m'
  : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`)
process.exit(failures === 0 ? 0 : 1)
