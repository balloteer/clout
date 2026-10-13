import assert from 'node:assert/strict'
import test from 'node:test'
import { ComputeBudgetInstruction, Keypair, Transaction, type Connection } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  MintLayout,
  TOKEN_PROGRAM_ID,
  decodeMintToCheckedInstruction,
  getAssociatedTokenAddressSync,
  type RawMint,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { SolanaMockSkrFaucetAdapter } from '../src/faucet.js'
import { DEVNET_GENESIS_HASH, SKR_MAINNET_MINT } from '../src/validation.js'
import type { SolanaRewardTransferAdapter } from '../src/rewards.js'

function fixture() {
  const authority = Keypair.generate()
  const mint = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const config = {
    marketConfig: {
      cluster: 'devnet' as const,
      rpcUrl: 'https://api.devnet.solana.com',
      quoteMint: mint.toBase58(),
      quoteDecimals: 6,
      priorityFeeMicroLamports: 100_000,
    },
    secretKeyUint8Array: authority.secretKey,
    maxAmountIn: '2000000',
    maxSupplyIn: '100000000',
  }
  const adapter = new SolanaMockSkrFaucetAdapter(config)
  const connection = Reflect.get(adapter, 'connection') as Connection
  const transport = Reflect.get(adapter, 'transport') as SolanaRewardTransferAdapter
  const transportConnection = Reflect.get(transport, 'connection') as Connection
  const mintState: RawMint = {
    mintAuthorityOption: 1,
    mintAuthority: authority.publicKey,
    supply: 90_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthorityOption: 0,
    freezeAuthority: authority.publicKey,
  }
  let solBalance = 1_000_000_000
  const broadcasts: string[] = []
  connection.getGenesisHash = transportConnection.getGenesisHash = async () => DEVNET_GENESIS_HASH
  connection.getAccountInfo = async (address) => {
    assert.ok(address.equals(mint))
    const data = Buffer.alloc(MintLayout.span)
    MintLayout.encode(mintState, data)
    return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1_461_600 }
  }
  connection.getBalance = async () => solBalance
  connection.getMinimumBalanceForRentExemption = async (size) => {
    assert.equal(size, 165)
    return 2_039_280
  }
  connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  })
  connection.getFeeForMessage = async (message) => {
    assert.equal(message.header.numRequiredSignatures, 1)
    if (message.version !== 'legacy') throw new Error('Expected a legacy fee message.')
    const transaction = Transaction.populate(message)
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(transaction.instructions[0]).units,
      1_400_000,
    )
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitPrice(transaction.instructions[1]).microLamports,
      100_000n,
    )
    return { context: { slot: 10 }, value: 145_000 }
  }
  Reflect.set(connection, 'simulateTransaction', async () => ({
    context: { slot: 10 },
    value: { err: null, unitsConsumed: 20_000 },
  }))
  transportConnection.sendRawTransaction = async (bytes) => {
    broadcasts.push(Buffer.from(bytes).toString('base64'))
    const signature = Transaction.from(bytes).signature
    assert.ok(signature)
    return bs58.encode(signature)
  }
  return {
    adapter,
    config,
    connection,
    transportConnection,
    authority,
    mint,
    recipient,
    mintState,
    broadcasts,
    setSolBalance(value: number) {
      solBalance = value
    },
  }
}

test('faucet prepares an exact bounded checked mint to the recipient ATA without broadcasting', async () => {
  const { adapter, authority, mint, recipient, broadcasts } = fixture()
  const built = await adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1234567' })
  assert.equal(broadcasts.length, 0)
  assert.equal(built.lastValidBlockHeight, 100)
  const tx = Transaction.from(Buffer.from(built.signedBase64, 'base64'))
  assert.equal(tx.verifySignatures(), true)
  assert.equal(tx.signatures.length, 1)
  assert.equal(tx.feePayer?.toBase58(), authority.publicKey.toBase58())
  assert.equal(bs58.encode(tx.signature!), built.signature)
  assert.equal(tx.instructions[2].programId.toBase58(), ASSOCIATED_TOKEN_PROGRAM_ID.toBase58())
  assert.deepEqual([...tx.instructions[2].data], [1]) // Idempotent ATA creation.
  const mintTo = decodeMintToCheckedInstruction(tx.instructions[3])
  assert.equal(mintTo.data.amount, 1_234_567n)
  assert.equal(mintTo.data.decimals, 6)
  assert.equal(mintTo.keys.mint.pubkey.toBase58(), mint.toBase58())
  assert.equal(mintTo.keys.authority.pubkey.toBase58(), authority.publicKey.toBase58())
  assert.equal(
    mintTo.keys.destination.pubkey.toBase58(),
    getAssociatedTokenAddressSync(mint, recipient).toBase58(),
  )
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '2000001' }), {
    code: 'FAUCET_LIMIT',
  })
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '0' }), {
    code: 'INVALID_AMOUNT',
  })
  await assert.rejects(adapter.prepare({ wallet: 'invalid', amountIn: '1' }), { code: 'INVALID_WALLET' })
})

test('minting fails closed for real SKR, wrong networks, authorities, decimals and freeze authority', async () => {
  const { adapter, config, connection, mintState } = fixture()
  assert.throws(
    () =>
      new SolanaMockSkrFaucetAdapter({
        ...config,
        marketConfig: { ...config.marketConfig, quoteMint: SKR_MAINNET_MINT },
      }),
  )
  connection.getGenesisHash = async () => 'mainnet'
  await assert.rejects(adapter.validateBudget({ amountIn: '0' }), { code: 'WRONG_NETWORK' })
  connection.getGenesisHash = async () => DEVNET_GENESIS_HASH
  mintState.decimals = 9
  await assert.rejects(adapter.availableBalance(), { code: 'WRONG_DECIMALS' })
  mintState.decimals = 6
  mintState.mintAuthority = Keypair.generate().publicKey
  await assert.rejects(adapter.availableBalance(), { code: 'INVALID_MINT_AUTHORITY' })
  mintState.mintAuthority = Keypair.fromSecretKey(config.secretKeyUint8Array).publicKey
  mintState.freezeAuthorityOption = 1
  await assert.rejects(adapter.availableBalance(), { code: 'INVALID_MINT_AUTHORITY' })
  mintState.freezeAuthorityOption = 0
  mintState.mintAuthorityOption = 0
  await assert.rejects(adapter.availableBalance(), { code: 'INVALID_MINT_AUTHORITY' })
})

test('whole remaining campaign allocation must fit the absolute supply ceiling', async () => {
  const { adapter, mintState, connection } = fixture()
  assert.equal(await adapter.availableBalance(), '10000000')
  await adapter.validateBudget({ amountIn: '10000000' })
  await assert.rejects(adapter.validateBudget({ amountIn: '10000001' }), { code: 'FAUCET_SUPPLY_LIMIT' })
  mintState.supply = 100_000_000n
  await assert.rejects(adapter.validateBudget({ amountIn: '1' }), { code: 'FAUCET_SUPPLY_LIMIT' })
  connection.getBalance = async () => {
    throw new Error('No fee estimate is needed for zero remaining grants.')
  }
  await adapter.validateBudget({ amountIn: '0' })
  mintState.supply++
  await assert.rejects(adapter.validateBudget({ amountIn: '0' }), { code: 'FAUCET_SUPPLY_LIMIT' })
})

test('faucet funding reserves every remaining new ATA rent plus bounded signature and priority fees', async () => {
  const { adapter, setSolBalance, connection } = fixture()
  const perClaim = 2_039_280 + 145_000
  setSolBalance(perClaim * 2)
  await adapter.validateBudget({ amountIn: '4000000' })
  await assert.rejects(adapter.validateBudget({ amountIn: '4000001' }), { code: 'INSUFFICIENT_TREASURY_SOL' })
  setSolBalance(perClaim * 3 - 1)
  await assert.rejects(adapter.validateBudget({ amountIn: '4000001' }), { code: 'INSUFFICIENT_TREASURY_SOL' })
  setSolBalance(perClaim * 3)
  await adapter.validateBudget({ amountIn: '4000001' })
  connection.getFeeForMessage = async () => ({ context: { slot: 10 }, value: null })
  await assert.rejects(adapter.validateBudget({ amountIn: '1' }), { code: 'INVALID_FEE_ESTIMATE' })
})

test('failed simulations never produce a mint signature or broadcast', async () => {
  const { adapter, connection, recipient, broadcasts } = fixture()
  Reflect.set(connection, 'simulateTransaction', async () => ({ value: { err: 'InsufficientFunds' } }))
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1' }), {
    code: 'SIMULATION_FAILED',
  })
  Reflect.set(connection, 'simulateTransaction', async () => ({ value: { err: null } }))
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1' }), {
    code: 'SIMULATION_FAILED',
  })
  assert.equal(broadcasts.length, 0)
})

test('mint retries broadcast only identical persisted signed bytes and reject tampering', async () => {
  const { adapter, recipient, broadcasts } = fixture()
  const built = await adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1' })
  assert.equal(await adapter.submit(built.signedBase64), built.signature)
  assert.equal(await adapter.submit(built.signedBase64), built.signature)
  assert.deepEqual(broadcasts, [built.signedBase64, built.signedBase64])
  const tampered = Transaction.from(Buffer.from(built.signedBase64, 'base64'))
  tampered.instructions.at(-1)!.data[1] ^= 1
  await assert.rejects(adapter.submit(tampered.serialize({ verifySignatures: false }).toString('base64')), {
    code: 'INVALID_TRANSACTION',
  })
  assert.equal(broadcasts.length, 2)
})
