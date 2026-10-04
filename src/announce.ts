import { Bencodable, DictKey, encode, encodeDict, RawEncoded, toHex } from './bencode'
import type { TrackerConfig } from './config'
import { detectFamily, IpFamily } from './ip'
import { PeerSeedInput, toIPv4Compact, toIPv6Compact } from './peers'
import type { SwarmReply, SwarmStats, TrackerEvent } from './swarm'

const textDecoder = new TextDecoder()

export interface AnnounceParams {
  infoHashBytes: Uint8Array
  infoHashHex: string
  peerId: Uint8Array
  port: number
  left: number
  event: TrackerEvent
  seeds: PeerSeedInput[]
  clientFamilies: IpFamily[]
  numwant: number
  compact: boolean
  noPeerId: boolean
}

export type ParseResult = { ok: true; value: AnnounceParams } | { ok: false; reason: string }

/**
 * `URLSearchParams` round-trips through UTF-8 and silently replaces every byte
 * above 0x7f with U+FFFD -- fatal for binary info_hash / peer_id values. So the
 * query string is decoded byte by byte instead. `+` is deliberately NOT treated
 * as space for the same reason.
 */
export function parseRawQuery(search: string): Map<string, Uint8Array> {
  const all = parseRawQueryAll(search)
  const first = new Map<string, Uint8Array>()
  for (const [key, values] of all) first.set(key, values[0])
  return first
}

/** Keeps every repetition of a key -- scrape can carry several info_hash params. */
export function parseRawQueryAll(search: string): Map<string, Uint8Array[]> {
  const out = new Map<string, Uint8Array[]>()
  const query = search.startsWith('?') ? search.slice(1) : search
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue
    const separator = pair.indexOf('=')
    const rawKey = separator < 0 ? pair : pair.slice(0, separator)
    const rawValue = separator < 0 ? '' : pair.slice(separator + 1)
    const key = textDecoder.decode(percentDecode(rawKey))
    const existing = out.get(key)
    if (existing) existing.push(percentDecode(rawValue))
    else out.set(key, [percentDecode(rawValue)])
  }
  return out
}

function percentDecode(input: string): Uint8Array {
  const bytes: number[] = []
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (char === '%' && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3)
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16))
        i += 2
        continue
      }
    }
    for (const byte of encodeUtf8(char)) bytes.push(byte)
  }
  return new Uint8Array(bytes)
}

function encodeUtf8(char: string): Uint8Array {
  return new TextEncoder().encode(char)
}

function getText(params: Map<string, Uint8Array>, key: string): string | null {
  const raw = params.get(key)
  if (!raw) return null
  const text = textDecoder.decode(raw).trim()
  return text.length > 0 ? text : null
}

function getNumber(params: Map<string, Uint8Array>, key: string): number | null {
  const text = getText(params, key)
  if (text === null) return null
  if (!/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) ? value : null
}

export function parseAnnounce(search: string, clientIp: string, cfg: TrackerConfig): ParseResult {
  const params = parseRawQuery(search)

  const infoHash = params.get('info_hash')
  if (!infoHash || infoHash.length !== 20) {
    return failure('invalid info_hash: expected 20 raw bytes')
  }

  const peerId = params.get('peer_id')
  if (!peerId || peerId.length !== 20) {
    return failure('invalid peer_id: expected 20 raw bytes')
  }

  const port = getNumber(params, 'port')
  if (port === null || port < 1 || port > 65535) {
    return failure('invalid port')
  }

  const left = Math.max(0, getNumber(params, 'left') ?? 0)
  const rawEvent = getText(params, 'event') ?? ''
  const event: TrackerEvent =
    rawEvent === 'started' || rawEvent === 'stopped' || rawEvent === 'completed' ? rawEvent : ''

  // Spec default is 0 (dictionary list), but virtually every modern client asks
  // for compact explicitly, so honour whatever was requested.
  const compact = (getText(params, 'compact') ?? '0') !== '0'
  const noPeerId = getText(params, 'no_peer_id') === '1'

  const requestedWant = getNumber(params, 'numwant')
  const numwant =
    requestedWant === null ? cfg.defaultNumWant : Math.min(cfg.maxNumWant, Math.max(0, requestedWant))

  const primaryIp = getText(params, 'ip') ?? clientIp
  const primaryFamily = detectFamily(primaryIp)
  if (!primaryFamily) {
    return failure('invalid ip')
  }

  const seeder = left === 0
  const seeds: PeerSeedInput[] = [{ family: primaryFamily, ip: primaryIp, port, seeder }]
  const families: IpFamily[] = [primaryFamily]

  // BEP 7: a client behind dual stack advertises the other family explicitly.
  const declaredV4 = getText(params, 'ipv4')
  if (declaredV4 && primaryFamily !== 4 && detectFamily(declaredV4) === 4) {
    seeds.push({ family: 4, ip: declaredV4, port, seeder })
    families.push(4)
  }
  const declaredV6 = getText(params, 'ipv6')
  if (declaredV6 && primaryFamily !== 6 && detectFamily(declaredV6) === 6) {
    seeds.push({ family: 6, ip: declaredV6, port, seeder })
    families.push(6)
  }

  return {
    ok: true,
    value: {
      infoHashBytes: infoHash,
      infoHashHex: toHex(infoHash),
      peerId,
      port,
      left,
      event,
      seeds,
      clientFamilies: families,
      numwant,
      compact,
      noPeerId,
    },
  }
}

function failure(reason: string): ParseResult {
  return { ok: false, reason }
}

export function buildAnnounceResponse(
  reply: SwarmReply,
  options: { interval: number; minInterval: number; compact: boolean; noPeerId: boolean },
): Uint8Array {
  const dict: Record<string, Bencodable> = {
    'interval': options.interval,
    'min interval': options.minInterval,
    'complete': reply.complete,
    'incomplete': reply.incomplete,
    'downloaded': reply.downloaded,
  }

  if (options.compact) {
    dict['peers'] = toIPv4Compact(reply.peers)
    if (reply.peers6.length > 0) dict['peers6'] = toIPv6Compact(reply.peers6)
  } else {
    const listed: Bencodable[] = []
    for (const peer of [...reply.peers, ...reply.peers6]) {
      const entry: Record<string, Bencodable> = { ip: peer.ip, port: peer.port }
      if (!options.noPeerId) entry['peer id'] = peer.peerId
      listed.push(entry)
    }
    dict['peers'] = listed
  }

  return encode(dict)
}

export function buildScrapeResponse(
  entries: readonly { infoHashBytes: Uint8Array; stats: SwarmStats | null }[],
  minInterval: number,
): Uint8Array {
  const files: [DictKey, Bencodable][] = []
  for (const entry of entries) {
    if (!entry.stats) continue
    files.push([
      entry.infoHashBytes,
      {
        complete: entry.stats.complete,
        downloaded: entry.stats.downloaded,
        incomplete: entry.stats.incomplete,
      },
    ])
  }

  return encodeDict([
    ['files', new RawEncoded(encodeDict(files))],
    ['flags', { min_request_interval: minInterval }],
  ])
}

export function buildFailureResponse(reason: string): Uint8Array {
  return encode({ 'failure reason': reason })
}
