import { createHash } from 'node:crypto'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  PROJECT_REF,
  MIGRATION,
  SetupError,
  validateTarget,
  migrationConnection,
  cliConnection,
  expectedTables,
  inspectDatabase,
  assertInitialMigrationSafe,
  connection,
  runCli,
} from './db-setup.mjs'
export const LINKED_MIGRATION = '20261013020605_linked_accounts.sql'
export const linkedTables = ['private.link_oauth', 'private.linked_accounts', 'private.link_imports']
const root = fileURLToPath(new URL('../', import.meta.url))
export function assertLinkedMigrationSafe(initial, linked, guards) {
  if (assertInitialMigrationSafe(initial) !== 'already-applied')
    throw new SetupError('Apply and verify the reviewed initial migration first.')
  if (
    linked.privateClientAccess ||
    (!linked.migrationApplied && linked.unrelatedRelationCount !== initial.expectedTableCount)
  )
    throw new SetupError('Unexpected schema objects or private client grants require review.')
  if (linked.migrationApplied) {
    if (
      linked.targetTables.length !== 3 ||
      linked.targetTables.some(
        (table) =>
          !table.rls ||
          table.anonRead ||
          table.authenticatedRead ||
          table.anonWrite ||
          table.authenticatedWrite,
      ) ||
      !guards.limitTrigger ||
      !guards.uniqueStream ||
      !guards.functionRestricted
    )
      throw new SetupError('Linked-account migration has schema/security drift; no writes performed.')
    return 'already-applied'
  }
  if (linked.targetTables.length || guards.functionPresent || guards.limitTrigger || guards.uniqueStream)
    throw new SetupError(
      'Partial linked-account schema exists without recorded migration. Inspect it before applying.',
    )
  return 'ready'
}
export async function inspectGuards(sql) {
  return sql.begin('read only', async (tx) => {
    const [result] =
      await tx`select to_regprocedure('private.enforce_link_limit()') is not null as function_present, exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='linked_accounts' and t.tgname='linked_accounts_limit' and t.tgenabled in ('O','A')) as limit_trigger, exists(select 1 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='private' and c.relname='link_imports_stream' and i.indisunique and i.indisvalid) as unique_stream, coalesce((select not p.prosecdef and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='enforce_link_limit'),false) as function_restricted`
    return {
      functionPresent: result.function_present,
      limitTrigger: result.limit_trigger,
      uniqueStream: result.unique_stream,
      functionRestricted: result.function_restricted,
    }
  })
}
export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log(
      'Read-only linked-account migration check: node --env-file=apps/api/.env.local scripts/db-linked.mjs\nAppend --apply to apply only the reviewed linked-account migration after the initial migration. Target: qsboauxywnuhitlpmojw.',
    )
    return
  }
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new SetupError('Use no arguments for a read-only check, or --apply.')
  const apply = args.includes('--apply')
  const supplied = validateTarget(process.env.DATABASE_URL)
  const target = apply ? migrationConnection(supplied) : supplied
  const initial = await readFile(join(root, 'supabase/migrations', MIGRATION), 'utf8')
  const linked = await readFile(join(root, 'supabase/migrations', LINKED_MIGRATION), 'utf8')
  const parsed = [...linked.matchAll(/^create table (private\.[a-z_]+)\s*\(/gim)]
    .map((match) => match[1])
    .sort()
  if (JSON.stringify(parsed) !== JSON.stringify([...linkedTables].sort()))
    throw new SetupError('Linked migration table list changed; review before applying.')
  const sql = connection(target.url)
  const inspect = async () => ({
    initial: await inspectDatabase(sql, expectedTables(initial)),
    linked: await inspectDatabase(sql, linkedTables, LINKED_MIGRATION),
    guards: await inspectGuards(sql),
  })
  try {
    const before = await inspect()
    let readiness = 'review-required'
    try {
      readiness = assertLinkedMigrationSafe(before.initial, before.linked, before.guards)
    } catch {
      /* report details in read-only mode */
    }
    console.log(
      JSON.stringify(
        {
          projectRef: PROJECT_REF,
          readOnly: true,
          migration: LINKED_MIGRATION,
          migrationSha256: createHash('sha256').update(linked).digest('hex'),
          readiness,
          tables: before.linked.targetTables,
          guards: before.guards,
        },
        null,
        2,
      ),
    )
    if (!apply) return
    if (assertLinkedMigrationSafe(before.initial, before.linked, before.guards) === 'already-applied') {
      console.log('Linked-account migration already verified; no writes performed.')
      return
    }
    const workspace = await mkdtemp(join(tmpdir(), 'clout-db-links-'))
    try {
      await runCli(['init'], null, workspace)
      const directory = join(workspace, 'supabase/migrations')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, MIGRATION), initial, { mode: 0o600 })
      await writeFile(join(directory, LINKED_MIGRATION), linked, { mode: 0o600 })
      const push = ['db', 'push', '--db-url', cliConnection(target).url, '--skip-vault', '--yes']
      await runCli([...push, '--dry-run'], target, workspace)
      const latest = await inspect()
      if (assertLinkedMigrationSafe(latest.initial, latest.linked, latest.guards) === 'already-applied') {
        console.log('Migration applied by another operator; no writes performed.')
        return
      }
      await runCli(push, target, workspace)
      const after = await inspect()
      if (assertLinkedMigrationSafe(after.initial, after.linked, after.guards) !== 'already-applied')
        throw new SetupError(
          'Post-migration verification failed. Inspect the project before enabling linked accounts.',
        )
      console.log(JSON.stringify({ projectRef: PROJECT_REF, applied: LINKED_MIGRATION, verified: true }))
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
        : 'Linked migration check failed. Credentials and raw connection errors were not printed.',
    )
    process.exitCode = 1
  })
