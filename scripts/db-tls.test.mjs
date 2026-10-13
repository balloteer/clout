import { test } from 'node:test'
import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { checkServerIdentity } from 'node:tls'
import { databaseTls, databaseCliTlsEnv, SUPABASE_CA_SHA256 } from './db-tls.mjs'
import { connection } from './db-setup.mjs'
import { PostgresRepository } from '../apps/api/src/postgres.ts'

const pooler = 'postgresql://postgres.synthetic:fake@aws-0-us-east-1.pooler.supabase.com:5432/postgres'

test('bundled official Supabase CA has the pinned fingerprint, valid dates and CA self-signature', async () => {
  const options = databaseTls(pooler)
  const cert = new X509Certificate(options.ca)
  assert.equal(cert.fingerprint256.replaceAll(':', '').toLowerCase(), SUPABASE_CA_SHA256)
  assert.equal(cert.subject.includes('CN=Supabase Root 2021 CA'), true)
  assert.equal(cert.ca, true)
  assert.equal(cert.verify(cert.publicKey), true)
  assert.ok(Date.parse(cert.validFrom) < Date.now())
  assert.ok(Date.parse(cert.validTo) > Date.now())
  assert.equal(options.ca, await readFile(databaseCliTlsEnv(pooler).PGSSLROOTCERT, 'utf8'))
})

test('custom database trust is limited to exact Supabase host patterns and keeps hostname checks', () => {
  for (const host of ['aws-0-us-east-1.pooler.supabase.com', 'db.synthetic.supabase.co']) {
    const options = databaseTls(`postgresql://fake:fake@${host}:5432/postgres`)
    assert.ok(options.ca)
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.servername, host)
    assert.equal(options.checkServerIdentity, checkServerIdentity)
    assert.equal(options.minVersion, 'TLSv1.2')
    assert.equal(options.checkServerIdentity(host, { subjectaltname: `DNS:${host}` }), undefined)
    assert.ok(options.checkServerIdentity(host, { subjectaltname: 'DNS:attacker.example' }) instanceof Error)
  }
  for (const host of [
    'database.example',
    'supabase.co',
    'pooler.supabase.com',
    'nested.aws.pooler.supabase.com',
    'aws.pooler.supabase.com.evil.example',
    'db.synthetic.supabase.co.evil.example',
  ]) {
    const options = databaseTls(`postgresql://fake:fake@${host}:5432/postgres`)
    assert.equal(options.ca, undefined)
    assert.equal(options.rejectUnauthorized, true)
    assert.equal(options.checkServerIdentity, checkServerIdentity)
    assert.deepEqual(databaseCliTlsEnv(`postgresql://fake:fake@${host}/postgres`), {
      PGSSLMODE: 'verify-full',
    })
  }
  assert.throws(() => databaseTls('https://aws.pooler.supabase.com'), /protocol/)
})

test('loopback plaintext is opt-in and Supabase verification cannot be disabled by URL sslmode', async () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    const url = `postgresql://fake:fake@${host}/postgres`
    assert.equal(databaseTls(url, { allowLocal: true }), false)
    assert.equal(databaseTls(url).rejectUnauthorized, true)
  }
  for (const mode of ['disable', 'require', 'verify-full']) {
    const url = `${pooler}?sslmode=${mode}`
    const helper = connection(new URL(url))
    const repository = new PostgresRepository(url)
    try {
      for (const sql of [helper, repository.sql]) {
        assert.equal(sql.options.max_pipeline, 1)
        assert.equal(sql.options.ssl.rejectUnauthorized, true)
        assert.ok(sql.options.ssl.ca)
        assert.equal(sql.options.ssl.checkServerIdentity, checkServerIdentity)
        assert.equal(sql.options.ssl.servername, 'aws-0-us-east-1.pooler.supabase.com')
      }
    } finally {
      await helper.end()
      await repository.sql.end()
    }
  }
})

test('CLI trust uses an explicit certificate path and never changes process-wide TLS settings', () => {
  const keys = ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'PGSSLROOTCERT', 'PGSSLMODE']
  const before = keys.map((key) => process.env[key])
  const env = databaseCliTlsEnv(pooler)
  assert.equal(env.PGSSLMODE, 'verify-full')
  assert.ok(env.PGSSLROOTCERT.endsWith('/supabase/certs/prod-ca-2021.crt'))
  assert.deepEqual(Object.keys(env).sort(), ['PGSSLMODE', 'PGSSLROOTCERT'])
  assert.ok(keys.every((key, index) => process.env[key] === before[index]))
})
