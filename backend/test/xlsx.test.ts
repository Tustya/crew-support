import assert from 'node:assert/strict'
import test from 'node:test'
import { readFirstSheet, readFirstSheetAsync, XlsxLimitError } from '../src/domain/xlsx.ts'
import { sheetWorkbook, zipEntries } from './support/xlsx-bytes.ts'

const ENTRY_LIMIT = 16 * 1024 * 1024

function assertLimited(bytes: Buffer): void {
  assert.throws(() => readFirstSheet(bytes), (error: unknown) => error instanceof XlsxLimitError)
}

test('a large sheet parse lets the event loop run', async () => {
  const rows = Array.from({ length: 400 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${'я'.repeat(40)}</t></is></c></row>`).join('')
  let yielded = false
  const pending = readFirstSheetAsync(sheetWorkbook(rows))
  await new Promise((resolve) => setImmediate(() => {
    yielded = true
    resolve(undefined)
  }))
  assert.equal(yielded, true)
  assert.equal((await pending).length, 400)
})

test('a small sheet is read without expanding the grid', () => {
  const rows = readFirstSheet(sheetWorkbook('<row r="1"><c r="A1"><v>7</v></c></row>'))
  assert.deepEqual(rows, [[7]])
})

test('an entry past the uncompressed limit is rejected', () => {
  const data = Buffer.alloc(ENTRY_LIMIT + 1)
  assertLimited(zipEntries([{ name: 'xl/worksheets/sheet1.xml', data, method: 8 }]))
})

test('more than 64 central directory entries are rejected', () => {
  const entries = Array.from({ length: 65 }, (_, index) => ({ name: `part-${index}.xml`, data: Buffer.from('x') }))
  assertLimited(zipEntries(entries))
})

test('an unsupported method, a wild offset and a cut end record are rejected', () => {
  assertLimited(zipEntries([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<row/>'), method: 99 }]))
  const moved = zipEntries([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<row r="1"><c r="A1"><v>1</v></c></row>') }])
  const central = moved.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  moved.writeUInt32LE(0x00ffffff, central + 42)
  assertLimited(moved)
  const cut = zipEntries([{ name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<row/>') }])
  assertLimited(cut.subarray(0, cut.length - 10))
})

test('a huge row index or column is rejected before the grid is built', () => {
  assertLimited(sheetWorkbook('<row r="1000000"><c r="A1"><v>1</v></c></row>'))
  assertLimited(sheetWorkbook('<row r="1"><c r="ZZZZ1"><v>1</v></c></row>'))
})

test('too many shared strings are rejected', () => {
  const items = Array.from({ length: 50_001 }, () => '<si><t>a</t></si>').join('')
  assertLimited(zipEntries([
    { name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst>${items}</sst>`) },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') },
  ]))
})
