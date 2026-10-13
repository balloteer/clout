import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import postgres from 'postgres'

export const PROJECT_REF = 'qsboauxywnuhitlpmojw'
export const MIGRATION = '20261013000133_clout_initial.sql'
const CLI_VERSION = '2.120.0'
const root = fileURLToPath(new URL('../', import.meta.url))

export class SetupError extends Error {}

export function validateTarget(value) {
  if (!value) throw new SetupError('DATABASE_URL is missing. Save it in ignored apps/api/.env.local.')
  let url
  try {
    url = new URL(value)
  } catch {
    throw new SetupError('DATABASE_URL must be a valid percent-encoded Postgres connection string.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.pathname !== '/postgres' || url.hash)
    throw new SetupError('Use the project’s Postgres database connection string, not its API URL.')
  const direct = url.hostname === `db.${PROJECT_REF}.supabase.co`
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
  let user, password
  try {
    user = decodeURIComponent(url.username)
    password = decodeURIComponent(url.password)
  } catch {
    throw new SetupError('Percent-encode reserved characters in the database credentials.')
  }
  if (
    (!direct && !pooler) ||
    (direct && user !== 'postgres') ||
    (pooler && user !== `postgres.${PROJECT_REF}`)
  )
    throw new SetupError(`Connection rejected: it must identify project ${PROJECT_REF}.`)
  if (!password || /\[YOUR-PASSWORD\]|YOUR_PASSWORD|replace.?me/i.test(password))
    throw new SetupError('Replace the database password placeholder in apps/api/.env.local.')
  if (!['', '5432', '6543'].includes(url.port))
    throw new SetupError('Use a Supabase Postgres port (5432 or 6543).')
  if ([...url.searchParams.keys()].some((key) => key !== 'sslmode'))
    throw new SetupError('Remove unsupported connection options; this command enforces TLS itself.')
  if (
    url.searchParams.has('sslmode') &&
    !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode'))
  )
    throw new SetupError('An encrypted TLS database connection is required.')
  url.search = '?sslmode=verify-full'
  return { url, password, kind: pooler ? 'shared-pooler' : 'direct', projectRef: PROJECT_REF }
}

export function migrationConnection(target) {
  const url = new URL(target.url)
  // A migration is one session. The same Supabase host/credentials use 5432 for direct/session mode.
  url.port = '5432'
  return { ...target, url }
}

export function cliConnection(target) {
  const url = new URL(target.url)
  url.password = ''
  return { url: url.toString(), password: target.password }
}

export function redact(value, secrets) {
  let result = String(value)
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length))
    result = result.replaceAll(secret, '[REDACTED]')
  return result
}

export function expectedTables(migration) {
  const names = [...migration.matchAll(/^create table ((?:public|private)\.[a-z_]+)\s*\(/gim)].map(
    (match) => match[1],
  )
  if (names.length !== 13 || new Set(names).size !== names.length)
    throw new SetupError('Unexpected initial migration table set; review the migration before setup.')
  return names
}

export function assertInitialMigrationSafe(snapshot) {
  if (!snapshot.supabaseRolesPresent)
    throw new SetupError('Required Supabase anon/authenticated roles are missing.')
  if (snapshot.migrationApplied) {
    if (
      snapshot.targetTables.length !== snapshot.expectedTableCount ||
      snapshot.targetTables.some(
        (table) =>
          !table.rls ||
          table.anonWrite ||
          table.authenticatedWrite ||
          (table.name.startsWith('private.') && (table.anonRead || table.authenticatedRead)),
      ) ||
      snapshot.privateClientAccess
    )
      throw new SetupError(
        'Recorded migration does not match the expected protected table set; stop and inspect schema drift.',
      )
    return 'already-applied'
  }
  if (
    snapshot.targetTables.length ||
    snapshot.unrelatedRelationCount ||
    snapshot.privateFunctionCount ||
    snapshot.privateSchemaExists
  )
    throw new SetupError(
      'Initial migration requires empty application schemas. Existing tables, relations or private schema require review; nothing was changed.',
    )
  return 'ready'
}

export async function inspectDatabase(sql, tables, migrationName = MIGRATION) {
  return sql.begin('read only', async (tx) => {
    await tx`set local statement_timeout = '15s'`
    const relations =
      await tx`select n.nspname || '.' || c.relname as name, c.relrowsecurity as rls, case when c.relkind = 'S' then false else has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end as anon_write, case when c.relkind = 'S' then false else has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') end as authenticated_write, case when c.relkind = 'S' then false else has_table_privilege('anon', c.oid, 'SELECT') end as anon_read, case when c.relkind = 'S' then false else has_table_privilege('authenticated', c.oid, 'SELECT') end as authenticated_read from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'private') and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') order by 1`
    const [metadata] =
      await tx`select current_database() as database, exists(select 1 from pg_namespace where nspname = 'private') as private_schema, case when exists(select 1 from pg_namespace where nspname = 'private') then has_schema_privilege('anon', 'private', 'USAGE') or has_schema_privilege('authenticated', 'private', 'USAGE') else false end as private_client_access, (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private') as private_functions, (select count(*)::int from pg_roles where rolname in ('anon','authenticated')) = 2 as roles, to_regclass('supabase_migrations.schema_migrations') is not null as history`
    const history = metadata.history
      ? await tx`select version from supabase_migrations.schema_migrations where version = ${migrationName.split('_')[0]}`
      : []
    return {
      projectRef: PROJECT_REF,
      database: metadata.database,
      readOnly: true,
      expectedTableCount: tables.length,
      targetTables: relations
        .filter((row) => tables.includes(row.name))
        .map((row) => ({
          name: row.name,
          rls: row.rls,
          anonWrite: row.anon_write,
          authenticatedWrite: row.authenticated_write,
          anonRead: row.anon_read,
          authenticatedRead: row.authenticated_read,
        })),
      unrelatedRelationCount: relations.filter((row) => !tables.includes(row.name)).length,
      privateSchemaExists: metadata.private_schema,
      privateClientAccess: metadata.private_client_access,
      privateFunctionCount: metadata.private_functions,
      supabaseRolesPresent: metadata.roles,
      migrationApplied: history.length === 1,
    }
  })
}

export function connection(url) {
  return postgres(url.toString(), {
    ssl: 'verify-full',
    prepare: false,
    max: 1,
    connect_timeout: 10,
    idle_timeout: 5,
    onnotice: () => {},
  })
}

export async function runCli(args, target, workspace) {
  const credentials = target ? cliConnection(target) : null
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, CI: 'true' }
  if (credentials) {
    env.PGPASSWORD = credentials.password
    env.SUPABASE_DB_PASSWORD = credentials.password
  }
  const secrets = credentials
    ? [credentials.password, encodeURIComponent(credentials.password), target.url.toString()]
    : []
  const result = await new Promise((resolveResult, reject) => {
    const child = spawn('npx', ['--yes', `supabase@${CLI_VERSION}`, ...args, '--workdir', workspace], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.once('error', reject)
    child.once('exit', (code) => resolveResult({ code, output: redact(output, secrets) }))
  })
  if (result.output.trim()) console.log(result.output.trim())
  if (result.code !== 0)
    throw new SetupError(
      'Supabase CLI did not complete. Review the redacted diagnostic above; no automatic retry or reset was attempted.',
    )
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'Read-only: node --env-file=apps/api/.env.local scripts/db-setup.mjs\nApply initial migration: append --apply\nOnly project qsboauxywnuhitlpmojw is accepted. Passwords never enter CLI arguments.',
    )
    return
  }
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new SetupError(
      'Use no arguments for read-only checks, or --apply for the reviewed initial migration.',
    )
  const apply = args.includes('--apply')
  const original = validateTarget(process.env.DATABASE_URL)
  const target = apply ? migrationConnection(original) : original
  const migration = await readFile(resolve(root, 'supabase/migrations', MIGRATION), 'utf8')
  const tables = expectedTables(migration)
  const digest = createHash('sha256').update(migration).digest('hex')
  const sql = connection(target.url)
  try {
    const before = await inspectDatabase(sql, tables)
    let readiness
    try {
      readiness = assertInitialMigrationSafe(before)
    } catch {
      readiness = 'review-required'
    }
    console.log(
      JSON.stringify(
        {
          ...before,
          initialMigrationState: readiness,
          connectionMode: target.kind,
          port: target.url.port || '5432',
          migration: MIGRATION,
          migrationSha256: digest,
        },
        null,
        2,
      ),
    )
    if (!apply) return
    if (assertInitialMigrationSafe(before) === 'already-applied') {
      console.log('Initial migration is already recorded; no writes performed.')
      return
    }
    const workspace = await mkdtemp(join(tmpdir(), 'clout-db-setup-'))
    try {
      await runCli(['init'], null, workspace)
      const folder = join(workspace, 'supabase/migrations')
      await mkdir(folder, { recursive: true })
      await writeFile(join(folder, MIGRATION), migration, { mode: 0o600 })
      // Stage only the reviewed initial migration; never push unrelated local migrations/seeds/vault values.
      const args = ['db', 'push', '--db-url', cliConnection(target).url, '--skip-vault', '--yes']
      await runCli([...args, '--dry-run'], target, workspace)
      const latest = await inspectDatabase(sql, tables)
      if (assertInitialMigrationSafe(latest) === 'already-applied') {
        console.log('Another operator applied the migration; no writes performed.')
        return
      }
      await runCli(args, target, workspace)
      const after = await inspectDatabase(sql, tables)
      if (!after.migrationApplied || assertInitialMigrationSafe(after) !== 'already-applied')
        throw new SetupError(
          'Post-migration verification failed. Inspect the project before starting the API.',
        )
      console.log(
        JSON.stringify(
          {
            projectRef: PROJECT_REF,
            applied: MIGRATION,
            protectedTables: after.targetTables.length,
            verified: true,
          },
          null,
          2,
        ),
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const knownCodes = new Set([
      '28P01',
      'ENOTFOUND',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
    ])
    console.error(
      error instanceof SetupError
        ? error.message
        : `Database setup failed${knownCodes.has(error?.code) ? ` (${error.code})` : ''}. Credentials and raw connection errors were not printed.`,
    )
    process.exitCode = 1
  })
}
