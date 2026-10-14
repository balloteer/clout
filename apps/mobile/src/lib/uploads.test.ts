import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertUploadSize,
  assertUploadSucceeded,
  resolveCompleteUrl,
  resolveCompletionStatus,
  resolveMaxBytes,
  resolveUploadHeaders,
  resolveUploadMethod,
  UPLOAD_COMPLETION_TIMEOUT_MS,
  UPLOAD_MAX_VIDEO_BYTES,
} from './upload-result'

test('upload method keeps local POST compatibility and accepts signed-storage PUT', () => {
  assert.equal(resolveUploadMethod(undefined), 'POST')
  assert.equal(resolveUploadMethod('POST'), 'POST')
  assert.equal(resolveUploadMethod('PUT'), 'PUT')
  assert.throws(() => resolveUploadMethod('DELETE'), /destination is not supported/)
  assert.throws(() => resolveUploadMethod('put'), /destination is not supported/)
  assert.equal(UPLOAD_MAX_VIDEO_BYTES, 50 * 1024 * 1024)
})

test('upload instructions accept only the bounded Supabase header and size contract', () => {
  assert.deepEqual(resolveUploadHeaders(undefined), {})
  assert.deepEqual(resolveUploadHeaders({ 'x-upsert': 'false' }), { 'x-upsert': 'false' })
  assert.deepEqual(resolveUploadHeaders({ 'X-Upsert': 'false' }), { 'x-upsert': 'false' })
  assert.throws(() => resolveUploadHeaders({ Authorization: 'secret' }), /destination is not supported/)
  assert.throws(() => resolveUploadHeaders({ 'x-upsert': 'true' }), /destination is not supported/)
  assert.equal(resolveMaxBytes(50 * 1024 * 1024), 50 * 1024 * 1024)
  assert.throws(() => resolveMaxBytes(-1), /destination is not supported/)
  assert.doesNotThrow(() => assertUploadSize(50 * 1024 * 1024, 50 * 1024 * 1024))
  assert.throws(() => assertUploadSize(50 * 1024 * 1024 + 1, 50 * 1024 * 1024), /50 MB/)
})

test('completion accepts only this upload and its durable processing states', () => {
  const path = '/v1/uploads/123e4567-e89b-42d3-a456-426614174000/complete'
  assert.equal(resolveCompleteUrl(path), path)
  assert.equal(resolveCompleteUrl(undefined), undefined)
  assert.throws(() => resolveCompleteUrl('https://attacker.example/complete'), /destination is not supported/)
  assert.equal(resolveCompletionStatus('ready'), 'ready')
  assert.equal(resolveCompletionStatus('processing'), 'processing')
  assert.throws(() => resolveCompletionStatus('failed'), /processing failed/)
  assert.equal(UPLOAD_COMPLETION_TIMEOUT_MS, 60_000)
})

test('upload result accepts success and preserves a server validation message', () => {
  assert.doesNotThrow(() => assertUploadSucceeded(201, '{"ok":true}'))
  assert.throws(
    () => assertUploadSucceeded(400, '{"error":{"message":"Choose a shorter video."}}'),
    /Choose a shorter video/,
  )
  assert.throws(
    () => assertUploadSucceeded(413, '{"statusCode":"413","message":"The object is too large."}'),
    /The object is too large/,
  )
  assert.throws(() => assertUploadSucceeded(500, 'not json'), /upload did not finish/)
})
