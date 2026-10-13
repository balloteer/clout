import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ComputeBudgetInstruction,
  Keypair,
  Transaction,
  type Connection,
  type SignatureStatus,
} from '@solana/web3.js'
import {
  AccountLayout,
  MintLayout,
  TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { SolanaRewardTransferAdapter } from '../src/rewards.js'
import { DEVNET_GENESIS_HASH } from '../src/validation.js'
import type { MeteoraMarketAdapter } from '../src/meteora.js'

function fixture(priorityFeeMicroLamports = 1_000) {
  const treasury = Keypair.generate()
  const mint = Keypair.generate().publicKey
  const recipient = Keypair.generate().publicKey
  const adapter = new SolanaRewardTransferAdapter({
    marketConfig: {
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      quoteMint: mint.toBase58(),
      quoteDecimals: 6,
      priorityFeeMicroLamports,
    },
    secretKeyUint8Array: treasury.secretKey,
    maxAmountIn: '2000000',
  })
  const connection = Reflect.get(adapter, 'connection') as Connection
  const builder = Reflect.get(adapter, 'builder') as MeteoraMarketAdapter
  const builderConnection = Reflect.get(builder, 'connection') as Connection
  let balance = 5_000_000n
  let solBalance = 1_000_000_000
  const mintData = Buffer.alloc(MintLayout.span)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: treasury.publicKey,
      supply: 100_000_000n,
      decimals: 6,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: treasury.publicKey,
    },
    mintData,
  )
  const getAccountInfo: Connection['getAccountInfo'] = async (address) => {
    const data = address.equals(mint) ? mintData : Buffer.alloc(AccountLayout.span)
    if (!address.equals(mint))
      AccountLayout.encode(
        {
          mint,
          owner: treasury.publicKey,
          amount: balance,
          delegateOption: 0,
          delegate: treasury.publicKey,
          state: 1,
          isNativeOption: 0,
          isNative: 0n,
          delegatedAmount: 0n,
          closeAuthorityOption: 0,
          closeAuthority: treasury.publicKey,
        },
        data,
      )
    return { owner: TOKEN_PROGRAM_ID, data, executable: false, lamports: 2_039_280 }
  }
  connection.getGenesisHash = builderConnection.getGenesisHash = async () => DEVNET_GENESIS_HASH
  connection.getAccountInfo = builderConnection.getAccountInfo = getAccountInfo
  const blockhash = Keypair.generate().publicKey.toBase58()
  connection.getLatestBlockhash = builderConnection.getLatestBlockhash = async () => ({
    blockhash,
    lastValidBlockHeight: 100,
  })
  connection.getBalance = async () => solBalance
  connection.getMinimumBalanceForRentExemption = async (size) => {
    assert.equal(size, 165)
    return 2_039_280
  }
  connection.getFeeForMessage = async (message) => {
    assert.equal(message.header.numRequiredSignatures, 1)
    if (message.version !== 'legacy') throw new Error('Expected the legacy treasury fee message.')
    const instructions = Transaction.populate(message).instructions
    assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]).units, 1_400_000)
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[1]).microLamports,
      BigInt(priorityFeeMicroLamports),
    )
    return {
      context: { slot: 100 },
      value: 5_000 + Math.ceil((1_400_000 * priorityFeeMicroLamports) / 1_000_000),
    }
  }
  Reflect.set(builderConnection, 'simulateTransaction', async () => ({
    context: { slot: 100 },
    value: { err: null, unitsConsumed: 20_000 },
  }))
  const broadcasts: string[] = []
  connection.sendRawTransaction = async (bytes) => {
    broadcasts.push(Buffer.from(bytes).toString('base64'))
    const signature = Transaction.from(bytes).signature
    assert.ok(signature)
    return bs58.encode(signature)
  }
  return {
    adapter,
    connection,
    treasury,
    mint,
    recipient,
    broadcasts,
    setBalance: (value: bigint) => {
      balance = value
    },
    setSolBalance: (value: number) => {
      solBalance = value
    },
  }
}

test('reward preparation signs bounded exact Test SKR units but never broadcasts', async () => {
  const { adapter, treasury, mint, recipient, broadcasts } = fixture()
  const built = await adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1500000' })
  assert.equal(broadcasts.length, 0)
  const tx = Transaction.from(Buffer.from(built.signedBase64, 'base64'))
  assert.equal(tx.verifySignatures(), true)
  assert.equal(tx.feePayer?.toBase58(), treasury.publicKey.toBase58())
  assert.equal(bs58.encode(tx.signature!), built.signature)
  const transfer = decodeTransferCheckedInstruction(tx.instructions.at(-1)!)
  assert.equal(transfer.data.amount, 1_500_000n)
  assert.equal(transfer.data.decimals, 6)
  assert.equal(
    transfer.keys.destination.pubkey.toBase58(),
    getAssociatedTokenAddressSync(mint, recipient).toBase58(),
  )
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '2000001' }), {
    code: 'REWARD_LIMIT',
  })
})

test('campaign funding check covers the entire reserved allocation and rejects wrong networks', async () => {
  const { adapter, connection, recipient, setBalance } = fixture()
  await adapter.validateBudget({ amountIn: '5000000' }) // Campaign allocation may exceed one claim.
  await assert.rejects(adapter.validateBudget({ amountIn: '5000001' }), { code: 'INSUFFICIENT_TREASURY' })
  setBalance(0n)
  await assert.rejects(adapter.prepare({ wallet: recipient.toBase58(), amountIn: '1' }), {
    code: 'INSUFFICIENT_TREASURY',
  })
  connection.getGenesisHash = async () => 'mainnet'
  await assert.rejects(adapter.availableBalance(), { code: 'WRONG_NETWORK' })
})

test('campaign funding requires SOL for each possible new token account and the bounded priority fee', async () => {
  const { adapter, setSolBalance, broadcasts } = fixture(100_000)
  // Three claims are needed for 4.000001 Test SKR at a two-token per-claim limit.
  // Each reserves 165-byte rent plus one signature and the full 1.4m CU limit at the maximum allowed priority price.
  const reservePerClaim = 2_039_280 + 5_000 + 140_000
  setSolBalance(0)
  await assert.rejects(adapter.validateBudget({ amountIn: '1' }), { code: 'INSUFFICIENT_TREASURY_SOL' })
  setSolBalance(reservePerClaim * 2)
  await adapter.validateBudget({ amountIn: '4000000' })
  await assert.rejects(adapter.validateBudget({ amountIn: '4000001' }), { code: 'INSUFFICIENT_TREASURY_SOL' })
  setSolBalance(reservePerClaim * 3 - 1)
  await assert.rejects(adapter.validateBudget({ amountIn: '4000001' }), { code: 'INSUFFICIENT_TREASURY_SOL' })
  setSolBalance(reservePerClaim * 3)
  await adapter.validateBudget({ amountIn: '4000001' })
  assert.equal(broadcasts.length, 0)
})

test('unavailable fee estimates cannot advertise a funded campaign', async () => {
  const { adapter, connection } = fixture()
  connection.getFeeForMessage = async () => ({ context: { slot: 100 }, value: null })
  await assert.rejects(adapter.validateBudget({ amountIn: '1' }), { code: 'INVALID_FEE_ESTIMATE' })
})

test('reward retries submit identical persisted signed bytes; invalid signatures cannot be sent', async () => {
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

test('reward settlement requires finality even for errors and performs historical lookup', async () => {
  const { adapter, connection } = fixture()
  let status: SignatureStatus | null = {
    slot: 1,
    confirmations: 1,
    err: null,
    confirmationStatus: 'confirmed',
  }
  connection.getSignatureStatuses = async (_signatures, options) => {
    assert.equal(options?.searchTransactionHistory, true)
    return { context: { slot: 2 }, value: [status] }
  }
  const signature = '1'.repeat(88)
  assert.equal(await adapter.reconcile(signature, 100), 'pending')
  status.err = 'InsufficientFunds'
  assert.equal(await adapter.reconcile(signature, 100), 'pending')
  status.confirmationStatus = 'finalized'
  assert.equal(await adapter.reconcile(signature, 100), 'failed')
  status.err = null
  assert.equal(await adapter.reconcile(signature, 100), 'finalized')
})

test('reward expiry uses finalized blockheight and rechecks history after crossing it', async () => {
  const { adapter, connection } = fixture()
  let height = 100
  let reads = 0
  let secondRead: SignatureStatus | null = null
  connection.getBlockHeight = async (commitment) => {
    assert.equal(commitment, 'finalized')
    return height
  }
  connection.getSignatureStatuses = async () => {
    reads++
    return { context: { slot: 2 }, value: [reads > 1 ? secondRead : null] }
  }
  const signature = '1'.repeat(88)
  assert.equal(await adapter.reconcile(signature, 100), 'pending')
  height = 101
  reads = 0
  secondRead = { slot: 99, confirmations: null, err: null, confirmationStatus: 'finalized' }
  assert.equal(await adapter.reconcile(signature, 100), 'finalized')
  assert.equal(reads, 2)
  reads = 0
  secondRead = null
  assert.equal(await adapter.reconcile(signature, 100), 'expired')
  assert.equal(reads, 2)
})
