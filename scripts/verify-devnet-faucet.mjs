#!/usr/bin/env node
// node scripts/verify-devnet-faucet.mjs [--execute | --self-test]
// --execute is the only mode that signs, sends, creates a recipient, or opens the persistent DB.
import assert from 'node:assert/strict'
import { createPrivateKey, sign } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { PGlite } from '@electric-sql/pglite'
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import bs58 from 'bs58'
import { tsImport } from 'tsx/esm/api'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = resolve(root, '.tooling/devnet/faucet-rehearsal')
const journalPath = resolve(directory, 'journal.json')
const keyPath = resolve(directory, 'recipient.json')
const evidencePath = resolve(root, 'artifacts/devnet-faucet-rehearsal.json')
const expectedMint = '8sRfkBQg3u38JFZ36poZCuBeiytksTCKHHs3Kz4eiXmC'
const expectedAuthority = 'H8xYY5wr3o8Q4xKK8NDZSf9vb7vxuVvZcgHws9t7kge3'
const expectedGenesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
const amount = '1000000000'
const day = () => new Date().toISOString().slice(0, 10)
let phase = 'startup'

/** Serialize whole real PGlite transactions and standalone queries, including concurrent HTTP handlers. */
export function createPgliteSql(db) {
  let tail = Promise.resolve()
  const exclusive = (work) => {
    const result = tail.then(work)
    tail = result.catch(() => {})
    return result
  }
  const tag = (client, schedule) => {
    const sql = (parts, ...values) => {
      const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '')
      return schedule(async () => (await client.query(query, values)).rows)
    }
    sql.json = JSON.stringify
    return sql
  }
  const sql = tag(db, exclusive)
  sql.begin = (callback) => exclusive(() => db.transaction((tx) => callback(tag(tx, (work) => work()))))
  return sql
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function durableJson(path, value, mode = 0o600) {
  const temporary = `${path}.${process.pid}.tmp`
  const handle = await open(temporary, 'w', mode)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  await chmod(path, mode)
  const folder = await open(dirname(path), 'r')
  try {
    await folder.sync()
  } finally {
    await folder.close()
  }
}

async function migrate(db) {
  await db.exec(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
    end $$;
    create table if not exists public.clout_rehearsal_migrations (name text primary key);
  `)
  const folder = resolve(root, 'supabase/migrations')
  for (const name of (await readdir(folder)).filter((file) => file.endsWith('.sql')).sort()) {
    if (
      (await db.query('select name from public.clout_rehearsal_migrations where name = $1', [name])).rows
        .length
    )
      continue
    const source = await readFile(resolve(folder, name), 'utf8')
    assert(
      /^\s*begin;/i.test(source) && /commit;\s*$/i.test(source),
      'Expected one outer migration transaction.',
    )
    const body = source.replace(/^\s*begin;/i, '').replace(/commit;\s*$/i, '')
    await db.transaction(async (tx) => {
      await tx.exec(body)
      await tx.query('insert into public.clout_rehearsal_migrations (name) values ($1)', [name])
    })
  }
}

async function selfTest() {
  const db = new PGlite()
  const sql = createPgliteSql(db)
  const order = []
  try {
    await db.exec('create table ordering (value integer)')
    await Promise.all([
      sql.begin(async (tx) => {
        order.push('first-start')
        await tx`insert into ordering values (${1})`
        await new Promise((done) => setTimeout(done, 20))
        order.push('first-end')
      }),
      sql.begin(async (tx) => {
        order.push('second-start')
        assert.equal((await tx`select * from ordering`).length, 1)
        await tx`insert into ordering values (${2})`
        order.push('second-end')
      }),
    ])
    assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
    await assert.rejects(
      sql.begin(async (tx) => {
        await tx`insert into ordering values (${3})`
        throw new Error('rollback probe')
      }),
      /rollback probe/,
    )
    assert.equal((await sql`select * from ordering`).length, 2)
    await migrate(db)
    await migrate(db)
    assert.equal(
      (await db.query('select * from public.clout_rehearsal_migrations')).rows.length,
      (await readdir(resolve(root, 'supabase/migrations'))).filter((file) => file.endsWith('.sql')).length,
    )
    console.log(
      'PASS: real PGlite transactions serialize concurrent callers, roll back atomically, and apply tracked production migrations idempotently. No RPC, keys, or chain writes.',
    )
  } finally {
    await db.close()
  }
}

async function main() {
  const args = process.argv.slice(2)
  assert(
    args.length <= 1 && args.every((arg) => ['--execute', '--self-test', '--help'].includes(arg)),
    'Unknown argument',
  )
  if (args.includes('--self-test')) return selfTest()
  if (args.includes('--help')) {
    console.log(
      'Default: read-only plan and persisted public journal. --execute: one actual 1,000 Mock SKR devnet claim through HTTP + durable PGlite SQL, concurrency and restart checks. --self-test: offline transaction adapter check.',
    )
    return
  }
  const execute = args.includes('--execute')
  let journal = await readJson(journalPath)
  if (!execute) {
    console.log(
      JSON.stringify(
        {
          mode: 'read-only-preview',
          network: 'devnet',
          mint: expectedMint,
          authority: expectedAuthority,
          amount: '1000 Mock SKR',
          amountUnits: amount,
          chainWrites: false,
          database: '.tooling/devnet/faucet-rehearsal/db',
          existing: journal
            ? {
                recipient: journal.recipient,
                claimId: journal.claimId,
                state: journal.state,
                day: journal.day,
              }
            : null,
          executeCommand: 'node scripts/verify-devnet-faucet.mjs --execute',
          scope:
            'Backend HTTP/SQL rehearsal using a task-generated software key. This does not verify Seeker hardware or wallet-app identity.',
        },
        null,
        2,
      ),
    )
    return
  }

  assert(
    !journal || journal.day === day(),
    'This rehearsal cannot mint on another UTC day; preserve its journal for read-only review.',
  )
  if (!journal) {
    const databaseExists = await stat(resolve(directory, 'db')).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false
        throw error
      },
    )
    assert(
      !databaseExists,
      'Existing rehearsal DB has no initial-balance journal; restore the journal before proceeding.',
    )
  }
  phase = 'load-isolated-configuration'
  const env = parseEnv(await readFile(resolve(root, 'apps/api/.env.local'), 'utf8'))
  assert.equal(
    env.SKR_DEVNET_MINT,
    expectedMint,
    'Refusing any mint other than the isolated task Mock SKR mint.',
  )
  assert.equal(env.SKR_DECIMALS ?? '6', '6', 'This rehearsal expects six-decimal Mock SKR.')
  assert.equal(env.FAUCET_AMOUNT_UNITS, amount, 'Faucet grant must be exactly 1,000 Mock SKR.')
  const campaignId = env.FAUCET_CAMPAIGN_ID
  assert(campaignId?.startsWith('faucet_'), 'A stable faucet campaign ID is required.')
  const authorityBytes = Buffer.from(env.FAUCET_MINT_AUTHORITY_SECRET_BASE64 ?? '', 'base64')
  assert.equal(authorityBytes.length, 64, 'Missing configured mint-authority key.')
  assert.equal(
    Keypair.fromSecretKey(authorityBytes).publicKey.toBase58(),
    expectedAuthority,
    'Refusing a non-task mint authority.',
  )
  const rpcUrl = env.SOLANA_DEVNET_RPC_URL
  assert(rpcUrl && new URL(rpcUrl).protocol === 'https:', 'A HTTPS devnet RPC is required.')
  const connection = new Connection(rpcUrl, {
    commitment: 'finalized',
    disableRetryOnRateLimit: true,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(20000) }),
  })
  phase = 'verify-devnet-genesis'
  assert.equal(await connection.getGenesisHash(), expectedGenesis, 'Refusing a non-devnet chain.')
  const [{ createApp }, { PostgresRepository }, { FaucetService }, { createMockSkrFaucetAdapter }] =
    await Promise.all([
      tsImport('../apps/api/src/app.ts', import.meta.url),
      tsImport('../apps/api/src/postgres.ts', import.meta.url),
      tsImport('../apps/api/src/faucet.ts', import.meta.url),
      tsImport('../packages/markets/src/index.ts', import.meta.url),
    ])
  const adapter = createMockSkrFaucetAdapter({
    marketConfig: { cluster: 'devnet', rpcUrl, quoteMint: expectedMint, quoteDecimals: 6 },
    secretKeyUint8Array: authorityBytes,
    maxAmountIn: amount,
    maxSupplyIn: env.FAUCET_MAX_SUPPLY_UNITS,
  })
  authorityBytes.fill(0)
  phase = 'validate-mint-authority'
  await adapter.validateBudget({ amountIn: '0' })
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  let recipientBytes = await readJson(keyPath)
  if (!recipientBytes) {
    assert(!journal, 'Recipient key is missing for an existing rehearsal; do not replace it.')
    recipientBytes = Array.from(Keypair.generate().secretKey)
    const file = await open(keyPath, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(recipientBytes))
      await file.sync()
    } finally {
      await file.close()
    }
  }
  assert.equal((await stat(keyPath)).mode & 0o077, 0, 'Recipient key permissions must be 0600.')
  const recipient = Keypair.fromSecretKey(Uint8Array.from(recipientBytes))
  recipientBytes.fill(0)
  const recipientAddress = recipient.publicKey.toBase58()
  const ata = getAssociatedTokenAddressSync(new PublicKey(expectedMint), recipient.publicKey)
  const tokenBalance = async () => {
    const account = await connection.getAccountInfo(ata, 'finalized')
    if (!account) return '0'
    const parsed = await getAccount(connection, ata, 'finalized', TOKEN_PROGRAM_ID)
    assert(parsed.owner.equals(recipient.publicKey) && parsed.mint.toBase58() === expectedMint)
    return parsed.amount.toString()
  }
  if (!journal) {
    phase = 'persist-initial-balance-journal'
    journal = {
      version: 1,
      network: 'devnet',
      mint: expectedMint,
      authority: expectedAuthority,
      recipient: recipientAddress,
      ata: ata.toBase58(),
      campaignId,
      day: day(),
      amountUnits: amount,
      initialBalanceUnits: await tokenBalance(),
      state: 'prepared',
      createdAt: new Date().toISOString(),
      broadcasts: [],
    }
    await durableJson(journalPath, journal)
  }
  assert.equal(journal.recipient, recipientAddress)
  assert.equal(journal.campaignId, campaignId)
  assert.equal(journal.mint, expectedMint)
  assert.equal(journal.amountUnits, amount)
  const campaign = {
    id: campaignId,
    period: 'utc-day',
    symbol: 'SKR',
    mint: expectedMint,
    amount,
    maxClaims: Number(env.FAUCET_MAX_DAILY_CLAIMS ?? env.FAUCET_MAX_CLAIMS),
    enabled: true,
    authority: expectedAuthority,
    maxSupply: env.FAUCET_MAX_SUPPLY_UNITS,
  }
  let running
  const start = async () => {
    phase = 'open-rehearsal-database'
    const db = new PGlite(resolve(directory, 'db'))
    let server
    try {
      phase = 'apply-tracked-migrations'
      await migrate(db)
      const repository = Object.create(PostgresRepository.prototype)
      Object.defineProperty(repository, 'sql', { value: createPgliteSql(db) })
      const transport = {
        treasury: adapter.treasury,
        quoteMint: adapter.quoteMint,
        availableBalance: () => adapter.availableBalance(),
        validateBudget: (input) => adapter.validateBudget(input),
        prepare: (input) => adapter.prepare(input),
        reconcile: (...input) => adapter.reconcile(...input),
        submit: async (bytes) => {
          assert(execute && journal.day === day(), 'Broadcast requires --execute on the original UTC day.')
          const signature = bs58.encode(Transaction.from(Buffer.from(bytes, 'base64')).signature)
          const rows =
            await repository.sql`select data from private.reward_claims where data->>'signature' = ${signature}`
          assert.equal(rows.length, 1, 'Exact signed intent must exist durably before broadcast.')
          assert.equal(rows[0].data.signedTransaction, bytes)
          assert.equal(rows[0].data.wallet, recipientAddress)
          assert.equal(rows[0].data.amount, amount)
          await db.syncToFs(false)
          if (!journal.broadcasts.includes(signature)) journal.broadcasts.push(signature)
          journal.claimId = rows[0].data.id
          await durableJson(journalPath, journal)
          return adapter.submit(bytes)
        },
      }
      const faucet = new FaucetService(repository, campaign, 6, transport)
      phase = 'initialize-faucet-campaign'
      await faucet.initialize()
      const app = createApp({
        repository,
        origin: 'http://127.0.0.1',
        mode: 'connected',
        faucet,
        quoteMint: expectedMint,
        quoteDecimals: 6,
      })
      server = app.server
      phase = 'listen-local-api'
      await new Promise((done, fail) => {
        server.once('error', fail)
        server.listen(0, '127.0.0.1', done)
      })
      const base = `http://127.0.0.1:${server.address().port}`
      let token
      const request = async (path, body) => {
        const response = await fetch(`${base}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        const value = await response.json()
        assert(
          response.ok,
          `HTTP ${response.status} for ${path}: ${value.error?.code ?? value.code ?? 'request failed'}`,
        )
        return value
      }
      phase = 'http-wallet-challenge'
      const challenge = await request('/v1/auth/challenge', { address: recipientAddress })
      const message = Buffer.from(challenge.message)
      const key = createPrivateKey({
        key: Buffer.concat([
          Buffer.from('302e020100300506032b657004220420', 'hex'),
          recipient.secretKey.subarray(0, 32),
        ]),
        format: 'der',
        type: 'pkcs8',
      })
      phase = 'http-wallet-verification'
      const session = await request('/v1/auth/verify', {
        challengeId: challenge.challengeId,
        signature: sign(null, message, key).toString('base64'),
        signedMessage: message.toString('base64'),
      })
      token = session.token
      assert.equal(session.profile.wallet, recipientAddress)
      return {
        db,
        repository,
        faucet,
        request,
        close: async () => {
          await new Promise((done, fail) => server.close((error) => (error ? fail(error) : done())))
          await db.close()
        },
      }
    } catch (error) {
      if (server?.listening) await new Promise((done) => server.close(done))
      await db.close()
      throw error
    }
  }
  try {
    running = await start()
    assert.equal(journal.day, day(), 'Do not cross UTC days during this rehearsal.')
    phase = 'concurrent-http-claims'
    const claims = await Promise.all([
      running.request('/v1/faucet/claims', {}),
      running.request('/v1/faucet/claims', {}),
    ])
    assert.equal(claims[0].id, claims[1].id, 'Concurrent requests created duplicate claims.')
    if (journal.claimId) assert.equal(claims[0].id, journal.claimId)
    journal.claimId = claims[0].id
    await durableJson(journalPath, journal)
    let receipt
    phase = 'reconcile-finalized-claim'
    for (let attempt = 0; attempt < 90; attempt++) {
      await running.faucet.resume()
      receipt = await running.request(`/v1/faucet/claims/${journal.claimId}`)
      if (receipt.state === 'finalized') break
      assert(
        !['expired', 'failed'].includes(receipt.state),
        `Rehearsal payout ${receipt.state}; preserve journal for review.`,
      )
      if (attempt % 10 === 0) console.log(`Waiting for finalized devnet claim (${receipt.state}).`)
      await new Promise((done) => setTimeout(done, 2000))
    }
    assert.equal(receipt.state, 'finalized', 'Finalization timed out; rerun the same journal to reconcile.')
    assert.equal(receipt.amount, amount)
    assert.equal(receipt.day, journal.day)
    const status = await connection.getSignatureStatuses([receipt.signature], {
      searchTransactionHistory: true,
    })
    assert.equal(status.value[0]?.confirmationStatus, 'finalized')
    assert.equal(status.value[0]?.err, null)
    phase = 'verify-finalized-token-balance'
    const balance = await tokenBalance()
    assert.equal(
      BigInt(balance) - BigInt(journal.initialBalanceUnits),
      BigInt(amount),
      'Recipient must receive exactly one 1,000 Mock SKR grant.',
    )
    await running.close()
    running = undefined
    running = await start()
    assert.equal(journal.day, day(), 'Restart test must stay within the original UTC day.')
    phase = 'verify-restart-idempotency'
    const retry = await running.request('/v1/faucet/claims', {})
    assert.equal(retry.id, receipt.id)
    assert.equal(retry.signature, receipt.signature)
    assert.equal(retry.state, 'finalized')
    assert.equal(await tokenBalance(), balance, 'Restart retry must not mint again.')
    const rows = await running.repository
      .sql`select data from private.reward_claims where campaign_id = ${campaignId} and wallet = ${recipientAddress}`
    assert.equal(rows.length, 1)
    const budget = await running.repository.getFaucetBudget(campaignId)
    assert.equal(budget.allocatedUnits, amount)
    journal = {
      ...journal,
      state: 'verified',
      signature: receipt.signature,
      finalBalanceUnits: balance,
      verifiedAt: new Date().toISOString(),
    }
    await durableJson(journalPath, journal)
    const evidence = {
      ...journal,
      checks: {
        concurrentRequestsSameClaim: true,
        finalizedOnDevnet: true,
        exactly1000MockSkrCredited: true,
        databaseReopened: true,
        restartRetrySameClaimAndSignature: true,
        restartNoAdditionalMint: true,
        oneDurableReservation: true,
        lifetimeAllocatedUnits: budget.allocatedUnits,
      },
      scope:
        'Actual HTTP authentication and daily faucet + production repository SQL on file-backed PGlite. Task software key; not Seeker hardware proof. No next-day mint executed.',
    }
    await mkdir(dirname(evidencePath), { recursive: true })
    await durableJson(evidencePath, evidence, 0o644)
    console.log(
      JSON.stringify({
        result: 'PASS',
        signature: receipt.signature,
        recipient: recipientAddress,
        amount: '1000 Mock SKR',
        evidence: 'artifacts/devnet-faucet-rehearsal.json',
      }),
    )
  } finally {
    if (running) await running.close()
    recipient.secretKey.fill(0)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Do not emit stack traces, RPC URLs, environment contents, signed bytes, or private keys.
    const safeLabel = (value) =>
      typeof value === 'string' && /^[A-Za-z0-9_-]{1,60}$/.test(value) ? value : undefined
    console.error(
      JSON.stringify({
        result: 'STOPPED',
        phase,
        errorClass: safeLabel(error?.name),
        errorCode: safeLabel(error?.code),
        reason:
          error instanceof assert.AssertionError
            ? error.message
            : 'Retain the original private journal and DB for recovery. No replacement recipient was created.',
      }),
    )
    process.exitCode = 1
  })
}
