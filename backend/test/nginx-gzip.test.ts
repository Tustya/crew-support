import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const conf = readFileSync(fileURLToPath(new URL('../../nginx.conf', import.meta.url)), 'utf8')

test('nginx compresses api and assets without changing cache policy', () => {
  assert.match(conf, /gzip on;/)
  assert.match(conf, /gzip_proxied any;/)
  assert.match(conf, /gzip_types[^;]*application\/json/)
  assert.match(conf, /gzip_types[^;]*text\/css/)
  assert.match(conf, /gzip_types[^;]*application\/javascript/)
  assert.match(conf, /gzip_types[^;]*image\/svg\+xml/)
  assert.match(conf, /add_header Cache-Control "no-store" always;/)
  assert.match(conf, /add_header Cache-Control "public, max-age=31536000, immutable" always;/)
})
