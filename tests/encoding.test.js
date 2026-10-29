import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeScript, detectEncoding, encodeScript } from '../server/encoding.js'

const GBK_NIHAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好
const GBK_SAN = Buffer.from([0xc8, 0xfd]) // 三

test('detectEncoding recognizes both BOMs, strict UTF-8 and GBK', () => {
  assert.equal(detectEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), 'utf-8-bom')
  assert.equal(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00])), 'utf-16le')
  assert.equal(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61])), 'utf-16be')
  assert.equal(detectEncoding(Buffer.from('echo 你好', 'utf8')), 'utf-8')
  assert.equal(detectEncoding(GBK_NIHAO), 'gbk')
  assert.equal(detectEncoding(Buffer.alloc(0)), 'utf-8')
})

test('decodeScript strips BOMs and decodes each encoding', () => {
  assert.deepEqual(decodeScript(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好')])), {
    text: '你好',
    encoding: 'utf-8-bom',
  })

  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('你好', 'utf16le')])
  assert.deepEqual(decodeScript(le), { text: '你好', encoding: 'utf-16le' })

  const be = Buffer.from([0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d])
  assert.deepEqual(decodeScript(be), { text: '你好', encoding: 'utf-16be' })

  assert.deepEqual(decodeScript(GBK_NIHAO), { text: '你好', encoding: 'gbk' })
})

test('encodeScript writes the requested encoding byte-for-byte', () => {
  assert.deepEqual([...encodeScript('你好', 'gbk')], [...GBK_NIHAO])
  assert.deepEqual([...encodeScript('echo 三', 'gbk')], [...Buffer.from('echo '), ...GBK_SAN])

  assert.deepEqual(
    [...encodeScript('你好', 'utf-16le')],
    [0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59],
  )
  assert.deepEqual(
    [...encodeScript('你好', 'utf-16be')],
    [0xfe, 0xff, 0x4f, 0x60, 0x59, 0x7d],
  )
  assert.deepEqual([...encodeScript('ok', 'utf-8-bom')], [0xef, 0xbb, 0xbf, 0x6f, 0x6b])
  assert.deepEqual([...encodeScript('ok', 'utf-8')], [0x6f, 0x6b])
})

test('GBK roundtrip keeps Chinese text and rejects unencodable characters', () => {
  const original = 'echo 你好\r\necho 三\r\n'
  assert.equal(decodeScript(encodeScript(original, 'gbk')).text, original)
  assert.deepEqual([...encodeScript('€', 'gbk')], [0x80])
  assert.throws(() => encodeScript('🙂', 'gbk'), /GBK/)
})
