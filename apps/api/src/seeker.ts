import { Connection, PublicKey } from '@solana/web3.js'
import {
  getMetadataPointerState,
  getTokenGroupMemberState,
  TOKEN_2022_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token'

const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
const SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te'
export interface SeekerVerifier {
  check(wallet: string): Promise<{ hasSGT: boolean; mintAddress: string | null }>
}

export class MainnetSeekerVerifier implements SeekerVerifier {
  readonly connection: Connection
  constructor(rpcUrl: string) {
    this.connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      disableRetryOnRateLimit: true,
      fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
    })
  }
  async check(wallet: string) {
    if ((await this.connection.getGenesisHash()) !== MAINNET_GENESIS)
      throw new Error('Seeker verification requires mainnet RPC.')
    const owner = new PublicKey(wallet)
    const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, {
      programId: TOKEN_2022_PROGRAM_ID,
    })
    const mints = accounts.value
      .filter(({ account }) => {
        const info = account.data.parsed?.info
        // Frozen SGT accounts are valid; zero-balance residue is not ownership.
        return (
          account.owner.equals(TOKEN_2022_PROGRAM_ID) &&
          info?.owner === wallet &&
          /^\d+$/.test(info?.tokenAmount?.amount ?? '') &&
          BigInt(info.tokenAmount.amount) > 0n
        )
      })
      .map(({ account }) => new PublicKey(account.data.parsed.info.mint))
    for (let start = 0; start < mints.length; start += 100) {
      const batch = mints.slice(start, start + 100)
      const infos = await this.connection.getMultipleAccountsInfo(batch)
      for (let index = 0; index < infos.length; index++) {
        const info = infos[index]
        if (!info) continue
        try {
          const mint = unpackMint(batch[index], info, TOKEN_2022_PROGRAM_ID)
          if (
            getMetadataPointerState(mint)?.metadataAddress?.toBase58() === SGT_GROUP &&
            getTokenGroupMemberState(mint)?.group?.toBase58() === SGT_GROUP
          )
            return { hasSGT: true, mintAddress: batch[index].toBase58() }
        } catch {
          /* Unrelated malformed token mints do not grant eligibility. */
        }
      }
    }
    return { hasSGT: false, mintAddress: null }
  }
}
