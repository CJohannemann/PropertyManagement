#!/usr/bin/env node
//
// Runs every db/test/*.test.sql against a throwaway Postgres, from a clean
// database each time.
//
//   npm run verify
//   npm run verify -- charges          # only files matching "charges"
//
// Uses the real supabase/postgres image rather than plain postgres, which
// is not incidental: an earlier bug (create_invite calling pgcrypto's
// gen_random_bytes) passed against postgres:alpine, where pgcrypto lives
// in `public`, and failed in production, where Supabase installs it into
// `extensions`. Testing against a different database than production is
// testing something else.
//
// Each test file asserts with `raise exception`, so any failure aborts
// that file and this runner reports it. A file that runs to completion
// passed.

import { execFileSync, execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB = join(HERE, '..')
const CONTAINER = 'pm-test-db'
const IMAGE = 'supabase/postgres:15.1.1.78'

const filter = process.argv[2] ?? ''
const red = (s) => `\x1b[31m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

function docker(args, opts = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', ...opts })
}

function psql(sql, { quiet = true } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1']
  if (quiet) args.push('-q')
  // Silences the wall of "truncate cascades to table ..." notices between
  // files, which otherwise bury the one line that matters. Warnings and
  // errors still come through, and ON_ERROR_STOP still aborts.
  return execFileSync('docker', args, {
    input: `set client_min_messages = warning;\n${sql}`,
    encoding: 'utf8',
  })
}

function start() {
  try { docker(['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* not running */ }
  console.log(dim(`starting ${IMAGE}…`))
  docker(['run', '-d', '--name', CONTAINER, '-e', 'POSTGRES_PASSWORD=test', IMAGE],
    { stdio: 'ignore' })

  // supabase/postgres runs its init scripts against a temporary server,
  // then SHUTS THAT SERVER DOWN and starts the real one. Waiting on
  // pg_isready alone is a race: it answers yes during the init server's
  // life, and a schema load started then dies with "terminating connection
  // due to administrator command" partway through.
  //
  // An earlier version required five consecutive successful pings, which
  // only made the race less likely — five seconds of uptime is easily
  // satisfied before the shutdown. Waiting for the image's own
  // init-complete line is deterministic instead of hopeful.
  const MARKER = 'PostgreSQL init process complete'
  let initDone = false
  for (let i = 0; i < 180; i++) {
    const logs = docker(['logs', CONTAINER], { stdio: ['ignore', 'pipe', 'pipe'] })
    if (logs.includes(MARKER)) { initDone = true; break }
    execSync('sleep 1', { stdio: 'ignore' })
  }
  if (!initDone) throw new Error('Postgres init never completed')

  // Then the real server still has to come up.
  let streak = 0
  for (let i = 0; i < 60; i++) {
    try {
      docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' })
      if (++streak >= 3) return
    } catch { streak = 0 }
    execSync('sleep 1', { stdio: 'ignore' })
  }
  throw new Error('Postgres never became ready')
}

function loadSchema() {
  // GoTrue normally creates these; the tests do not run it, so stand in
  // with the minimum the schema depends on. auth.uid() reads a session
  // setting so a test can act as different signed-in users.
  psql(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.uid', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `)

  psql(readFileSync(join(DB, 'schema.sql'), 'utf8'))
  psql(readFileSync(join(DB, 'seed.sql'), 'utf8'))
  for (const f of readdirSync(join(DB, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    psql(readFileSync(join(DB, 'migrations', f), 'utf8'))
  }

  // Supabase's own image grants these to its roles before any app schema
  // loads; a bare container has not, and without them every RLS test fails
  // as "permission denied" rather than testing the policy.
  psql(`
    grant usage on schema public to anon, authenticated, service_role;
    grant all on all tables in schema public to anon, authenticated, service_role;
    grant all on all sequences in schema public to anon, authenticated, service_role;
  `)

  // The assertion helper every test file uses.
  psql(`
    create or replace function assert(ok boolean, what text)
    returns void language plpgsql as $$
    begin
      if ok is not true then
        raise exception 'ASSERTION FAILED: %', what;
      end if;
    end $$;

    -- Asserts that a statement is rejected. Takes the SQL as text because
    -- the point is to run something that raises and survive it.
    create or replace function assert_rejected(stmt text, what text)
    returns void language plpgsql as $$
    begin
      begin
        execute stmt;
      exception when others then
        return;  -- rejected as intended
      end;
      raise exception 'ASSERTION FAILED: expected rejection but statement succeeded: %', what;
    end $$;
  `)
}

/** Wipes data between files so tests cannot depend on each other's rows. */
function truncateAll() {
  psql(`
    truncate organizations, org_creation_allowlist, state_rent_regulations
      restart identity cascade;
    truncate auth.users cascade;
  `)
  psql(readFileSync(join(DB, 'seed.sql'), 'utf8'))
}

let failed = 0
try {
  start()
  loadSchema()

  const files = readdirSync(HERE)
    .filter((f) => f.endsWith('.test.sql'))
    .filter((f) => f.includes(filter))
    .sort()

  if (files.length === 0) {
    console.error(red(`no test files matched "${filter}"`))
    process.exit(1)
  }

  for (const f of files) {
    truncateAll()
    process.stdout.write(`  ${f} … `)
    try {
      psql(readFileSync(join(HERE, f), 'utf8'))
      console.log(green('pass'))
    } catch (e) {
      failed++
      console.log(red('FAIL'))
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim()
      console.log(out.split('\n').filter((l) => l.includes('ERROR') || l.includes('ASSERTION'))
        .map((l) => `      ${l}`).join('\n') || `      ${e.message}`)
    }
  }
} finally {
  try { docker(['rm', '-f', CONTAINER], { stdio: 'ignore' }) } catch { /* already gone */ }
}

console.log(failed === 0 ? green('\nAll database tests passed.') : red(`\n${failed} file(s) failed.`))
process.exit(failed === 0 ? 0 : 1)
