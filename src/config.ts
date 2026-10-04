/**
 * Runtime configuration, sourced from worker vars (always strings at runtime).
 */

export interface TrackerConfig {
  announceInterval: number
  minAnnounceInterval: number
  defaultNumWant: number
  maxNumWant: number
  peerTimeoutSec: number
  maxPeersPerSwarm: number
  rateLimitPerMinute: number
  scrapeEnabled: boolean
  statsPublic: boolean
  privateMode: boolean
  authTokens: Set<string>
  allowedInfoHashes: Set<string> | null
  adminToken: string | null
}

export type ConfigSource = Record<string, string | undefined>

export function readConfig(env: ConfigSource): TrackerConfig {
  const announceInterval = readNumber(env.ANNOUNCE_INTERVAL, 1800, 60, 86_400)
  const minAnnounceInterval = Math.min(
    announceInterval,
    readNumber(env.MIN_ANNOUNCE_INTERVAL, Math.max(300, Math.floor(announceInterval / 2)), 30, announceInterval),
  )

  return {
    announceInterval,
    minAnnounceInterval,
    defaultNumWant: readNumber(env.DEFAULT_NUMWANT, 50, 1, 200),
    maxNumWant: readNumber(env.MAX_NUMWANT, 100, 1, 500),
    peerTimeoutSec: readNumber(env.PEER_TIMEOUT_SEC, 2700, 300, 21_600),
    maxPeersPerSwarm: readNumber(env.MAX_PEERS_PER_SWARM, 2000, 100, 50_000),
    rateLimitPerMinute: readNumber(env.RATE_LIMIT_PER_MINUTE, 240, 0, 100_000),
    scrapeEnabled: readBoolean(env.SCRAPE_ENABLED, true),
    statsPublic: readBoolean(env.STATS_PUBLIC, true),
    privateMode: (env.TRACKER_MODE ?? 'public').toLowerCase() === 'private',
    authTokens: splitList(env.AUTH_TOKENS),
    allowedInfoHashes: env.ALLOWED_INFO_HASHES ? new Set(normaliseList(env.ALLOWED_INFO_HASHES)) : null,
    adminToken: env.ADMIN_TOKEN ? env.ADMIN_TOKEN.trim() : null,
  }
}

function readNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function readBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase())
}

function splitList(raw: string | undefined): Set<string> {
  return new Set(raw ? normaliseList(raw) : [])
}

function normaliseList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}
