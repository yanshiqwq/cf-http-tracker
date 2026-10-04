/**
 * Binary-safe bencode encoder.
 *
 * BitTorrent requires dictionary keys to be sorted lexicographically by their
 * raw bytes, and string values must be measured in bytes, not JS code units --
 * encoding a binary info_hash with `.length` corrupts it (the mistake several
 * reference implementations make).
 */

export type Bencodable =
  | number
  | string
  | Uint8Array
  | RawEncoded
  | readonly Bencodable[]
  | { readonly [key: string]: Bencodable | undefined }

export type Decoded = number | Uint8Array | Decoded[] | Map<string, Decoded>

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encode(value: Bencodable): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk)
    total += chunk.length
  }

  writeValue(value, push)

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function writeValue(value: Bencodable, push: (chunk: Uint8Array) => void): void {
  if (value === null || value === undefined) {
    throw new Error('bencode: refusing to encode null/undefined')
  }

  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`bencode: ${value} is not a safe integer`)
    }
    push(textEncoder.encode(`i${value}e`))
    return
  }

  if (typeof value === 'string') {
    writeBytes(textEncoder.encode(value), push)
    return
  }

  if (value instanceof RawEncoded) {
    push(value.bytes)
    return
  }

  if (value instanceof Uint8Array) {
    writeBytes(value, push)
    return
  }

  if (Array.isArray(value)) {
    push(textEncoder.encode('l'))
    for (const item of value) writeValue(item, push)
    push(textEncoder.encode('e'))
    return
  }

  if (typeof value === 'object') {
    push(textEncoder.encode('d'))
    const record = value as { readonly [key: string]: Bencodable | undefined }
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((a, b) => compareBytes(textEncoder.encode(a), textEncoder.encode(b)))
    for (const key of keys) {
      writeValue(key, push)
      writeValue(record[key] as Bencodable, push)
    }
    push(textEncoder.encode('e'))
    return
  }

  throw new Error(`bencode: unsupported value of type ${typeof value}`)
}

function writeBytes(data: Uint8Array, push: (chunk: Uint8Array) => void): void {
  push(textEncoder.encode(`${data.length}:`))
  push(data)
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

export type DictKey = string | Uint8Array

/**
 * Wrapper for an already-encoded fragment. Without it, nesting an encoded
 * dictionary inside another one re-wraps it as a byte string
 * (`5:files72:d20:...`), which every BitTorrent client rejects.
 */
export class RawEncoded {
  constructor(readonly bytes: Uint8Array) {}
}

/**
 * Dictionary with byte-string keys. Needed by scrape, whose file map is keyed by
 * the raw 20-byte info_hash -- passing it through a JS object key would destroy
 * the bytes.
 */
export function encodeDict(entries: readonly [DictKey, Bencodable | undefined][]): Uint8Array {
  const chunks: Uint8Array[] = []
  let total = 0
  const push = (chunk: Uint8Array): void => {
    chunks.push(chunk)
    total += chunk.length
  }

  push(textEncoder.encode('d'))
  const printable = entries
    .filter((entry): entry is [DictKey, Bencodable] => entry[1] !== undefined)
    .map(([key, value]) => ({ key: toKeyBytes(key), value }))
    .sort((a, b) => compareBytes(a.key, b.key))
  for (const entry of printable) {
    writeBytes(entry.key, push)
    writeValue(entry.value, push)
  }
  push(textEncoder.encode('e'))

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function toKeyBytes(key: DictKey): Uint8Array {
  return typeof key === 'string' ? textEncoder.encode(key) : key
}

/**
 * Decoder kept for tests and debugging tools. Strings are returned as raw bytes
 * because tracker payloads are binary; call sites decode the fields they need.
 */
export function decode(input: Uint8Array): Decoded {
  let cursor = 0

  const peek = (): number => {
    if (cursor >= input.length) throw new Error('bencode: unexpected end of input')
    return input[cursor]
  }

  const readValue = (): Decoded => {
    const byte = peek()
    if (byte === 0x69 /* i */) {
      cursor++
      let negative = false
      if (input[cursor] === 0x2d /* - */) {
        negative = true
        cursor++
      }
      let value = 0
      while (cursor < input.length && input[cursor] !== 0x65 /* e */) {
        const digit = input[cursor]
        if (digit < 0x30 || digit > 0x39) {
          throw new Error('bencode: malformed integer')
        }
        value = value * 10 + (digit - 0x30)
        cursor++
      }
      cursor++
      return negative ? -value : value
    }

    if (byte === 0x6c /* l */) {
      cursor++
      const items: Decoded[] = []
      while (peek() !== 0x65 /* e */) items.push(readValue())
      cursor++
      return items
    }

    if (byte === 0x64 /* d */) {
      cursor++
      const dict = new Map<string, Decoded>()
      while (peek() !== 0x65 /* e */) {
        const rawKey = readValue()
        if (!(rawKey instanceof Uint8Array)) {
          throw new Error('bencode: dictionary key is not a byte string')
        }
        dict.set(textDecoder.decode(rawKey), readValue())
      }
      cursor++
      return dict
    }

    return readBytes()
  }

  const readBytes = (): Uint8Array => {
    const start = cursor
    while (cursor < input.length && input[cursor] !== 0x3a /* : */) {
      const digit = input[cursor]
      if (digit < 0x30 || digit > 0x39) {
        throw new Error('bencode: malformed byte string length')
      }
      cursor++
    }
    const length = Number(textDecoder.decode(input.subarray(start, cursor)))
    cursor++ // skip ':'
    const slice = input.slice(cursor, cursor + length)
    if (slice.length !== length) throw new Error('bencode: truncated byte string')
    cursor += length
    return slice
  }

  const result = readValue()
  if (cursor !== input.length) {
    throw new Error(`bencode: ${input.length - cursor} trailing bytes`)
  }
  return result
}

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
