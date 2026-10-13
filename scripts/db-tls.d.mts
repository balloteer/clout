import type { ConnectionOptions } from 'node:tls'

export const SUPABASE_CA_SHA256: string
export function databaseTls(
  value: string | URL,
  options?: { allowLocal?: boolean },
): ConnectionOptions | false
export function databaseCliTlsEnv(value: string | URL): { PGSSLMODE: 'verify-full'; PGSSLROOTCERT?: string }
