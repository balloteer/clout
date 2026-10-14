import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveAllowedOrigins, resolveOrigin, resolveTrustProxyHops } from '../src/runtime-config.js'

test('Vercel production derives the stable project origin and one trusted platform hop', () => {
  const env = {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_PROJECT_PRODUCTION_URL: 'Clout-API.Vercel.App',
  }
  const origin = resolveOrigin(env)
  assert.equal(origin, 'https://clout-api.vercel.app')
  assert.deepEqual(resolveAllowedOrigins(env, origin), [origin])
  assert.equal(resolveTrustProxyHops(env), '1')
})

test('explicit deployment settings override Vercel defaults', () => {
  const env = {
    NODE_ENV: 'production',
    VERCEL: '1',
    VERCEL_PROJECT_PRODUCTION_URL: 'ignored/system/path',
    CLOUT_ORIGIN: 'https://api.clout.example/',
    CLOUT_ALLOWED_ORIGINS: 'https://api.clout.example/,https://clout.example',
    CLOUT_TRUST_PROXY_HOPS: '2',
  }
  const origin = resolveOrigin(env)
  assert.equal(origin, 'https://api.clout.example')
  assert.deepEqual(resolveAllowedOrigins(env, origin), ['https://api.clout.example', 'https://clout.example'])
  assert.equal(resolveTrustProxyHops(env), '2')
})

test('production origin resolution fails closed on missing or malformed platform identity', () => {
  for (const env of [
    { NODE_ENV: 'production', VERCEL: '1' },
    { NODE_ENV: 'production', VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'bad/path' },
    { NODE_ENV: 'production', CLOUT_ORIGIN: 'http://clout.example' },
    { NODE_ENV: 'production', CLOUT_ORIGIN: 'https://user:secret@clout.example' },
    { NODE_ENV: 'production', CLOUT_ORIGIN: 'https://clout.example/path' },
  ])
    assert.throws(() => resolveOrigin(env), /CLOUT_ORIGIN|VERCEL_PROJECT_PRODUCTION_URL/)
})

test('development retains local origins while production never adds localhost implicitly', () => {
  const development = { NODE_ENV: 'development' }
  assert.deepEqual(resolveAllowedOrigins(development, resolveOrigin(development)), [
    'http://localhost:8787',
    'http://localhost:8081',
  ])
  assert.throws(
    () =>
      resolveAllowedOrigins(
        { NODE_ENV: 'production', CLOUT_ALLOWED_ORIGINS: 'https://clout.example/path' },
        'https://clout.example',
      ),
    /absolute HTTP\(S\) origins/,
  )
})
