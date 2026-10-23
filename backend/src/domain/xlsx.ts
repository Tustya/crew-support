import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { inflateRawSync } from 'node:zlib'

const MAX_ENTRIES = 64
const MAX_ENTRY_BYTES = 16 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_ROW = 5001
const MAX_COLUMN = 64
const MAX_SHARED_STRINGS = 50_000
const SHEET_NAME = 'xl/worksheets/sheet1.xml'
const STRINGS_NAME = 'xl/sharedstrings.xml'

export class XlsxLimitError extends Error {
  constructor() {
    super('IMPORT_LIMIT_EXCEEDED')
    this.name = 'XlsxLimitError'
  }
}

export function readFirstSheet(bytes: Buffer): (string | number | null)[][] {
  const files = unzip(bytes)
  const sheetPath = Object.keys(files).find((name) => name.toLowerCase() === SHEET_NAME)
  if (!sheetPath) return []
  const sharedPath = Object.keys(files).find((name) => name.toLowerCase() === STRINGS_NAME)
  const shared = readSharedStrings(files[sharedPath ?? ''] ?? Buffer.alloc(0))
  const xml = files[sheetPath].toString('utf8')
  const rows: (string | number | null)[][] = []
  for (const match of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/r="(\d+)"/.exec(match[1] ?? '')?.[1] ?? rows.length + 1)
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROW) throw new XlsxLimitError()
    const cells: (string | number | null)[] = []
    for (const cell of match[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(cell[1] ?? '')
      const column = ref ? columnIndex(ref[1]) : cells.length
      if (!Number.isSafeInteger(column) || column < 0 || column >= MAX_COLUMN) throw new XlsxLimitError()
      cells[column] = cellValue(cell[1] ?? '', cell[2] ?? '', shared)
    }
    rows[rowNumber - 1] = cells
  }
  const width = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0)
  if (width > MAX_COLUMN) throw new XlsxLimitError()
  return rows.map((row) => Array.from({ length: width }, (_, index) => row?.[index] ?? null))
}

function cellValue(attrs: string, inner: string, shared: string[]): string | number | null {
  const type = /t="([^"]+)"/.exec(attrs)?.[1]
  if (type === 'inlineStr') return decodeXml(/<t[^>]*>([\s\S]*?)<\/t>/.exec(inner)?.[1] ?? '')
  const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1]
  if (raw === undefined) return null
  const text = decodeXml(raw)
  if (type === 's') return shared[Number(text)] ?? ''
  if (type === 'b') return text === '1' ? '1' : '0'
  if (type === 'str') return text
  const numeric = Number(text)
  return Number.isFinite(numeric) ? numeric : text
}

function readSharedStrings(bytes: Buffer): string[] {
  if (bytes.length === 0) return []
  const xml = bytes.toString('utf8')
  const items: string[] = []
  for (const item of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    if (items.length >= MAX_SHARED_STRINGS) throw new XlsxLimitError()
    const parts = [...item[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => decodeXml(match[1]))
    items.push(parts.join(''))
  }
  return items
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function columnIndex(letters: string): number {
  return letters.split('').reduce((index, letter) => index * 26 + letter.charCodeAt(0) - 64, 0) - 1
}

function unzip(bytes: Buffer): Record<string, Buffer> {
  const eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0 || eocd + 22 > bytes.length) throw new XlsxLimitError()
  const count = readU16(bytes, eocd + 10)
  if (count > MAX_ENTRIES) throw new XlsxLimitError()
  let offset = readU32(bytes, eocd + 16)
  const files: Record<string, Buffer> = {}
  let totalBytes = 0
  for (let index = 0; index < count; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) throw new XlsxLimitError()
    const method = readU16(bytes, offset + 10)
    if (method !== 0 && method !== 8) throw new XlsxLimitError()
    const compressedSize = readU32(bytes, offset + 20)
    const nameLength = readU16(bytes, offset + 28)
    const extraLength = readU16(bytes, offset + 30)
    const commentLength = readU16(bytes, offset + 32)
    const localOffset = readU32(bytes, offset + 42)
    const nameEnd = offset + 46 + nameLength
    if (nameEnd + extraLength + commentLength > bytes.length) throw new XlsxLimitError()
    const name = bytes.subarray(offset + 46, nameEnd).toString('utf8')
    const normalized = name.toLowerCase()
    if (normalized === SHEET_NAME || normalized === STRINGS_NAME) {
      if (readU32(bytes, localOffset) !== 0x04034b50) throw new XlsxLimitError()
      const localNameLength = readU16(bytes, localOffset + 26)
      const localExtraLength = readU16(bytes, localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      if (dataStart + compressedSize > bytes.length) throw new XlsxLimitError()
      const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
      const inflated = method === 0 ? Buffer.from(compressed) : inflateLimited(compressed)
      if (inflated.length > MAX_ENTRY_BYTES) throw new XlsxLimitError()
      totalBytes += inflated.length
      if (totalBytes > MAX_TOTAL_BYTES) throw new XlsxLimitError()
      files[name] = inflated
    }
    offset = nameEnd + extraLength + commentLength
  }
  return files
}

function inflateLimited(compressed: Buffer): Buffer {
  try {
    return inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
  } catch (error) {
    if (error instanceof XlsxLimitError) throw error
    throw new XlsxLimitError()
  }
}

function readU16(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) throw new XlsxLimitError()
  return bytes.readUInt16LE(offset)
}

function readU32(bytes: Buffer, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) throw new XlsxLimitError()
  return bytes.readUInt32LE(offset)
}

export function readFirstSheetAsync(bytes: Buffer): Promise<(string | number | null)[][]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsx.ts', import.meta.url), { workerData: bytes, execArgv: [] })
    const finish = (error?: Error) => {
      worker.removeAllListeners()
      void worker.terminate()
      if (error) reject(error)
    }
    worker.once('message', (message: { ok: boolean; rows?: (string | number | null)[][]; limit?: boolean }) => {
      if (message.ok && message.rows) {
        finish()
        resolve(message.rows)
        return
      }
      finish(message.limit ? new XlsxLimitError() : new Error('XLSX_PARSE'))
    })
    worker.once('error', (error) => finish(error))
  })
}

if (!isMainThread && parentPort) {
  try {
    parentPort.postMessage({ ok: true, rows: readFirstSheet(Buffer.from(workerData as Uint8Array)) })
  } catch (error) {
    parentPort.postMessage({ ok: false, limit: error instanceof XlsxLimitError })
  }
}
