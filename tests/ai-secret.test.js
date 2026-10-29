import test from 'node:test'
import assert from 'node:assert/strict'
import { isProtected, protectSecret, unprotectSecret } from '../server/ai/secret.js'

test('DPAPI roundtrip keeps the key readable only through the helper', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('DPAPI 只在 Windows 上可用')
    return
  }

  const protectedValue = await protectSecret('sk-test-123456')
  assert.ok(isProtected(protectedValue))
  assert.ok(!protectedValue.includes('sk-test-123456'))
  assert.equal(await unprotectSecret(protectedValue), 'sk-test-123456')

  // Cached second read must give the same answer.
  assert.equal(await unprotectSecret(protectedValue), 'sk-test-123456')

  // Legacy plaintext values pass through untouched.
  assert.equal(await unprotectSecret('plain-text-key'), 'plain-text-key')
  assert.equal(await protectSecret(''), '')
  assert.equal(await unprotectSecret(''), '')
})
