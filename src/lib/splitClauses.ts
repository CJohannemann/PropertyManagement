/**
 * Splits a pasted lease into numbered clauses.
 *
 * Someone bringing their own lease has it as a Word document or a PDF, and
 * pasting the whole thing into one box makes the app a worse text editor
 * than the one they came from. Splitting on headings means each clause can
 * be edited on its own, reordered, or have a {placeholder} dropped into
 * it — which is the only reason the app holds the text at all rather than
 * a file.
 *
 * Heuristics, not parsing. Lease documents are not structured data, and a
 * wrong guess here costs a few seconds of tidying, so this leans towards
 * splitting where a person would see a heading:
 *
 *   1. GENERAL INFORMATION      numbered, all caps
 *   2.1 LATE RENT               decimal numbered
 *   Late Rent                   short title-case line on its own
 *   SECURITY DEPOSIT            short all-caps line
 *
 * Deliberately NOT split on: a numbered list inside a paragraph, or a
 * sentence that happens to start with a number, both of which are common
 * in the middle of clauses.
 */

export type SplitClause = { heading: string; body: string }

const NUMBERED = /^\s*(\d+(?:\.\d+)*)[.)]?\s+(.{2,80})$/
const ALL_CAPS = /^[A-Z0-9][A-Z0-9 ,'&/()-]{2,79}$/
const TITLE_CASE = /^(?:[A-Z][a-z'’-]*)(?:\s+(?:[A-Z][a-z'’-]*|and|or|of|the|to|for|in|a)){0,7}$/

function looksLikeHeading(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 80) return null

  // A heading does not end mid-sentence.
  if (/[.,;:]$/.test(trimmed) && !/^\s*\d/.test(trimmed)) return null

  // Runs of spaces are columns, not prose — a table row from a pasted PDF
  // ("Tenant Name        Tenant Email        Tenant Phone"). These read as
  // headings by every other test and are not.
  if (/\S {3,}\S/.test(line)) return null

  const numbered = trimmed.match(NUMBERED)
  if (numbered) {
    const rest = numbered[2].trim()
    // A numbered line is only a heading if it reads like one. Two guards,
    // both needed:
    //
    //   length — "1. The Tenant shall pay rent on the first of the month"
    //            is a sentence in a list, not a heading
    //   case   — "1. the unpaid rent" is a list item and is short enough
    //            to pass the length guard alone. Headings do not begin
    //            lowercase; list items routinely do.
    if (rest.split(/\s+/).length > 8) return null
    if (!/^[A-Z(]/.test(rest)) return null
    // A street address is a number followed by title-case words, and
    // passes every test above: "4920 Oliver Rd, Independence, KY 41051"
    // reads as section 4920. Real section numbers are small.
    if (Number(numbered[1].split('.')[0]) > 99) return null
    return rest
  }

  if (ALL_CAPS.test(trimmed) && trimmed.split(/\s+/).length <= 8) return trimmed
  if (TITLE_CASE.test(trimmed) && trimmed.split(/\s+/).length <= 6) return trimmed

  return null
}

export function splitIntoClauses(text: string): SplitClause[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const clauses: SplitClause[] = []
  let heading: string | null = null
  let body: string[] = []

  const flush = () => {
    const joined = body.join('\n').trim()
    if (heading !== null || joined) {
      clauses.push({ heading: heading ?? 'Agreement', body: joined })
    }
    body = []
  }

  for (const line of lines) {
    const h = looksLikeHeading(line)
    if (h === null) {
      body.push(line)
      continue
    }

    const hasBody = body.join('').trim() !== ''
    if (hasBody) {
      flush()
      heading = h
    } else if (heading === null) {
      heading = h
    } else {
      // A heading directly under another with nothing between them — the
      // first is a section title ("1. GENERAL INFORMATION" above
      // "1.1 DATE"). Keep the more specific one rather than emitting an
      // empty clause or, worse, swallowing the real heading into a body.
      heading = h
    }
  }
  flush()

  return clauses
    .map((c) => ({ heading: c.heading.trim(), body: c.body.trim() }))
    .filter((c) => c.body !== '' || c.heading !== '')
}
