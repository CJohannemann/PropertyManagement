// A throwaway Postgres for the server tests, loaded with the real schema,
// seed and migrations.
//
// Uses the same supabase/postgres image as db/test/run.mjs, for the same
// reason: testing against a different database than production is testing
// something else. Published on a localhost port, because the code under
// test connects over TCP with node-postgres just as it does in production.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DB = join(HERE, '..', '..', 'db')
const IMAGE = 'supabase/postgres:15.1.1.78'

export const red = (s) => `\x1b[31m${s}\x1b[0m`
export const green = (s) => `\x1b[32m${s}\x1b[0m`
export const dim = (s) => `\x1b[2m${s}\x1b[0m`

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', ...opts })

/**
 * Starts the container and loads the schema. Returns `psql` for setting up
 * fixtures and reading state back, the URL the API should connect to, and
 * `stop` to remove the container.
 */
export function startTestDb({ container, port }) {
  const psql = (sql) =>
    execFileSync(
      'docker',
      ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1', '-qtAX'],
      { input: `set client_min_messages = warning;\n${sql}`, encoding: 'utf8' },
    )

  const stop = () => {
    try { docker(['rm', '-f', container], { stdio: 'ignore' }) } catch { /* already gone */ }
  }

  stop()
  console.log(dim(`starting ${IMAGE}…`))
  docker(
    ['run', '-d', '--name', container, '-e', 'POSTGRES_PASSWORD=test',
      '-p', `127.0.0.1:${port}:5432`, IMAGE],
    { stdio: 'ignore' },
  )

  // supabase/postgres runs init scripts against a temporary server, then
  // shuts it down and starts the real one — so pg_isready alone is a race.
  // Wait for the image's own init-complete line first. Same reasoning as
  // db/test/run.mjs; see its comment for the full story.
  const MARKER = 'PostgreSQL init process complete'
  let initDone = false
  for (let i = 0; i < 180; i++) {
    if (docker(['logs', container], { stdio: ['ignore', 'pipe', 'pipe'] }).includes(MARKER)) {
      initDone = true
      break
    }
    execFileSync('sleep', ['1'])
  }
  if (!initDone) throw new Error('Postgres init never completed')

  let ready = false
  let streak = 0
  for (let i = 0; i < 60 && !ready; i++) {
    try {
      docker(['exec', container, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' })
      if (++streak >= 3) ready = true
    } catch { streak = 0 }
    if (!ready) execFileSync('sleep', ['1'])
  }
  if (!ready) throw new Error('Postgres never became ready')

  // GoTrue normally creates these; stand in with the minimum the schema
  // depends on, same as db/test/run.mjs.
  psql(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key default gen_random_uuid(), email text);
    create or replace function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.uid', true), '')::uuid;
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
  `)
  psql(readFileSync(join(DB, 'schema.sql'), 'utf8'))
  psql(readFileSync(join(DB, 'seed.sql'), 'utf8'))
  for (const f of readdirSync(join(DB, 'migrations')).filter((f) => f.endsWith('.sql')).sort()) {
    psql(readFileSync(join(DB, 'migrations', f), 'utf8'))
  }

  return { psql, stop, url: `postgres://postgres:test@127.0.0.1:${port}/postgres` }
}
