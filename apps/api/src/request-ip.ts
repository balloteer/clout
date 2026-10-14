import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import { ApiError } from './domain.js'

/** Trust only a fixed deployment topology; never enable forwarding implicitly. */
export function parseTrustProxyHops(value: string | undefined): number {
  if (value === undefined) return 0
  if (!/^[0-8]$/.test(value)) throw new Error('CLOUT_TRUST_PROXY_HOPS must be an integer from 0 to 8.')
  return Number(value)
}

function normalizeIp(value: string): string | null {
  if (value.includes('%')) return null
  const version = isIP(value)
  if (version === 4) return value
  if (version === 6) {
    // Canonicalize equivalent IPv6 spellings so they share a rate-limit bucket.
    if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) return value.slice(7)
    return new URL(`http://[${value}]/`).hostname.slice(1, -1)
  }
  return null
}

export function requestClientIp(request: IncomingMessage, trustProxyHops: number): string {
  if (trustProxyHops === 0) return normalizeIp(request.socket.remoteAddress ?? '') ?? 'unknown'
  const header = request.headers['x-forwarded-for']
  if (typeof header !== 'string' || header.length > 2048)
    throw new ApiError(400, 'INVALID_PROXY_CHAIN', 'A valid trusted proxy forwarding chain is required.')
  const addresses = header.split(',').map((value) => normalizeIp(value.trim()))
  // Count from the socket toward the client. Additional client-supplied prefixes are not trusted.
  if (addresses.length < trustProxyHops || addresses.some((value) => value === null))
    throw new ApiError(400, 'INVALID_PROXY_CHAIN', 'A valid trusted proxy forwarding chain is required.')
  return addresses[addresses.length - trustProxyHops]!
}
