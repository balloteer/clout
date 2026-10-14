import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PROJECT_REF,
  MIGRATION,
  SetupError,
  cliConnection,
  connection,
  inspectDatabase,
  migrationConnection,
  runCli,
  validateTarget,
} from './db-setup.mjs'
import { LINKED_MIGRATION } from './db-linked.mjs'
import { FAUCET_MIGRATION } from './db-faucet.mjs'

export const UPLOAD_RECOVERY_MIGRATION = '20261013090000_upload_recovery_checks.sql'
const table = 'private.upload_recovery_checks'
const root = fileURLToPath(new URL('../', import.meta.url))
const migrations = [MIGRATION, LINKED_MIGRATION, FAUCET_MIGRATION, UPLOAD_RECOVERY_MIGRATION]

async function inspect(sql) {
  const snapshot = await inspectDatabase(sql, [table], UPLOAD_RECOVERY_MIGRATION)
  const [guards] = await sql`select
    (select count(*)::int from supabase_migrations.schema_migrations where version = any(${migrations
      .slice(0, -1)
      .map((name) => name.split('_')[0])}::text[])) as prior_migrations,
    exists(select 1 from pg_constraint where conrelid=to_regclass(${table}) and contype='f') as post_foreign_key,
    to_regclass('private.upload_recovery_checks_checked_idx') is not null as checked_index`
  return { snapshot, guards }
}

function readiness({ snapshot, guards }) {
  if (guards.prior_migrations !== migrations.length - 1)
    throw new SetupError('Apply and verify the first three Clout migrations before upload recovery.')
  if (snapshot.migrationApplied) {
    const row = snapshot.targetTables[0]
    if (
      snapshot.targetTables.length !== 1 ||
      !row.rls ||
      row.anonRead ||
      row.anonWrite ||
      row.authenticatedRead ||
      row.authenticatedWrite ||
      snapshot.privateClientAccess ||
      !guards.post_foreign_key ||
      !guards.checked_index
    )
      throw new SetupError('Upload recovery schema/security drift; no writes performed.')
    return 'already-applied'
  }
  if (snapshot.targetTables.length || guards.post_foreign_key || guards.checked_index)
    throw new SetupError('Partial upload recovery schema exists without migration history.')
  return 'ready'
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new SetupError('Use no arguments for a read-only check, or --apply.')
  const apply = args.includes('--apply')
  const supplied = validateTarget(process.env.DATABASE_URL)
  const target = apply ? migrationConnection(supplied) : supplied
  const files = await Promise.all(
    migrations.map(async (name) => ({
      name,
      content: await readFile(join(root, 'supabase/migrations', name), 'utf8'),
    })),
  )
  const sql = connection(target.url)
  try {
    const before = await inspect(sql)
    let status = 'review-required'
    try {
      status = readiness(before)
    } catch {
      /* The read-only report remains useful without exposing a raw database error. */
    }
    console.log(
      JSON.stringify({
        projectRef: PROJECT_REF,
        readOnly: true,
        migration: UPLOAD_RECOVERY_MIGRATION,
        migrationSha256: createHash('sha256').update(files.at(-1).content).digest('hex'),
        readiness: status,
        table: before.snapshot.targetTables,
        guards: before.guards,
      }),
    )
    if (!apply) return
    if (readiness(before) === 'already-applied') {
      console.log('Upload recovery migration already verified; no writes performed.')
      return
    }
    const workspace = await mkdtemp(join(tmpdir(), 'clout-upload-recovery-'))
    try {
      await runCli(['init'], null, workspace)
      const directory = join(workspace, 'supabase/migrations')
      await mkdir(directory, { recursive: true })
      for (const file of files) await writeFile(join(directory, file.name), file.content, { mode: 0o600 })
      const push = ['db', 'push', '--db-url', cliConnection(target).url, '--skip-vault', '--yes']
      await runCli([...push, '--dry-run'], target, workspace)
      if (readiness(await inspect(sql)) !== 'already-applied') await runCli(push, target, workspace)
      if (readiness(await inspect(sql)) !== 'already-applied')
        throw new SetupError('Post-migration verification failed.')
      console.log(
        JSON.stringify({ projectRef: PROJECT_REF, applied: UPLOAD_RECOVERY_MIGRATION, verified: true }),
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  } finally {
    await sql.end({ timeout: 5 })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(
      error instanceof SetupError
        ? error.message
        : 'Upload recovery migration failed. Credentials and raw connection errors were not printed.',
    )
    process.exitCode = 1
  })
