import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AuthBusyError, hashPassword, passwordCheckPeak, resetPasswordCheckPeak, verifyPassword } from '../src/domain/password.ts'

const pepper = 'test-pepper-0123456789abcdef0123456789'

test('password hash verifies and does not keep the password', async () => {
  const encoded = await hashPassword('correct-horse', pepper)
  assert.equal(encoded.includes('correct-horse'), false)
  assert.equal(await verifyPassword('correct-horse', pepper, encoded), true)
  assert.equal(await verifyPassword('wrong-horse', pepper, encoded), false)
  assert.equal(await verifyPassword('correct-horse', 'other-pepper-0123456789abcdef0123456789', encoded), false)
})

test('corrupt password hash is rejected', async () => {
  assert.equal(await verifyPassword('correct-horse', pepper, 'not-a-hash'), false)
})

test('password checks stay within the concurrency limit and reject the overflow', async () => {
  const encoded = await hashPassword('correct-horse', pepper)
  resetPasswordCheckPeak()
  const settled = await Promise.allSettled(Array.from({ length: 19 }, () => verifyPassword('wrong-horse', pepper, encoded)))
  const busy = settled.filter((item) => item.status === 'rejected' && item.reason instanceof AuthBusyError)
  assert.ok(busy.length >= 1)
  assert.ok(passwordCheckPeak() <= 2)
  assert.ok(passwordCheckPeak() >= 1)
})
