import { describe, expect, it } from 'vitest'
import { decode, encode, encodeDict, fromHex, RawEncoded, toHex } from '../src/bencode'

function text(input: string): string {
  return new TextDecoder().decode(encode(input))
}

describe('bencode', () => {
  it('encodes integers', () => {
    expect(text('foo')).toBe('3:foo')
    expect(new TextDecoder().decode(encode(42))).toBe('i42e')
    expect(new TextDecoder().decode(encode(-7))).toBe('i-7e')
  })

  it('measures strings in bytes rather than code units', () => {
    // 4 bytes for an emoji that is 2 UTF-16 units long.
    expect(text('🙂')).toBe('4:🙂')
  })

  it('encodes lists and dictionaries with sorted keys', () => {
    expect(new TextDecoder().decode(encode([1, 'a', 2]))).toBe('li1e1:ai2ee')
    const dict = encode({ z: 1, a: 2, m: 3 })
    expect(new TextDecoder().decode(dict)).toBe('d1:ai2e1:mi3e1:zi1ee')
  })

  it('keeps raw binary intact', () => {
    const payload = new Uint8Array([0x00, 0xff, 0x80, 0x2b])
    const encoded = encode({ 'failure reason': payload })
    expect(new TextDecoder().decode(encoded.slice(0, 14))).toBe('d14:failure re')
    expect([...encoded.slice(-5, -1)]).toEqual([0x00, 0xff, 0x80, 0x2b])
  })

  it('round-trips a tracker response', () => {
    const body = encode({
      'interval': 1800,
      'min interval': 900,
      'complete': 3,
      'incomplete': 2,
      'peers': new Uint8Array([10, 0, 0, 1, 26, 225]),
    })
    const decoded = decode(body)
    expect(decoded).toBeInstanceOf(Map)
    const map = decoded as Map<string, unknown>
    expect(map.get('interval')).toBe(1800)
    expect(map.get('min interval')).toBe(900)
    expect([...(map.get('peers') as Uint8Array)]).toEqual([10, 0, 0, 1, 26, 225])
  })

  it('supports byte-string dictionary keys for scrape', () => {
    const infoHash = new Uint8Array(20).fill(0xab)
    const body = encodeDict([
      [
        'files',
        new RawEncoded(encodeDict([[infoHash, { complete: 1, downloaded: 2, incomplete: 3 }]])),
      ],
    ])
    const head = new TextDecoder().decode(body.subarray(0, 12))
    expect(head).toBe('d5:filesd20:')
    // and once again on the nested level: 'd5:files' + 'd' + '20:'
    expect([...body.subarray(12, 32)]).toEqual([...infoHash])
  })

  it('hex helpers behave', () => {
    const bytes = new Uint8Array([0x00, 0x0f, 0xff, 0x10])
    expect(toHex(bytes)).toBe('000fff10')
    expect([...(fromHex(toHex(bytes)) ?? [])]).toEqual([0x00, 0x0f, 0xff, 0x10])
    expect(fromHex('abc')).toBeNull()
    expect(fromHex('zz')).toBeNull()
  })
})
