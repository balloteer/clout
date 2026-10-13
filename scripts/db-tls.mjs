/** Node-only database trust. Never changes the process or operating system CA store. */
import { readFileSync } from 'node:fs'
import { X509Certificate } from 'node:crypto'
import { checkServerIdentity } from 'node:tls'
import { fileURLToPath } from 'node:url'

export const SUPABASE_CA_SHA256 = '807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa'
const certificatePath = fileURLToPath(new URL('../supabase/certs/prod-ca-2021.crt', import.meta.url))
const hosted = (hostname) =>
  /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(hostname) || /^db\.[a-z0-9-]+\.supabase\.co$/.test(hostname)

function databaseUrl(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('Invalid database URL.')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database protocol.')
  return url
}

function certificate() {
  const pem = readFileSync(certificatePath, 'utf8')
  const cert = new X509Certificate(pem)
  const now = Date.now()
  if (
    pem.trim() !== cert.toString().trim() ||
    cert.fingerprint256.replaceAll(':', '').toLowerCase() !== SUPABASE_CA_SHA256 ||
    !cert.ca ||
    !cert.verify(cert.publicKey) ||
    now < Date.parse(cert.validFrom) ||
    now >= Date.parse(cert.validTo)
  )
    throw new Error('Bundled Supabase database CA requires review.')
  // Trust exactly the validated certificate, never additional PEM blocks appended to the file.
  return cert.toString()
}

export function databaseTls(value, { allowLocal = false } = {}) {
  const url = databaseUrl(value)
  if (allowLocal && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return false
  const tls = { rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' }
  return hosted(url.hostname) ? { ...tls, ca: certificate(), servername: url.hostname } : tls
}

export function databaseCliTlsEnv(value) {
  const url = databaseUrl(value)
  if (!hosted(url.hostname)) return { PGSSLMODE: 'verify-full' }
  certificate()
  return { PGSSLMODE: 'verify-full', PGSSLROOTCERT: certificatePath }
}
