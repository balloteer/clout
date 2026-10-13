import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair, PublicKey } from '@solana/web3.js'
import { ExtensionType, MintLayout, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { MainnetSeekerVerifier } from '../src/seeker.js'

const group = new PublicKey('GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te')
const owner = Keypair.generate().publicKey
const mint = Keypair.generate().publicKey
function mintBytes(pointer = group, member = group) {
  const data = Buffer.alloc(166 + 4 + 64 + 4 + 72)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1n,
      decimals: 0,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  )
  data[165] = 1
  data.writeUInt16LE(ExtensionType.MetadataPointer, 166)
  data.writeUInt16LE(64, 168)
  pointer.toBuffer().copy(data, 170 + 32)
  data.writeUInt16LE(ExtensionType.TokenGroupMember, 234)
  data.writeUInt16LE(72, 236)
  mint.toBuffer().copy(data, 238)
  member.toBuffer().copy(data, 270)
  data.writeBigUInt64LE(1n, 302)
  return data
}
function verifier(amount: string, data = mintBytes(), state = 'frozen') {
  const verifier = new MainnetSeekerVerifier('https://mainnet.invalid')
  verifier.connection.getGenesisHash = async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
  verifier.connection.getParsedTokenAccountsByOwner = async () => ({
    context: { slot: 1 },
    value: [
      {
        pubkey: Keypair.generate().publicKey,
        account: {
          executable: false,
          lamports: 1,
          owner: TOKEN_2022_PROGRAM_ID,
          rentEpoch: 0,
          data: {
            program: 'spl-token',
            space: 165,
            parsed: {
              info: { owner: owner.toBase58(), mint: mint.toBase58(), state, tokenAmount: { amount } },
            },
          },
        },
      },
    ],
  })
  verifier.connection.getMultipleAccountsInfo = async () => [
    { executable: false, lamports: 1, owner: TOKEN_2022_PROGRAM_ID, rentEpoch: 0, data },
  ]
  return verifier
}

test('SGT verification accepts currently-held frozen authentic Token-2022 mint', async () => {
  assert.deepEqual(await verifier('1').check(owner.toBase58()), {
    hasSGT: true,
    mintAddress: mint.toBase58(),
  })
})
test('SGT verification rejects stale zero balances and either forged identity extension', async () => {
  assert.equal((await verifier('0').check(owner.toBase58())).hasSGT, false)
  assert.equal((await verifier('1', mintBytes(owner, group)).check(owner.toBase58())).hasSGT, false)
  assert.equal((await verifier('1', mintBytes(group, owner)).check(owner.toBase58())).hasSGT, false)
})
test('SGT RPC outage and wrong network remain unavailable rather than ineligible', async () => {
  const checker = verifier('1')
  checker.connection.getGenesisHash = async () => 'devnet'
  await assert.rejects(checker.check(owner.toBase58()), /mainnet/)
  checker.connection.getGenesisHash = async () => {
    throw new Error('RPC offline')
  }
  await assert.rejects(checker.check(owner.toBase58()), /RPC offline/)
})
