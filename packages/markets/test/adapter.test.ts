import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import BN from 'bn.js'
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js'
import {
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  MintLayout,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  deriveDbcPoolAddress,
  type DynamicBondingCurveClient,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk'
import { MeteoraMarketAdapter } from '../src/meteora.js'
import { DEVNET_GENESIS_HASH, SKR_MAINNET_MINT } from '../src/validation.js'
import type { MarketServiceConfig, TransactionEnvelope } from '../src/types.js'

const owner = Keypair.generate().publicKey
const config: MarketServiceConfig = {
  cluster: 'devnet',
  rpcUrl: 'https://api.devnet.solana.com',
  quoteMint: Keypair.generate().publicKey.toBase58(),
}

function fixture() {
  const adapter = new MeteoraMarketAdapter(config)
  // Replace RPC methods at the SDK boundary. No test talks to a network or signs a wallet transaction.
  const connection = Reflect.get(adapter, 'connection') as Connection
  connection.getGenesisHash = async () => DEVNET_GENESIS_HASH
  const tx = new Transaction({
    feePayer: owner,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: Keypair.generate().publicKey, lamports: 1 }))
  const transaction: TransactionEnvelope = {
    cluster: 'devnet',
    owner: owner.toBase58(),
    transactionBase64: '',
    messageBase64: tx.serializeMessage().toString('base64'),
    blockhash: tx.recentBlockhash ?? '',
    lastValidBlockHeight: 100,
    simulation: { slot: 1, unitsConsumed: 1000 },
  }
  const signature = '1'.repeat(88)
  return { adapter, connection, transaction, signature, tx }
}

test('mainnet, native SOL and the official SKR mainnet mint cannot configure the devnet adapter', () => {
  assert.throws(() => new MeteoraMarketAdapter({ ...config, cluster: 'mainnet-beta' as 'devnet' }), {
    code: 'UNSUPPORTED_CLUSTER',
  })
  assert.throws(() => new MeteoraMarketAdapter({ ...config, quoteMint: SKR_MAINNET_MINT }), {
    code: 'INVALID_QUOTE_MINT',
  })
  assert.throws(
    () => new MeteoraMarketAdapter({ ...config, quoteMint: 'So11111111111111111111111111111111111111112' }),
    { code: 'INVALID_QUOTE_MINT' },
  )
})

test('RPC genesis overrides a misleading devnet URL', async () => {
  const { adapter, connection, transaction, signature } = fixture()
  connection.getGenesisHash = async () => 'mainnet-genesis'
  await assert.rejects(adapter.reconcile({ transaction, signature }), { code: 'WRONG_NETWORK' })
})

test('missing transaction becomes expired only after blockheight and no known status', async () => {
  const { adapter, connection, transaction, signature } = fixture()
  connection.getTransaction = async () => null
  connection.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [null] })
  connection.getBlockHeight = async () => 100
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'pending')
  connection.getBlockHeight = async () => 101
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'expired')
  connection.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  })
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'pending')
})

test('another successful transaction cannot confirm a trade intent', async () => {
  const { adapter, connection, transaction, signature, tx } = fixture()
  tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: owner, lamports: 2 }))
  connection.getTransaction = async () => ({
    slot: 2,
    transaction: { message: tx.compileMessage(), signatures: [signature] },
    meta: null,
  })
  await assert.rejects(adapter.reconcile({ signature, transaction }), { code: 'TRANSACTION_MISMATCH' })
})

test('Seeker may replace only the bounded priority fee while signing', async () => {
  const { adapter, connection, transaction, signature, tx } = fixture()
  const built = new Transaction({ feePayer: owner, recentBlockhash: tx.recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
    tx.instructions[0],
  )
  transaction.messageBase64 = built.serializeMessage().toString('base64')
  const walletSigned = new Transaction({ feePayer: owner, recentBlockhash: tx.recentBlockhash }).add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    tx.instructions[0],
  )
  connection.getTransaction = async () => ({
    slot: 123,
    transaction: { message: walletSigned.compileMessage(), signatures: [signature] },
    meta: { err: null, fee: 11_000, preBalances: [], postBalances: [] },
  })
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'confirmed')

  walletSigned.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_001 })
  await assert.rejects(adapter.reconcile({ signature, transaction }), { code: 'TRANSACTION_MISMATCH' })

  walletSigned.instructions[1] = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
  walletSigned.instructions[0] = ComputeBudgetProgram.setComputeUnitLimit({ units: 60_001 })
  await assert.rejects(adapter.reconcile({ signature, transaction }), { code: 'TRANSACTION_MISMATCH' })
})

test('only confirmed chain deltas are reported, with exact integer amounts and owner filtering', async () => {
  const { adapter, connection, transaction, signature, tx } = fixture()
  const amount = (ownerAddress: string, raw: string) => ({
    accountIndex: 0,
    mint: config.quoteMint,
    owner: ownerAddress,
    uiTokenAmount: { amount: raw, decimals: 6, uiAmount: null },
  })
  connection.getTransaction = async () => ({
    slot: 123,
    blockTime: 42,
    transaction: { message: tx.compileMessage(), signatures: [signature] },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [],
      postBalances: [],
      preTokenBalances: [amount(owner.toBase58(), '9007199254740993'), amount('other-wallet', '200')],
      postTokenBalances: [amount(owner.toBase58(), '9007199254740000'), amount('other-wallet', '0')],
    },
  })
  const result = await adapter.reconcile({ signature, transaction })
  assert.equal(result.status, 'confirmed')
  if (result.status === 'confirmed') {
    assert.equal(result.tokenDeltas[config.quoteMint], '-993')
    assert.equal(result.feeLamports, '5000')
    assert.equal(result.slot, 123)
  }
})

test('onchain errors cannot become a successful receipt', async () => {
  const { adapter, connection, transaction, signature, tx } = fixture()
  connection.getTransaction = async () => ({
    slot: 123,
    transaction: { message: tx.compileMessage(), signatures: [signature] },
    meta: {
      err: { InstructionError: [1, 'InsufficientFunds'] },
      fee: 5000,
      preBalances: [],
      postBalances: [],
    },
  })
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'failed')
})

test('SDK builds a fixed-supply SKR curve transaction and only the fresh config key co-signs', async () => {
  const { adapter, connection } = fixture()
  const mintData = Buffer.alloc(MintLayout.span)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: owner,
      supply: 1000000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: owner,
    },
    mintData,
  )
  connection.getAccountInfo = async () => ({
    owner: TOKEN_PROGRAM_ID,
    data: mintData,
    executable: false,
    lamports: 1000,
  })
  connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  })
  const simulations: number[] = []
  Reflect.set(connection, 'simulateTransaction', async () => {
    simulations.push(1)
    return { context: { slot: 123 }, value: { err: null, logs: [], unitsConsumed: 25000 } }
  })
  const result = await adapter.buildConfig({
    payer: owner.toBase58(),
    feeClaimer: owner.toBase58(),
    leftoverReceiver: owner.toBase58(),
    migrationThresholdTokens: 2,
  })
  const built = Transaction.from(Buffer.from(result.transactionBase64, 'base64'))
  assert.equal(built.feePayer?.toBase58(), owner.toBase58())
  assert.equal(built.instructions.at(-1)?.programId.toBase58(), DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58())
  assert.equal(built.signatures.find((sig) => sig.publicKey.equals(owner))?.signature, null)
  assert.ok(built.signatures.find((sig) => sig.publicKey.toBase58() === result.configAddress)?.signature)
  assert.equal(built.verifySignatures(false), true)
  assert.equal(result.messageBase64, built.serializeMessage().toString('base64'))
  assert.equal(result.parameters.quoteMint, config.quoteMint)
  assert.equal(result.parameters.quoteDecimals, 6)
  assert.equal(result.parameters.tradingFeeBps, 100)
  assert.equal(result.parameters.migratedTradingFeeBps, 100)
  assert.equal(simulations.length, 2)
})

test('processed errors remain pending until chain confirmation', async () => {
  const { adapter, connection, transaction, signature } = fixture()
  connection.getTransaction = async () => null
  connection.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 0,
        err: 'InsufficientFunds',
        confirmationStatus: 'processed',
      },
    ],
  })
  assert.equal((await adapter.reconcile({ signature, transaction })).status, 'pending')
})

test('SKR tips preserve exact units, checked decimals, recipient ATA and wallet approval', async () => {
  const { adapter, connection } = fixture()
  const mintData = Buffer.alloc(MintLayout.span)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: owner,
      supply: 1000000000000000000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: owner,
    },
    mintData,
  )
  connection.getAccountInfo = async () => ({
    owner: TOKEN_PROGRAM_ID,
    data: mintData,
    executable: false,
    lamports: 1000,
  })
  connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  })
  Reflect.set(connection, 'simulateTransaction', async () => ({
    context: { slot: 123 },
    value: { err: null, logs: [], unitsConsumed: 20000 },
  }))
  const recipient = Keypair.generate().publicKey
  const result = await adapter.buildTip({
    owner: owner.toBase58(),
    recipient: recipient.toBase58(),
    amountIn: '9007199254740993',
  })
  const transaction = Transaction.from(Buffer.from(result.transactionBase64, 'base64'))
  const transfer = decodeTransferCheckedInstruction(transaction.instructions.at(-1)!)
  assert.equal(transfer.data.amount, 9007199254740993n)
  assert.equal(transfer.data.decimals, 6)
  assert.equal(transfer.keys.owner.pubkey.toBase58(), owner.toBase58())
  assert.equal(
    transfer.keys.destination.pubkey.toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(config.quoteMint), recipient).toBase58(),
  )
  assert.equal(result.recipient, recipient.toBase58())
  assert.equal(transaction.signatures[0].signature, null)
  await assert.rejects(
    adapter.buildTip({ owner: owner.toBase58(), recipient: owner.toBase58(), amountIn: '1000000' }),
    { code: 'INVALID_RECIPIENT' },
  )
})

test('real SDK PascalCase discriminators permit launch, DBC inspection and graduated DAMM inspection', async () => {
  const fixture = JSON.parse(
    await readFile(new URL('./fixtures/devnet-config.json', import.meta.url), 'utf8'),
  ) as {
    accounts: { address: string; owner: string; data: string }[]
  }
  const [configuration, quoteMint] = fixture.accounts
  const adapter = new MeteoraMarketAdapter({
    ...config,
    quoteMint: quoteMint.address,
    dbcConfigAddress: configuration.address,
  })
  const connection = Reflect.get(adapter, 'connection') as Connection
  const dbc = Reflect.get(adapter, 'dbc') as DynamicBondingCurveClient
  const baseMint = Keypair.generate().publicKey
  const configAddress = new PublicKey(configuration.address)
  const pool = deriveDbcPoolAddress(new PublicKey(quoteMint.address), baseMint, configAddress)
  let migrated = 0
  let badSuccessor = false
  const dbcDiscriminator = DynamicBondingCurveIdl.accounts.find(
    (a) => a.name === 'VirtualPool',
  )!.discriminator
  const dammDiscriminator = CpAmmIdl.accounts.find((a) => a.name === 'Pool')!.discriminator
  connection.getGenesisHash = async () => DEVNET_GENESIS_HASH
  connection.getAccountInfo = async (address) => {
    const stored = fixture.accounts.find((account) => account.address === address.toBase58())
    if (stored)
      return {
        owner: new PublicKey(stored.owner),
        data: Buffer.from(stored.data, 'base64'),
        executable: false,
        lamports: 1_000_000,
      }
    if (address.equals(baseMint))
      return {
        owner: TOKEN_PROGRAM_ID,
        data: Buffer.from(quoteMint.data, 'base64'),
        executable: false,
        lamports: 1_000_000,
      }
    if (address.equals(pool))
      return {
        owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        data: Buffer.from(dbcDiscriminator),
        executable: false,
        lamports: 1_000_000,
      }
    return {
      owner: CP_AMM_PROGRAM_ID,
      data: badSuccessor ? Buffer.alloc(8) : Buffer.from(dammDiscriminator),
      executable: false,
      lamports: 1_000_000,
    }
  }
  connection.getAccountInfoAndContext = async (address) => ({
    context: { slot: 99 },
    value: await connection.getAccountInfo(address),
  })
  Reflect.set(connection, '_rpcRequest', async (method: string) => {
    throw new Error(`Unexpected network request in SDK regression: ${method}`)
  })
  connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  })
  connection.getSlot = async () => 99
  Reflect.set(connection, 'simulateTransaction', async () => ({
    context: { slot: 99 },
    value: { err: null, unitsConsumed: 50_000 },
  }))
  const launch = await adapter.buildLaunch({
    postId: 'sdk-regression',
    creator: owner.toBase58(),
    name: 'SDK regression',
    symbol: 'SDKTEST',
    metadataUri: 'https://example.com/post.json',
  })
  assert.ok(launch.market.baseMint)
  const transaction = Transaction.from(Buffer.from(launch.transactionBase64, 'base64'))
  assert.equal(transaction.verifySignatures(false), true)
  assert.equal(transaction.signatures.find((signature) => signature.publicKey.equals(owner))?.signature, null)
  Reflect.set(dbc.state, 'getPool', async () => ({
    poolState: {
      baseMint,
      config: configAddress,
      quoteReserve: new BN(0),
      isMigrated: migrated,
      creator: owner,
    },
  }))
  const market = { postId: 'sdk-regression', baseMint: baseMint.toBase58(), dbcPool: pool.toBase58() }
  assert.equal((await adapter.inspectMarket(market)).status, 'dbc')
  migrated = 1
  assert.equal((await adapter.inspectMarket(market)).status, 'damm-v2')
  badSuccessor = true
  await assert.rejects(adapter.inspectMarket(market), { code: 'INVALID_ACCOUNT' })
})
