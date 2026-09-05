#!/usr/bin/env node
//
// URL paths to screens.
//
//   npm run verify:routing
//
// The dashboard used to be one screen holding everything in component
// state: no back button, no deep link, and nowhere for "tap this number to
// see the underlying" to go. These are the rules that replaced it, and the
// ones worth pinning down are the edges — a trailing slash, an unknown
// path, an id that needs escaping.

import { parsePath, hrefFor, APP_SECTIONS, SIGNED_IN_ONLY } from '../../src/lib/routePaths.ts'

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`  ${ok ? '\x1b[32mpass\x1b[0m' : '\x1b[31mFAIL\x1b[0m'}  ${label}`)
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

console.log('\nthe plain screens')
check('the root', parsePath('/'), { route: '/' })
check('the dashboard', parsePath('/dashboard'), { route: '/dashboard' })
check('rent', parsePath('/rent'), { route: '/rent' })
check('maintenance', parsePath('/maintenance'), { route: '/maintenance' })
check('properties', parsePath('/properties'), { route: '/properties' })
check('settings', parsePath('/settings'), { route: '/settings' })

console.log('\nedges')
// A link pasted with a trailing slash is the same screen, not a 404.
check('a trailing slash is the same screen', parsePath('/rent/'), { route: '/rent' })
check('several trailing slashes too', parsePath('/rent///'), { route: '/rent' })
check('an empty path is the root', parsePath(''), { route: '/' })
check('an unknown path is not found', parsePath('/nope'), { route: 'not-found' })
check('a deeper unknown path is not found', parsePath('/rent/extra/bits'), { route: 'not-found' })

console.log('\none property')
check('a property id is carried through',
  parsePath('/properties/abc-123'), { route: '/properties', id: 'abc-123' })
check('an escaped id is decoded',
  parsePath('/properties/a%20b'), { route: '/properties', id: 'a b' })
// decodeURIComponent throws on a malformed escape; a bad URL should 404
// rather than take the app down with it.
check('a malformed escape is not found',
  parsePath('/properties/%zz'), { route: 'not-found' })
// Only properties takes a parameter — /rent/<something> is a typo, not a
// screen.
check('other screens take no parameter',
  parsePath('/maintenance/abc'), { route: 'not-found' })

console.log('\nbuilding links')
check('a plain screen', hrefFor('/rent'), '/rent')
check('a screen with an id', hrefFor('/properties', 'abc-123'), '/properties/abc-123')
check('an id needing escapes is escaped',
  hrefFor('/properties', 'a b/c'), '/properties/a%20b%2Fc')
// Round trip: anything hrefFor builds, parsePath must read back.
const roundTripped = parsePath(hrefFor('/properties', 'a b/c'))
check('and reads back as the same id', roundTripped, { route: '/properties', id: 'a b/c' })

console.log('\nthe nav and the guard agree with the routes')
for (const s of APP_SECTIONS) {
  check(`${s.label} points at a real screen`, parsePath(s.route).route, s.route)
}
// Every section behind the sign-in guard must be a route that exists, or
// signing out would strand someone on a 404.
for (const p of SIGNED_IN_ONLY) {
  check(`${p} is a real screen`, parsePath(p).route !== 'not-found', true)
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll routing tests passed.\x1b[0m'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m`,
)
process.exit(failures === 0 ? 0 : 1)
