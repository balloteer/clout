/** Local devnet rehearsal only. Default mode creates isolated task keys and probes funding; never reads a user key. */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js'
import {
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMintInstruction,
  createMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { createMarketService, DEVNET_GENESIS_HASH, type TransactionEnvelope } from '../src/index.js'

const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../../../.tooling/devnet')
const mode = process.argv[2] ?? 'prepare'
const rpcUrl = process.env.CLOUT_BOOTSTRAP_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com'
if (!['prepare', 'airdrop', 'provision'].includes(mode)) throw new Error('Use prepare, airdrop or provision.')
if (new URL(rpcUrl).protocol !== 'https:') throw new Error('Use an HTTPS devnet RPC.')
const connection = new Connection(rpcUrl, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60_000,
})

async function save(name: string, value: unknown) {
  const path = resolve(directory, name)
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(`${path}.tmp`, path)
  await chmod(path, 0o600)
}
async function load<T>(name: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(resolve(directory, name), 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
async function taskKey(name: string) {
  const path = resolve(directory, `${name}.json`)
  const existing = await load<number[]>(`${name}.json`)
  if (existing) {
    await chmod(path, 0o600)
    return Keypair.fromSecretKey(Uint8Array.from(existing))
  }
  const created = Keypair.generate()
  await writeFile(path, JSON.stringify(Array.from(created.secretKey)) + '\n', { mode: 0o600, flag: 'wx' })
  return created
}
async function guard() {
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS_HASH)
    throw new Error('WRONG_NETWORK: This command requires the full Solana devnet genesis hash.')
}
type Journal = { signature: string; signedBase64: string; blockhash: string; lastValidBlockHeight: number }
async function submitPersisted(
  name: string,
  build: () => Promise<{
    transaction: Transaction
    blockhash: string
    lastValidBlockHeight: number
    signers: Keypair[]
  }>,
) {
  await guard()
  let journal = await load<Journal>(`${name}-transaction.json`)
  if (!journal) {
    const next = await build()
    next.transaction.partialSign(...next.signers)
    if (!next.transaction.signature) throw new Error('Missing payer signature.')
    journal = {
      signature: bs58.encode(next.transaction.signature),
      signedBase64: next.transaction.serialize().toString('base64'),
      blockhash: next.blockhash,
      lastValidBlockHeight: next.lastValidBlockHeight,
    }
    await save(`${name}-transaction.json`, journal)
  }
  const status = (
    await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })
  ).value[0]
  if (status?.confirmationStatus === 'finalized') {
    if (status.err)
      throw new Error(`${name}: persisted transaction failed; inspect its signature before restarting.`)
    return journal.signature
  }
  if (!status && (await connection.getBlockHeight('finalized')) > journal.lastValidBlockHeight) {
    const last = (
      await connection.getSignatureStatuses([journal.signature], { searchTransactionHistory: true })
    ).value[0]
    if (!last) throw new Error(`${name}: persisted transaction expired; no automatic replacement was sent.`)
  }
  await connection.sendRawTransaction(Buffer.from(journal.signedBase64, 'base64'), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  })
  const result = await connection.confirmTransaction(
    {
      signature: journal.signature,
      blockhash: journal.blockhash,
      lastValidBlockHeight: journal.lastValidBlockHeight,
    },
    'finalized',
  )
  if (result.value.err)
    throw new Error(`${name}: transaction failed. The persisted signature is available for inspection.`)
  return journal.signature
}

async function main() {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await guard()
  const [payer, creator, backer, treasury, mint] = await Promise.all(
    ['payer', 'creator', 'backer', 'treasury', 'test-skr-mint'].map(taskKey),
  )
  const manifest = {
    network: 'devnet',
    genesisHash: DEVNET_GENESIS_HASH,
    token: {
      name: 'Clout Test SKR',
      symbol: 'Test SKR',
      decimals: 6,
      mint: mint.publicKey.toBase58(),
      disclaimer: 'Devnet test token. No real SKR or monetary value.',
    },
    wallets: Object.fromEntries(
      Object.entries({ payer, creator, backer, treasury }).map(([role, key]) => [
        role,
        key.publicKey.toBase58(),
      ]),
    ),
  }
  await save('manifest.json', manifest)
  const balance = await connection.getBalance(payer.publicKey, 'confirmed')
  console.log(JSON.stringify({ mode, ...manifest, payerLamports: String(balance) }, null, 2))
  if (mode === 'prepare') return
  if (mode === 'airdrop') {
    const signature = await connection.requestAirdrop(payer.publicKey, 2_000_000_000)
    await save('faucet-request.json', {
      signature,
      wallet: payer.publicKey.toBase58(),
      requestedLamports: '2000000000',
    })
    console.log(
      JSON.stringify({
        faucetSignature: signature,
        note: 'Faucet request recorded. Run prepare to check funds before provision.',
      }),
    )
    return
  }
  if (balance < 500_000_000)
    throw new Error('Fund the isolated payer with at least 0.5 devnet SOL before provision.')
  const mintAccount = await connection.getAccountInfo(mint.publicKey, 'confirmed')
  if (!mintAccount) {
    const signature = await submitPersisted('test-skr', async () => {
      const lifetime = await connection.getLatestBlockhash('confirmed')
      const transaction = new Transaction({ feePayer: payer.publicKey, ...lifetime }).add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: mint.publicKey,
          lamports: await connection.getMinimumBalanceForRentExemption(MINT_SIZE),
          space: MINT_SIZE,
          programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(mint.publicKey, 6, payer.publicKey, null),
      )
      for (const [role, wallet] of Object.entries({ creator, backer, treasury })) {
        const ata = getAssociatedTokenAddressSync(mint.publicKey, wallet.publicKey)
        transaction.add(
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            ata,
            wallet.publicKey,
            mint.publicKey,
          ),
          createMintToCheckedInstruction(
            mint.publicKey,
            ata,
            payer.publicKey,
            role === 'treasury' ? 1_000_000_000_000n : 10_000_000_000n,
            6,
          ),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: wallet.publicKey,
            lamports: 100_000_000,
          }),
        )
      }
      transaction.add(
        new TransactionInstruction({
          programId: new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
          keys: [],
          data: Buffer.from('Clout Test SKR - devnet test token, no real SKR'),
        }),
      )
      return { transaction, ...lifetime, signers: [payer, mint] }
    })
    console.log(JSON.stringify({ mintProvisionSignature: signature }))
  }
  const verifiedMint = await getMint(connection, mint.publicKey, 'confirmed')
  if (verifiedMint.decimals !== 6 || !verifiedMint.mintAuthority?.equals(payer.publicKey))
    throw new Error('Task Test SKR mint does not match the expected decimals and authority.')
  const service = createMarketService({
    cluster: 'devnet',
    rpcUrl,
    quoteMint: mint.publicKey.toBase58(),
    quoteDecimals: 6,
  })
  let config = await load<TransactionEnvelope & { configAddress: string }>('market-config-unsigned.json')
  const configSignature = await submitPersisted('market-config', async () => {
    if (!config) {
      config = await service.buildConfig({
        payer: payer.publicKey.toBase58(),
        feeClaimer: payer.publicKey.toBase58(),
        leftoverReceiver: payer.publicKey.toBase58(),
        migrationThresholdTokens: 2,
      })
      await save('market-config-unsigned.json', config)
    }
    return {
      transaction: Transaction.from(Buffer.from(config.transactionBase64, 'base64')),
      blockhash: config.blockhash,
      lastValidBlockHeight: config.lastValidBlockHeight,
      signers: [payer],
    }
  })
  if (!config) throw new Error('The persisted market configuration is missing.')
  await save('provisioned.json', {
    ...manifest,
    dbcConfigAddress: config.configAddress,
    configSignature,
    migrationThresholdTokens: 2,
  })
  console.log(
    JSON.stringify({
      dbcConfigAddress: config.configAddress,
      configSignature,
      next: 'Use the isolated creator/backer wallets for the devnet rehearsal. Keep all task keys private.',
    }),
  )
}

main().catch((err: unknown) => {
  // RPC credentials and signer values are never printed. The default endpoint is public.
  const message =
    err instanceof SyntaxError
      ? 'Invalid local JSON file; secret-bearing parse details were not printed.'
      : err instanceof Error
        ? err.message
        : 'Devnet preparation failed.'
  console.error(message.replace(/https?:\/\/[^\s]+/g, '[RPC URL]'))
  process.exitCode = 1
})
