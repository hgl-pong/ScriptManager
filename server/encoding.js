// Script file encodings. Windows scripts in the wild are a mix of UTF-8 (often
// with a BOM), UTF-16LE (PowerShell 5.1 `Out-File`) and legacy GBK. Node decodes
// all of them but can only encode UTF-8, so the GBK reverse table below is built
// on demand from the platform decoder — no extra dependency.

const GBK = 'gbk'
const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

function startsWith(bytes, prefix) {
  if (bytes.length < prefix.length) return false
  return prefix.every((value, index) => bytes[index] === value)
}

export function detectEncoding(bytes) {
  if (startsWith(bytes, UTF8_BOM)) return 'utf-8-bom'
  if (startsWith(bytes, UTF16LE_BOM)) return 'utf-16le'
  if (startsWith(bytes, UTF16BE_BOM)) return 'utf-16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return GBK
  }
}

// Returns { text, encoding }; the BOM is stripped from the text.
export function decodeScript(bytes) {
  const encoding = detectEncoding(bytes)
  if (encoding === 'utf-8-bom') return { text: bytes.subarray(3).toString('utf8'), encoding }
  if (encoding === 'utf-16le') return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding }
  if (encoding === 'utf-16be') return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding }
  if (encoding === 'utf-8') return { text: bytes.toString('utf8'), encoding }
  return { text: new TextDecoder(GBK).decode(bytes), encoding }
}

export function encodeScript(text, encoding = 'utf-8') {
  const body = String(text ?? '')
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from(UTF16LE_BOM), Buffer.from(body, 'utf16le')])
  if (encoding === 'utf-16be') return Buffer.concat([Buffer.from(UTF16BE_BOM), swapBytes(Buffer.from(body, 'utf16le'))])
  if (encoding === 'utf-8-bom') return Buffer.concat([Buffer.from(UTF8_BOM), Buffer.from(body, 'utf8')])
  if (encoding === GBK) return encodeGbk(body)
  return Buffer.from(body, 'utf8')
}

function swapBytes(buffer) {
  const swapped = Buffer.alloc(buffer.length)
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1]
    swapped[index + 1] = buffer[index]
  }
  return swapped
}

let gbkTable = null

function gbkReverse() {
  if (gbkTable) return gbkTable
  const decoder = new TextDecoder(GBK)
  const table = new Map()
  for (let lead = 0x81; lead <= 0xfe; lead += 1) {
    for (let trail = 0x40; trail <= 0xfe; trail += 1) {
      if (trail === 0x7f) continue
      const text = decoder.decode(Uint8Array.of(lead, trail))
      // Some GBK pairs map to two code points; those cannot be reversed per character.
      if (text.length === 1 && text !== '�' && !table.has(text)) table.set(text, [lead, trail])
    }
  }
  gbkTable = table
  return table
}

function encodeGbk(text) {
  const table = gbkReverse()
  const out = []
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code < 0x80) {
      out.push(code)
      continue
    }
    // The GBK decoder maps the single byte 0x80 to the euro sign.
    if (character === '€') {
      out.push(0x80)
      continue
    }
    const pair = table.get(character)
    if (!pair) throw new Error(`无法用 GBK 编码字符「${character}」`)
    out.push(pair[0], pair[1])
  }
  return Buffer.from(out)
}
