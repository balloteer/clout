import { createHash } from 'node:crypto'
import { Connection, PublicKey } from '@solana/web3.js'

const ANS = new PublicKey('ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK')
const TLD_HOUSE = new PublicKey('TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S')
const ROOT = new PublicKey('3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU')
const ZERO = Buffer.alloc(32)
const hashName = (name: string) => createHash('sha256').update(`ALT Name Service${name}`).digest()
export const deriveAnsRoot = () => PublicKey.findProgramAddressSync([hashName('ANS'), ZERO, ZERO], ANS)[0]
export interface IdentityResolver {
  names(wallet: string): Promise<string[]>
}

/** Reverse display names only. Payment destinations continue to require the wallet address. */
export class SkrIdentityResolver implements IdentityResolver {
  private cache = new Map<string, { expires: number; names: string[] }>()
  constructor(private connection: Connection) {}
  async names(wallet: string) {
    const cached = this.cache.get(wallet)
    if (cached && cached.expires > Date.now()) return [...cached.names]
    if ((await this.connection.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
      throw new Error('Names require mainnet.')
    const owner = new PublicKey(wallet)
    const parent = PublicKey.findProgramAddressSync([hashName('.skr'), ZERO, ROOT.toBuffer()], ANS)[0]
    const tldHouse = PublicKey.findProgramAddressSync(
      [Buffer.from('tld_house'), Buffer.from('.skr')],
      TLD_HOUSE,
    )[0]
    const accounts = await this.connection.getProgramAccounts(ANS, {
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 8, bytes: parent.toBase58() } },
        { memcmp: { offset: 40, bytes: owner.toBase58() } },
      ],
      dataSlice: { offset: 104, length: 8 },
    })
    if (accounts.length > 1000) throw new Error('Too many name accounts to resolve.')
    const now = BigInt(Math.floor(Date.now() / 1000))
    const active = accounts.filter(
      ({ account }) =>
        account.owner.equals(ANS) &&
        account.data.length === 8 &&
        (account.data.readBigUInt64LE(0) === 0n || account.data.readBigUInt64LE(0) >= now),
    )
    const reverse = active.map(
      ({ pubkey }) =>
        PublicKey.findProgramAddressSync([hashName(pubkey.toBase58()), tldHouse.toBuffer(), ZERO], ANS)[0],
    )
    const names: string[] = []
    for (let offset = 0; offset < reverse.length; offset += 100) {
      const batch = await this.connection.getMultipleAccountsInfo(
        reverse.slice(offset, offset + 100),
        'confirmed',
      )
      for (const entry of batch) {
        if (!entry || !entry.owner.equals(ANS) || entry.data.length <= 200) continue
        const label = entry.data.subarray(200).toString('utf8').replace(/\0.*$/s, '')
        if (/^[a-z0-9-]{1,63}$/.test(label)) names.push(`${label}.skr`)
      }
    }
    names.sort()
    if (this.cache.size >= 10000) {
      for (const [address, entry] of this.cache) if (entry.expires < Date.now()) this.cache.delete(address)
      if (this.cache.size >= 10000) this.cache.delete(this.cache.keys().next().value!)
    }
    this.cache.set(wallet, { expires: Date.now() + 60 * 60_000, names })
    return [...names]
  }
}
