import assert from 'node:assert/strict'
import test from 'node:test'
import { assertUploadSucceeded } from './upload-result'

test('upload result accepts success and preserves a server validation message', () => {
  assert.doesNotThrow(() => assertUploadSucceeded(201, '{"ok":true}'))
  assert.throws(
    () => assertUploadSucceeded(400, '{"error":{"message":"Choose a shorter video."}}'),
    /Choose a shorter video/,
  )
  assert.throws(() => assertUploadSucceeded(500, 'not json'), /upload did not finish/)
})
