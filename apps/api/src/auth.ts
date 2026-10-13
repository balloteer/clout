import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { PublicKey } from '@solana/web3.js'
import { ApiError, type Repository } from './domain.js'

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex')
export function walletAddress(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    throw new ApiError(400, 'INVALID_WALLET', 'A valid Solana wallet address is required.')
  try {
    const key = new PublicKey(value)
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('Off curve')
    return key.toBase58()
  } catch {
    throw new ApiError(400, 'INVALID_WALLET', 'A valid signing wallet address is required.')
  }
}
function decodeBase64(value: unknown, max: number): Buffer {
  if (typeof value !== 'string' || value.length > max * 2 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new ApiError(400, 'INVALID_SIGNATURE', 'Expected base64 encoded signature and signed message.')
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length > max || bytes.toString('base64') !== value)
    throw new ApiError(400, 'INVALID_SIGNATURE', 'Invalid base64 encoding.')
  return bytes
}

export class AuthService {
  constructor(
    private repository: Repository,
    private origin: string,
    private clock = Date.now,
  ) {}
  async issue(addressInput: unknown) {
    const address = walletAddress(addressInput)
    const now = this.clock()
    const id = randomBytes(24).toString('hex')
    const expiresAt = now + 5 * 60_000
    const message = `${new URL(this.origin).host} wants you to sign in with your Solana account:\n${address}\n\nSign in to Clout. This does not authorize transactions.\n\nURI: ${this.origin}\nVersion: 1\nChain ID: solana:devnet\nNonce: ${id}\nIssued At: ${new Date(now).toISOString()}\nExpiration Time: ${new Date(expiresAt).toISOString()}`
    await this.repository.putChallenge({ id, address, message, expiresAt })
    return {
      challengeId: id,
      message,
      messageBase64: Buffer.from(message).toString('base64'),
      expiresAt: new Date(expiresAt).toISOString(),
      chainId: 'solana:devnet',
    }
  }
  async verify(input: Record<string, unknown>) {
    if (typeof input.challengeId !== 'string' || !/^[a-f0-9]{48}$/.test(input.challengeId))
      throw new ApiError(400, 'INVALID_CHALLENGE', 'Invalid challenge.')
    // Atomic consumption happens before signature verification; every attempt is single-use.
    const challenge = await this.repository.consumeChallenge(input.challengeId, this.clock())
    if (!challenge)
      throw new ApiError(401, 'EXPIRED_CHALLENGE', 'Sign-in expired or was already used. Please try again.')
    const signature = decodeBase64(input.signature, 64)
    const signedMessage = decodeBase64(input.signedMessage, 2048)
    if (signature.length !== 64 || !signedMessage.equals(Buffer.from(challenge.message)))
      throw new ApiError(401, 'INVALID_SIGNATURE', 'The signed message did not match this challenge.')
    const rawKey = new PublicKey(challenge.address).toBuffer()
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]),
      format: 'der',
      type: 'spki',
    })
    if (!verify(null, signedMessage, publicKey, signature))
      throw new ApiError(401, 'INVALID_SIGNATURE', 'Wallet signature could not be verified.')
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.clock() + 24 * 60 * 60_000
    await this.repository.putSession({ hash: hashToken(token), wallet: challenge.address, expiresAt })
    const profile = await this.repository.ensureProfile(challenge.address)
    return { token, expiresAt: new Date(expiresAt).toISOString(), profile }
  }
  async session(authorization: string | undefined) {
    if (!authorization?.startsWith('Bearer ')) return null
    const token = authorization.slice(7)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null
    return this.repository.getSession(hashToken(token), this.clock())
  }
}
