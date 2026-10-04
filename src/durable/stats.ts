import { DurableObject } from 'cloudflare:workers'
import { ConfigSource } from '../config'

export interface StatsRecord {
  kind: 'announce' | 'scrape' | 'failure'
  infoHashHex?: string
  event?: string
}

export interface TrackerStatsSnapshot {
  startedAt: number
  announces: number
  scrapes: number
  failures: number
  started: number
  stopped: number
  completed: number
  downloads: number
  knownTorrents: number
  activeTorrents: number
}

interface Counters {
  announces: number
  scrapes: number
  failures: number
  started: number
  stopped: number
  completed: number
}

const ACTIVE_WINDOW_MS = 30 * 60 * 1000
const MAX_TRACKED_TORRENTS = 20_000

/**
 * Singleton coordination point for tracker-wide counters. Kept separate from the
 * swarm objects so a hot torrent never blocks the hot path of the statistics.
 */
export class TrackerStats extends DurableObject {
  private counters: Counters = {
    announces: 0,
    scrapes: 0,
    failures: 0,
    started: 0,
    stopped: 0,
    completed: 0,
  }
  private torrents = new Map<string, number>()
  private startedAt = Date.now()

  constructor(ctx: DurableObjectState, env: ConfigSource) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<{ counters: Counters; startedAt: number; torrents: [string, number][] }>(
        'snapshot',
      )
      if (stored) {
        this.counters = { ...this.counters, ...stored.counters }
        this.startedAt = stored.startedAt
        this.torrents = new Map(stored.torrents ?? [])
      }
      if ((await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + 60_000)
      }
    })
  }

  async record(entry: StatsRecord): Promise<void> {
    if (entry.kind === 'scrape') this.counters.scrapes++
    else if (entry.kind === 'failure') this.counters.failures++
    else {
      this.counters.announces++
      switch (entry.event) {
        case 'started':
          this.counters.started++
          break
        case 'stopped':
          this.counters.stopped++
          break
        case 'completed':
          this.counters.completed++
          break
        default:
          break
      }
      if (entry.infoHashHex) this.trackTorrent(entry.infoHashHex)
    }
  }

  async summary(): Promise<TrackerStatsSnapshot> {
    const now = Date.now()
    let activeTorrents = 0
    for (const lastSeen of this.torrents.values()) {
      if (now - lastSeen <= ACTIVE_WINDOW_MS) activeTorrents++
    }
    return {
      startedAt: this.startedAt,
      announces: this.counters.announces,
      scrapes: this.counters.scrapes,
      failures: this.counters.failures,
      started: this.counters.started,
      stopped: this.counters.stopped,
      completed: this.counters.completed,
      downloads: this.counters.completed,
      knownTorrents: this.torrents.size,
      activeTorrents,
    }
  }

  /**
   * Swarm counts are sharded across objects, so only those asked for are summed.
   */
  async totalPeers(candidates: readonly { complete: number; incomplete: number }[]): Promise<{
    complete: number
    incomplete: number
  }> {
    let complete = 0
    let incomplete = 0
    for (const candidate of candidates) {
      complete += candidate.complete
      incomplete += candidate.incomplete
    }
    return { complete, incomplete }
  }

  async reset(): Promise<void> {
    this.counters = { announces: 0, scrapes: 0, failures: 0, started: 0, stopped: 0, completed: 0 }
    this.torrents.clear()
    this.startedAt = Date.now()
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
  }

  async alarm(): Promise<void> {
    const stale: string[] = []
    const now = Date.now()
    for (const [hash, lastSeen] of this.torrents) {
      if (this.torrents.size > MAX_TRACKED_TORRENTS || now - lastSeen > 24 * 60 * 60 * 1000) {
        stale.push(hash)
      }
    }
    for (const hash of stale) this.torrents.delete(hash)

    await this.ctx.storage.put('snapshot', {
      counters: this.counters,
      startedAt: this.startedAt,
      torrents: [...this.torrents.entries()],
    })
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
  }

  private trackTorrent(infoHashHex: string): void {
    this.torrents.set(infoHashHex, Date.now())
  }
}
