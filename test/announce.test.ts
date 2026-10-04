import { describe, expect, it } from 'vitest'
import {
  buildAnnounceResponse,
  buildFailureResponse,
  buildScrapeResponse,
  parseAnnounce,
  parseRawQueryAll,
} from '../src/announce'
import { readConfig } from '../src/config'
import { decode, encode } from '../src/bencode'
import type { SwarmReply } from '../src/swarm'

const cfg = readConfig({})

const HASH = Uint8Array.from({ length: 20 }, (_, i) => i)
const PEER = Uint8Array.from({ length: 20 }, (_, i) => (i === 0 ? 0xff : i + 1))

function percentEncode(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += `%${byte.toString(16).padStart(2, '0')}`
  return out
}

function query(params: Record<string, string>): string {
  return '?' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&')
}

const baseParams = {
  info_hash: percentEncode(HASH),
  peer_id: percentEncode(PEER),
  port: '6881',
  uploaded: '0',
  downloaded: '0',
  left: '1024',
}

describe('announce parsing', () => {
  it('decodes binary info_hash byte for byte', () => {
    const result = parseAnnounce(query(baseParams), '203.0.113.9', cfg)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.infoHashBytes.length).toBe(20)
    expect([...result.value.infoHashBytes]).toEqual([...HASH])
    expect(result.value.infoHashHex).toBe('000102030405060708090a0b0c0d0e0f10111213')
    expect([...result.value.peerId]).toEqual([...PEER])
  })

  it('rejects malformed requests with a reason', () => {
    expect(parseAnnounce(query({ ...baseParams, info_hash: '' }), '1.1.1.1', cfg)).toMatchObject({ ok: false })
    expect(parseAnnounce(query({ ...baseParams, info_hash: 'abc' }), '1.1.1.1', cfg)).toMatchObject({ ok: false })
    expect(parseAnnounce(query({ ...baseParams, port: '0' }), '1.1.1.1', cfg)).toMatchObject({ ok: false })
    expect(parseAnnounce(query({ ...baseParams, port: '99999' }), '1.1.1.1', cfg)).toMatchObject({ ok: false })
    expect(parseAnnounce(query({ ...baseParams, port: 'abc' }), '1.1.1.1', cfg)).toMatchObject({ ok: false })
  })

  it('marks a peer as seeder only when left is zero', () => {
    const leech = parseAnnounce(query(baseParams), '203.0.113.9', cfg)
    const seed = parseAnnounce(query({ ...baseParams, left: '0' }), '203.0.113.9', cfg)
    expect(leech.ok && leech.value.seeds[0].seeder).toBe(false)
    expect(seed.ok && seed.value.seeds[0].seeder).toBe(true)
  })

  it('honours numwant and clamps it to the configured maximum', () => {
    const asked = parseAnnounce(query({ ...baseParams, numwant: '10' }), '203.0.113.9', cfg)
    const tooMany = parseAnnounce(query({ ...baseParams, numwant: '9999' }), '203.0.113.9', cfg)
    const none = parseAnnounce(query({ ...baseParams, numwant: '0' }), '203.0.113.9', cfg)
    const missing = parseAnnounce(query(baseParams), '203.0.113.9', cfg)
    expect(asked.ok && asked.value.numwant).toBe(10)
    expect(tooMany.ok && tooMany.value.numwant).toBe(cfg.maxNumWant)
    expect(none.ok && none.value.numwant).toBe(0)
    expect(missing.ok && missing.value.numwant).toBe(cfg.defaultNumWant)
  })

  it('prefers the explicit ip parameter and detects IPv6 clients', () => {
    const declared = parseAnnounce(query({ ...baseParams, ip: '198.51.100.7' }), '203.0.113.9', cfg)
    const ipv6 = parseAnnounce(query(baseParams), '2408:8207:1924:eb70::1', cfg)
    expect(declared.ok && declared.value.seeds[0].ip).toBe('198.51.100.7')
    expect(declared.ok && declared.value.clientFamilies).toEqual([4])
    expect(ipv6.ok && ipv6.value.clientFamilies).toEqual([6])
    expect(ipv6.ok && ipv6.value.seeds[0].family).toBe(6)
  })

  it('registers the second address family for dual-stack clients (BEP 7)', () => {
    const dual = parseAnnounce(
      query({ ...baseParams, ipv6: '2408:8207:1924:eb70::dead' }),
      '203.0.113.9',
      cfg,
    )
    expect(dual.ok).toBe(true)
    if (!dual.ok) return
    expect(dual.value.seeds).toHaveLength(2)
    expect(dual.value.clientFamilies.sort()).toEqual([4, 6])
  })

  it('keeps repeated parameters (scrape carries several info_hashes)', () => {
    const all = parseRawQueryAll(`?a=1&info_hash=${percentEncode(HASH)}&info_hash=${percentEncode(PEER)}`)
    expect(all.get('info_hash')).toHaveLength(2)
  })
})

describe('announce responses', () => {
  const seeder = {
    family: 4 as const,
    ip: '198.51.100.1',
    port: 51413,
    peerId: PEER,
    seeder: true,
    seenCompleted: false,
    lastSeen: 0,
  }
  const v6seed = { ...seeder, family: 6 as const, ip: '2408:8207:1924:eb70::1' }

  const reply: SwarmReply = {
    complete: 1,
    incomplete: 2,
    downloaded: 7,
    size: 3,
    peers: [seeder],
    peers6: [v6seed],
  }

  it('emits BEP 23 compact peers', () => {
    const body = buildAnnounceResponse(reply, {
      interval: 1800,
      minInterval: 900,
      compact: true,
      noPeerId: false,
    })
    const map = decode(body) as Map<string, Uint8Array>
    const peers = [...(map.get('peers') as Uint8Array)]
    expect(peers).toEqual([198, 51, 100, 1, 0xc8, 0xd5])
    expect(map.get('interval')).toBe(1800)
    expect(map.get('complete')).toBe(1)
    expect(map.get('incomplete')).toBe(2)
    expect(map.get('downloaded')).toBe(7)
  })

  it('emits 18-byte IPv6 peers alongside IPv4 ones', () => {
    const body = buildAnnounceResponse(reply, {
      interval: 1800,
      minInterval: 900,
      compact: true,
      noPeerId: false,
    })
    const map = decode(body) as Map<string, Uint8Array>
    const peers6 = [...(map.get('peers6') as Uint8Array)]
    expect(peers6).toHaveLength(18)
    expect(peers6.slice(0, 6)).toEqual([0x24, 0x08, 0x82, 0x07, 0x19, 0x24])
    expect(peers6.slice(16)).toEqual([0xc8, 0xd5])
  })

  it('falls back to the dictionary list form when compact=0', () => {
    const body = buildAnnounceResponse(reply, {
      interval: 1800,
      minInterval: 900,
      compact: false,
      noPeerId: true,
    })
    const map = decode(body) as Map<string, unknown>
    const peers = map.get('peers') as Map<string, unknown>[]
    expect(peers).toHaveLength(2)
    expect((peers[0].get('ip') as Uint8Array).length).toBeGreaterThan(0)
    expect(peers[0].has('peer id')).toBe(false)
  })

  it('reports failures clients can display', () => {
    const body = buildFailureResponse('invalid info_hash')
    expect(new TextDecoder().decode(body)).toBe('d14:failure reason17:invalid info_hashe')
  })
})

describe('scrape responses', () => {
  it('keys the file map by raw info_hash bytes', () => {
    const body = buildScrapeResponse(
      [
        { infoHashBytes: HASH, stats: { complete: 2, incomplete: 1, downloaded: 5, size: 3 } },
        { infoHashBytes: PEER, stats: null },
      ],
      900,
    )
    // 'd5:files' + nested 'd' + '20:' must be followed by the untouched hash
    expect([...body.subarray(12, 32)]).toEqual([...HASH])

    // unknown torrents are omitted entirely, counters are standard names
    const decoded = decode(body) as Map<string, unknown>
    const files = decoded.get('files') as Map<string, Map<string, number>>
    expect(files.size).toBe(1)
    const entry = [...files.values()][0]
    expect(entry.get('complete')).toBe(2)
    expect(entry.get('downloaded')).toBe(5)
    expect(entry.get('incomplete')).toBe(1)
    expect((decoded.get('flags') as Map<string, number>).get('min_request_interval')).toBe(900)
  })
})
