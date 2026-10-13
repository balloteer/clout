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
  connection,
  runCli,
} from './db-setup.mjs'
import { LINKED_MIGRATION, linkedTables, inspectGuards, assertLinkedMigrationSafe } from './db-linked.mjs'

export const FAUCET_MIGRATION = '20261013051351_daily_faucet.sql'
const faucetTables = ['private.faucet_budgets']
const root = fileURLToPath(new URL('../', import.meta.url))

export async function inspectFaucetGuards(sql) {
  return sql.begin('read only', async (tx) => {
    const [result] = await tx`select
      exists(select 1 from information_schema.columns where table_schema='private' and table_name='reward_claims' and column_name='claim_day' and data_type='date') as day_column,
      to_regprocedure('private.reserve_daily_faucet(text,text,uuid)') is not null as function_present,
      coalesce((select not p.prosecdef and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
        from pg_proc p where p.oid=to_regprocedure('private.reserve_daily_faucet(text,text,uuid)')),false) as function_restricted,
      (select count(*)::int from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='private' and c.relname in ('reward_claims_once_sgt_idx','reward_claims_once_wallet_idx','reward_claims_daily_wallet_idx') and i.indisunique and i.indisvalid) as unique_indexes,
      exists(select 1 from pg_constraint where conrelid=to_regclass('private.reward_claims') and conname='reward_claim_day_matches' and convalidated) as day_constraint`
    return {
      dayColumn: result.day_column,
      functionPresent: result.function_present,
      functionRestricted: result.function_restricted,
      uniqueIndexes: result.unique_indexes,
      dayConstraint: result.day_constraint,
    }
  })
}
export function assertFaucetMigrationSafe(initial, linked, linkedGuards, faucet, guards) {
  if (assertLinkedMigrationSafe(initial, linked, linkedGuards) !== 'already-applied')
    throw new SetupError('Apply and verify the initial and linked-account migrations first.')
  if (
    faucet.privateClientAccess ||
    faucet.unrelatedRelationCount !== initial.expectedTableCount + linked.expectedTableCount
  )
    throw new SetupError('Unexpected schema objects or private grants require review.')
  if (faucet.migrationApplied) {
    if (
      faucet.targetTables.length !== 1 ||
      faucet.targetTables.some(
        (table) =>
          !table.rls ||
          table.anonRead ||
          table.anonWrite ||
          table.authenticatedRead ||
          table.authenticatedWrite,
      ) ||
      !guards.dayColumn ||
      !guards.functionRestricted ||
      guards.uniqueIndexes !== 3 ||
      !guards.dayConstraint
    )
      throw new SetupError('Daily faucet schema/security drift; no writes performed.')
    return 'already-applied'
  }
  if (
    faucet.targetTables.length ||
    guards.dayColumn ||
    guards.functionPresent ||
    guards.uniqueIndexes ||
    guards.dayConstraint
  )
    throw new SetupError(
      'Partial daily faucet schema exists without migration history. Inspect it before applying.',
    )
  return 'ready'
}
export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(
      'Read-only daily faucet schema check: node --env-file=apps/api/.env.local scripts/db-faucet.mjs\nAppend --apply to apply only the reviewed daily faucet migration after the initial and linked migrations. Target: qsboauxywnuhitlpmojw.',
    )
    return
  }
  if (args.some((arg) => arg !== '--apply') || args.length > 1)
    throw new SetupError('Use no arguments for a read-only check, or --apply.')
  const apply = args.includes('--apply')
  const supplied = validateTarget(process.env.DATABASE_URL)
  const target = apply ? migrationConnection(supplied) : supplied
  const migrations = await Promise.all(
    [MIGRATION, LINKED_MIGRATION, FAUCET_MIGRATION].map(async (name) => ({
      name,
      content: await readFile(join(root, 'supabase/migrations', name), 'utf8'),
    })),
  )
  const daily = migrations[2].content
  const tables = [...daily.matchAll(/^create table (private\.[a-z_]+)\s*\(/gim)].map((match) => match[1])
  if (JSON.stringify(tables) !== JSON.stringify(faucetTables))
    throw new SetupError('Daily migration table list changed; review before applying.')
  const sql = connection(target.url)
  const inspect = async () => {
    // One connection; these reads deliberately run sequentially.
    const initial = await inspectDatabase(sql, expectedTables(migrations[0].content))
    const linked = await inspectDatabase(sql, linkedTables, LINKED_MIGRATION)
    const linkedGuards = await inspectGuards(sql)
    const faucet = await inspectDatabase(sql, faucetTables, FAUCET_MIGRATION)
    const guards = await inspectFaucetGuards(sql)
    return { initial, linked, linkedGuards, faucet, guards }
  }
  const readiness = (state) =>
    assertFaucetMigrationSafe(state.initial, state.linked, state.linkedGuards, state.faucet, state.guards)
  try {
    const before = await inspect()
    let status = 'review-required'
    try {
      status = readiness(before)
    } catch {
      /* Report in read-only mode. */
    }
    console.log(
      JSON.stringify(
        {
          projectRef: PROJECT_REF,
          readOnly: true,
          migration: FAUCET_MIGRATION,
          migrationSha256: createHash('sha256').update(daily).digest('hex'),
          readiness: status,
          tables: before.faucet.targetTables,
          guards: before.guards,
        },
        null,
        2,
      ),
    )
    if (!apply) return
    if (readiness(before) === 'already-applied') {
      console.log('Daily faucet migration already verified; no writes performed.')
      return
    }
    const workspace = await mkdtemp(join(tmpdir(), 'clout-db-faucet-'))
    try {
      await runCli(['init'], null, workspace)
      const directory = join(workspace, 'supabase/migrations')
      await mkdir(directory, { recursive: true })
      for (const file of migrations)
        await writeFile(join(directory, file.name), file.content, { mode: 0o600 })
      const push = ['db', 'push', '--db-url', cliConnection(target).url, '--skip-vault', '--yes']
      await runCli([...push, '--dry-run'], target, workspace)
      if (readiness(await inspect()) === 'already-applied') {
        console.log('Migration applied by another operator; no writes performed.')
        return
      }
      await runCli(push, target, workspace)
      if (readiness(await inspect()) !== 'already-applied')
        throw new SetupError('Post-migration verification failed. Inspect before enabling the faucet.')
      console.log(JSON.stringify({ projectRef: PROJECT_REF, applied: FAUCET_MIGRATION, verified: true }))
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
        : 'Daily migration check failed. Credentials and raw connection errors were not printed.',
    )
    process.exitCode = 1
  })
