import { ipToBytes } from './ip'

export type IpFamily = 4 | 6

export interface PeerIdentity {
  family: IpFamily
  ip: string
  port: number
}

export interface PeerSeedInput extends PeerIdentity {
  seeder: boolean
}

export interface PeerRecord extends PeerIdentity {
  peerId: Uint8Array
  seeder: boolean
  seenCompleted: boolean
  lastSeen: number
}

export function peerKey(peer: PeerIdentity): string {
  return `${peer.family}|${peer.ip}|${peer.port}`
}

/**
 * BEP 23 compact format: 6 bytes per peer, 4-byte IPv4 then 2-byte big-endian
 * port. Peers that fail to encode are dropped rather than shifting the frame.
 */
export function toIPv4Compact(peers: readonly PeerRecord[]): Uint8Array {
  const entries = peers.filter((peer) => peer.family === 4)
  const out = new Uint8Array(entries.length * 6)
  let offset = 0
  for (const peer of entries) {
    const bytes = ipToBytes(peer.ip)
    if (!bytes || bytes.length !== 4) continue
    out.set(bytes, offset)
    offset += 4
    writePort(out, offset, peer.port)
    offset += 2
  }
  return out.subarray(0, offset)
}

/** BEP 7 compact IPv6 format: 16-byte address then 2-byte big-endian port. */
export function toIPv6Compact(peers: readonly PeerRecord[]): Uint8Array {
  const entries = peers.filter((peer) => peer.family === 6)
  const out = new Uint8Array(entries.length * 18)
  let offset = 0
  for (const peer of entries) {
    const bytes = ipToBytes(peer.ip)
    if (!bytes || bytes.length !== 16) continue
    out.set(bytes, offset)
    offset += 16
    writePort(out, offset, peer.port)
    offset += 2
  }
  return out.subarray(0, offset)
}

function writePort(out: Uint8Array, offset: number, port: number): void {
  out[offset] = (port >> 8) & 0xff
  out[offset + 1] = port & 0xff
}

/**
 * Partial Fisher-Yates shuffle. Returning peers in storage order would let
 * everyone peer with the same small set of "first" peers.
 */
export function pickRandom<T>(items: readonly T[], count: number): T[] {
  if (count <= 0) return []
  if (count >= items.length) {
    const copy = items.slice()
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const tmp = copy[i]
      copy[i] = copy[j]
      copy[j] = tmp
    }
    return copy
  }
  const copy = items.slice()
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i))
    const tmp = copy[i]
    copy[i] = copy[j]
    copy[j] = tmp
  }
  return copy.slice(0, count)
}
