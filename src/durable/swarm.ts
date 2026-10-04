import { DurableObject } from 'cloudflare:workers'
import { readConfig, TrackerConfig, ConfigSource } from '../config'
import { AnnounceInput, SwarmReply, SwarmStats, SwarmTable, TrackerEvent } from '../swarm'
import type { PeerRecord, PeerSeedInput } from '../peers'

export interface AnnouncePayload {
  peerId: Uint8Array
  seeds: PeerSeedInput[]
  clientFamilies: (4 | 6)[]
  event: TrackerEvent
  numwant: number
}

const SWEEP_INTERVAL_MS = 60_000

/**
 * One instance per info_hash. Peers live in memory (re-announced every
 * `interval` anyway, so persistence buys little and costs writes); alarms sweep
 * stale peers and the object wipes its own storage once the swarm empties, which
 * keeps abandoned torrents from piling up as costing object instances.
 */
export class TorrentSwarm extends DurableObject {
  private readonly table: SwarmTable
  private readonly cfg: TrackerConfig
  private sweepScheduled = false

  constructor(ctx: DurableObjectState, env: ConfigSource) {
    super(ctx, env)
    this.cfg = readConfig(env)
    this.table = new SwarmTable({
      peerTimeoutSec: this.cfg.peerTimeoutSec,
      maxPeers: this.cfg.maxPeersPerSwarm,
    })
  }

  async announce(payload: AnnouncePayload): Promise<SwarmReply> {
    this.scheduleSweep()
    const input: AnnounceInput = {
      peerId: payload.peerId,
      seeds: payload.seeds,
      clientFamilies: payload.clientFamilies,
      event: payload.event,
      numwant: payload.numwant,
    }
    return this.table.announce(input, Date.now())
  }

  async scrape(): Promise<SwarmStats> {
    return this.table.scrape(Date.now())
  }

  async sweep(): Promise<number> {
    return this.table.sweep(Date.now())
  }

  async size(): Promise<number> {
    return this.table.size
  }

  async debug(): Promise<PeerRecord[]> {
    return this.table.debug()
  }

  async purge(): Promise<void> {
    this.table.purge()
    await this.ctx.storage.deleteAll()
  }

  async alarm(): Promise<void> {
    this.sweepScheduled = false
    this.table.sweep(Date.now())
    if (this.table.size === 0) {
      await this.ctx.storage.deleteAll()
      return
    }
    this.sweepScheduled = true
    await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS)
  }

  private scheduleSweep(): void {
    if (this.sweepScheduled) return
    this.sweepScheduled = true
    void this.ctx.storage
      .setAlarm(Date.now() + SWEEP_INTERVAL_MS)
      .catch(() => {
        this.sweepScheduled = false
      })
  }
}
