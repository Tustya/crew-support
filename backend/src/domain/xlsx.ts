import { inflateRawSync } from 'node:zlib'

export function readFirstSheet(bytes: Buffer): (string | number | null)[][] {
  const files = unzip(bytes)
  const sheetPath = Object.keys(files).find((name) => /^xl\/worksheets\/sheet1\.xml$/i.test(name))
  if (!sheetPath) return []
  const shared = readSharedStrings(files['xl/sharedStrings.xml'] ?? Buffer.alloc(0))
  const xml = files[sheetPath].toString('utf8')
  const rows: (string | number | null)[][] = []
  for (const match of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNumber = Number(/r="(\d+)"/.exec(match[1] ?? '')?.[1] ?? rows.length + 1)
    const cells: (string | number | null)[] = []
    for (const cell of match[2].matchAll(/<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /r="([A-Z]+)\d+"/.exec(cell[1] ?? '')
      const column = ref ? columnIndex(ref[1]) : cells.length
      cells[column] = cellValue(cell[1] ?? '', cell[2] ?? '', shared)
    }
    rows[rowNumber - 1] = cells
  }
  const width = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0)
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
  if (eocd < 0) return {}
  const count = bytes.readUInt16LE(eocd + 10)
  let offset = bytes.readUInt32LE(eocd + 16)
  const files: Record<string, Buffer> = {}
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break
    const method = bytes.readUInt16LE(offset + 10)
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const localOffset = bytes.readUInt32LE(offset + 42)
    const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    const localNameLength = bytes.readUInt16LE(localOffset + 26)
    const localExtraLength = bytes.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize)
    files[name] = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}
