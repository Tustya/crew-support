import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, verifyPassword } from '../src/domain/password.ts'

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
