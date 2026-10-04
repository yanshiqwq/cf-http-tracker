import type { TorrentSwarm } from './durable/swarm'
import type { TrackerStats } from './durable/stats'

export interface TrackerEnv {
  SWARM: DurableObjectNamespace<TorrentSwarm>
  STATS: DurableObjectNamespace<TrackerStats>
  [key: string]: unknown
}
