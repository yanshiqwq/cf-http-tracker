import { PeerRecord, PeerSeedInput, peerKey, pickRandom } from './peers'

export type TrackerEvent = 'started' | 'stopped' | 'completed' | ''

export interface AnnounceInput {
  peerId: Uint8Array
  seeds: readonly PeerSeedInput[]
  clientFamilies: readonly (4 | 6)[]
  event: TrackerEvent
  numwant: number
}

export interface SwarmReply {
  complete: number
  incomplete: number
  downloaded: number
  size: number
  peers: PeerRecord[]
  peers6: PeerRecord[]
}

export interface SwarmStats {
  complete: number
  incomplete: number
  downloaded: number
  size: number
}

export interface SwarmTableOptions {
  peerTimeoutSec: number
  maxPeers: number
}

/**
 * Pure in-memory peer table. Deliberately free of any Cloudflare API so it can
 * be unit tested directly; the Durable Object is a thin wrapper around it.
 */
export class SwarmTable {
  private readonly table = new Map<string, PeerRecord>()
  private downloaded = 0
  private readonly peerTimeoutMs: number
  private readonly maxPeers: number

  constructor(options: SwarmTableOptions) {
    this.peerTimeoutMs = Math.max(60, options.peerTimeoutSec) * 1000
    this.maxPeers = Math.max(1, options.maxPeers)
  }

  get size(): number {
    return this.table.size
  }

  announce(input: AnnounceInput, now: number = Date.now()): SwarmReply {
    this.sweep(now)
    const selfKeys = new Set(input.seeds.map(peerKey))

    if (input.event === 'stopped') {
      for (const key of selfKeys) this.table.delete(key)
      const stats = this.counts()
      return { ...stats, peers: [], peers6: [] }
    }

    for (const seed of input.seeds) {
      const key = peerKey(seed)
      const existing = this.table.get(key)
      // Only the transition into "completed" counts as a finished download,
      // otherwise every re-announce of an already complete peer inflates it.
      // A peer whose *first* announce is `completed` counts as well -- that
      // happens after a client restart.
      if (input.event === 'completed' && !(existing && existing.seenCompleted)) {
        this.downloaded++
      }
      this.table.set(key, {
        family: seed.family,
        ip: seed.ip,
        port: seed.port,
        peerId: input.peerId,
        seeder: seed.seeder,
        seenCompleted: (existing?.seenCompleted ?? false) || input.event === 'completed',
        lastSeen: now,
      })
    }

    this.enforceLimit()

    const stats = this.counts()
    if (input.numwant <= 0) return { ...stats, peers: [], peers6: [] }

    const candidates: PeerRecord[] = []
    for (const record of this.table.values()) {
      if (!selfKeys.has(peerKey(record))) candidates.push(record)
    }

    let budget = input.numwant
    const wantedIpv4 = candidates.filter((record) => record.family === 4)
    const wantedIpv6 = candidates.filter((record) => record.family === 6)

    // Client family first: an IPv4-only client has no use for 18-byte peers6
    // entries when the swarm still has usable IPv4 peers.
    const preferV4 = input.clientFamilies.includes(4)
    const takeV4 = preferV4 ? Math.min(budget, wantedIpv4.length) : 0
    budget -= takeV4
    const takeV6 = Math.min(budget, wantedIpv6.length)

    return {
      ...stats,
      peers: pickRandom(wantedIpv4, takeV4),
      peers6: pickRandom(wantedIpv6, takeV6),
    }
  }

  scrape(now: number = Date.now()): SwarmStats {
    this.sweep(now)
    return this.counts()
  }

  /** Returns how many peers were dropped. */
  sweep(now: number = Date.now()): number {
    let dropped = 0
    for (const [key, record] of this.table) {
      if (now - record.lastSeen > this.peerTimeoutMs) {
        this.table.delete(key)
        dropped++
      }
    }
    return dropped
  }

  purge(): void {
    this.table.clear()
    this.downloaded = 0
  }

  debug(): PeerRecord[] {
    return [...this.table.values()].map((record) => ({
      ...record,
      peerId: record.peerId.slice(0),
    }))
  }

  private counts(): SwarmStats {
    let complete = 0
    let incomplete = 0
    for (const record of this.table.values()) {
      if (record.seeder) complete++
      else incomplete++
    }
    return { complete, incomplete, downloaded: this.downloaded, size: this.table.size }
  }

  private enforceLimit(): void {
    if (this.table.size <= this.maxPeers) return
    const oldestFirst = [...this.table.entries()].sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen,
    )
    let excess = this.table.size - this.maxPeers
    for (const [key] of oldestFirst) {
      if (excess-- <= 0) break
      this.table.delete(key)
    }
  }
}
