import { buildAnnounceResponse, buildFailureResponse, buildScrapeResponse, parseAnnounce, parseRawQueryAll } from './announce'
import { fromHex, toHex } from './bencode'
import { ConfigSource, readConfig, TrackerConfig } from './config'
import dashboardHtml from './dashboard.html?raw'
import { TorrentSwarm } from './durable/swarm'
import { TrackerStats } from './durable/stats'
import type { TrackerEnv } from './types'

export { TorrentSwarm, TrackerStats }

const configCache = new WeakMap<object, TrackerConfig>()

function config(env: TrackerEnv): TrackerConfig {
  const cached = configCache.get(env)
  if (cached) return cached
  const next = readConfig(env as unknown as ConfigSource)
  configCache.set(env, next)
  return next
}

const buckets = new Map<string, { tokens: number; updated: number }>()

// In-isolate token bucket. Not cluster-wide, but it stops one misbehaving peer
// from eating the whole budget; heavier enforcement belongs in WAF rules.
function rateLimited(ip: string, perMinute: number): boolean {
  if (perMinute <= 0) return false
  const now = Date.now()
  if (buckets.size > 20_000) buckets.clear()
  const refill = perMinute / 60_000
  const entry = buckets.get(ip) ?? { tokens: perMinute, updated: now }
  const tokens = Math.min(perMinute, entry.tokens + Math.max(0, now - entry.updated) * refill)
  if (tokens < 1) {
    buckets.set(ip, { tokens, updated: now })
    return true
  }
  buckets.set(ip, { tokens: tokens - 1, updated: now })
  return false
}

function bencoded(body: Uint8Array, status = 200): Response {
  return new Response(body as BodyInit, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
      pragma: 'no-cache',
    },
  })
}

function failure(reason: string, status = 400): Response {
  return bencoded(buildFailureResponse(reason), status)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function swarmStub(env: TrackerEnv, infoHashHex: string): TorrentSwarm {
  return env.SWARM.get(env.SWARM.idFromName(infoHashHex)) as unknown as TorrentSwarm
}

function statsStub(env: TrackerEnv): TrackerStats {
  return env.STATS.get(env.STATS.idFromName('global')) as unknown as TrackerStats
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? '0.0.0.0'
}

function bearer(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header || !header.toLowerCase().startsWith('bearer ')) return null
  return header.slice(7).trim() || null
}

export default {
  async fetch(request: Request, env: TrackerEnv, ctx: ExecutionContext): Promise<Response> {
    const cfg = config(env)
    const url = new URL(request.url)
    const { pathname, search } = url
    const query = url.searchParams

    if (pathname === '/' || pathname === '/index.html') {
      return new Response(dashboardHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
      })
    }
    if (pathname === '/health') return new Response('ok\n')
    if (pathname === '/ip') return new Response(`${clientIp(request)}\n`)

    const ip = clientIp(request)
    const passkey = matchPasskey(pathname)
    const presented = (passkey ?? query.get('auth') ?? query.get('passkey') ?? bearer(request) ?? '').trim().toLowerCase()
    const authorized = cfg.privateMode ? cfg.authTokens.size > 0 && cfg.authTokens.has(presented) : true
    const admin =
      cfg.adminToken !== null && presented.length > 0 && presented === cfg.adminToken.trim().toLowerCase()

    const isAnnounce =
      pathname === '/announce' ||
      pathname === '/announce.php' ||
      pathname === '/tracker/announce' ||
      (passkey !== null && ['/announce', '/announce.php'].includes(pathname.slice(passkey.length + 1)))
    const isScrape =
      pathname === '/scrape' ||
      pathname === '/scrape.php' ||
      pathname === '/tracker/scrape' ||
      (passkey !== null && ['/scrape', '/scrape.php'].includes(pathname.slice(passkey.length + 1)))

    if (isAnnounce) return handleAnnounce({ request, env, ctx, cfg, ip, search, authorized })
    if (isScrape) return handleScrape({ request, env, ctx, cfg, ip, search, authorized, pathname })

    if (pathname.startsWith('/scrape/')) {
      const hex = decodeURIComponent(pathname.slice('/scrape/'.length)).trim().toLowerCase()
      return handleScrape({ request, env, ctx, cfg, ip, search: `?info_hash=${encodeHexToQuery(hex)}`, authorized, pathname })
    }

    if (pathname === '/api/stats') {
      if (!cfg.statsPublic && !admin) return json({ error: 'forbidden' }, 403)
      return json({
        tracker: {
          mode: cfg.privateMode ? 'private' : 'public',
          announceInterval: cfg.announceInterval,
          minAnnounceInterval: cfg.minAnnounceInterval,
          scrapeEnabled: cfg.scrapeEnabled,
        },
        stats: await statsStub(env).summary(),
        now: Date.now(),
      })
    }

    if ((pathname === '/api/purge' || pathname === '/api/swarm') && (request.method === 'GET' || request.method === 'POST')) {
      if (!admin) return json({ error: 'forbidden' }, 403)
      const raw = query.get('info_hash')
      const infoHashHex = raw ? raw.trim().toLowerCase() : null
      if (!infoHashHex || !fromHex(infoHashHex)) return json({ error: 'invalid info_hash' }, 400)
      const stub = swarmStub(env, infoHashHex)
      if (pathname === '/api/purge') {
        await stub.purge()
        return json({ purged: infoHashHex })
      }
      return json({ infoHash: infoHashHex, stats: await stub.scrape(), peers: await stub.debug() })
    }

    return new Response('not found\n', { status: 404 })
  },
}

function encodeHexToQuery(hex: string): string {
  let out = ''
  for (let i = 0; i < hex.length; i += 2) out += `%${hex.slice(i, i + 2)}`
  return out
}

/** Pulls the `<passkey>` out of `/<passkey>/announce` when the path looks like it. */
function matchPasskey(pathname: string): string | null {
  const match = /^\/([^/]+)\/(?:announce|scrape)(?:\.php)?$/.exec(pathname)
  return match ? match[1] : null
}

interface HandlerCtx {
  request: Request
  env: TrackerEnv
  ctx: ExecutionContext
  cfg: TrackerConfig
  ip: string
  search: string
  authorized: boolean
  pathname?: string
}

async function handleAnnounce(c: HandlerCtx): Promise<Response> {
  if (!c.authorized) return failure('unauthorized: invalid or missing passkey', 403)
  if (rateLimited(c.ip, c.cfg.rateLimitPerMinute)) {
    return failure('rate limited: too many requests from this ip', 429)
  }

  const parsed = parseAnnounce(c.search, c.ip, c.cfg)
  if (!parsed.ok) {
    c.ctx.waitUntil(statsStub(c.env).record({ kind: 'failure' }))
    return failure(parsed.reason, 400)
  }

  const params = parsed.value
  if (c.cfg.allowedInfoHashes && !c.cfg.allowedInfoHashes.has(params.infoHashHex)) {
    return failure('torrent not registered with this tracker', 404)
  }

  const reply = await swarmStub(c.env, params.infoHashHex).announce({
    peerId: params.peerId,
    seeds: params.seeds,
    clientFamilies: params.clientFamilies,
    event: params.event,
    numwant: params.numwant,
  })

  c.ctx.waitUntil(
    statsStub(c.env).record({ kind: 'announce', infoHashHex: params.infoHashHex, event: params.event }),
  )

  return bencoded(
    buildAnnounceResponse(reply, {
      interval: c.cfg.announceInterval,
      minInterval: c.cfg.minAnnounceInterval,
      compact: params.compact,
      noPeerId: params.noPeerId,
    }),
  )
}

async function handleScrape(c: HandlerCtx): Promise<Response> {
  if (!c.cfg.scrapeEnabled) return failure('scrape is disabled', 404)
  if (!c.authorized) return failure('unauthorized: invalid or missing passkey', 403)
  if (rateLimited(c.ip, c.cfg.rateLimitPerMinute)) {
    return failure('rate limited: too many requests from this ip', 429)
  }

  const repeated = parseRawQueryAll(c.search).get('info_hash') ?? []
  const hashes = repeated.filter((bytes) => bytes.length === 20).slice(0, 100)
  if (hashes.length === 0) return failure('no valid info_hash provided', 400)

  const entries = await Promise.all(
    hashes.map(async (infoHashBytes) => ({
      infoHashBytes,
      stats: await swarmStub(c.env, toHex(infoHashBytes)).scrape(),
    })),
  )

  c.ctx.waitUntil(statsStub(c.env).record({ kind: 'scrape' }))
  return bencoded(buildScrapeResponse(entries, c.cfg.minAnnounceInterval))
}
