# cf-http-tracker

A **zero-dependency** BitTorrent HTTP(S) tracker built on **Cloudflare Workers + Durable Objects**.
No external resources — no D1, no KV, no R2 — just two Durable Object classes and a single `wrangler deploy`.

> 🟢 Live demo: <https://tr.sh.fyi> — a running copy of this tracker (status dashboard at `/`, announce at `/announce`).

## What it does

- **BEP 3** announce (`/announce`, `/announce.php`, `/tracker/announce`, `/<passkey>/announce`)
- **BEP 23** compact peers (6 bytes/peer, `compact=1` default) **and** old dictionary form (`compact=0`, `no_peer_id`)
- **BEP 7** IPv6 `peers6` (18 bytes/peer), dual-stack via `ipv4=`/`ipv6=` announce params
- **BEP 48** scrape (`/scrape?info_hash=…` multi-hash, `/scrape/<hex>` path form), unknown hashes omitted
- `complete` / `incomplete` / `downloaded` counters, `numwant` clamping, `interval`/`min interval`
- `event=started/stopped/completed` handling (stopped removes immediately; completed counted once)
- Bencoded `failure reason` on error, per-IP token-bucket rate limiting, private mode with passkeys/`AUTH_TOKENS`
- Status API + minimal web dashboard inlined in the Worker (no static-asset hosting needed)

## Feature matrix

| Feature | Status | Notes |
| --- | --- | --- |
| announce HTTP(S) | ✅ | `/announce`, `/announce.php`, `/tracker/announce`, `/<passkey>/announce` |
| compact peers (BEP 23) | ✅ | 6 bytes/peer binary |
| dictionary peers (`compact=0`) | ✅ | honours `peer id` + `no_peer_id` |
| IPv6 peers6 (BEP 7) | ✅ | 18 bytes/peer; dual-stack via `ipv4=`/`ipv6=` |
| scrape (BEP 48) | ✅ | multi-`info_hash`, `/scrape/<hex>`; unknown hashes omitted |
| seeders/leechers counters | ✅ | `complete`/`incomplete`/`downloaded` |
| `numwant` / `interval` / `min interval` | ✅ | numwant clamped to configured max |
| `event=started/stopped/completed` | ✅ | stopped removed immediately; completed counted once |
| bencoded failure reason | ✅ | machine-readable error responses |
| UDP tracker (BEP 15) | ❌ | Workers can't open UDP sockets |

## Why not the existing open-source ones

We evaluated the two known Workers trackers and both are unfit for modern clients:

- **[broswen/edge-tracker](https://github.com/broswen/edge-tracker)** (2022, unmaintained): the README's own TODO lists missing compact peers, missing stale-peer eviction, and no random peer selection.
- **[0xcaff/simple-torrent-tracker](https://github.com/0xcaff/simple-torrent-tracker)** (2024): dictionary-only responses (modern clients send `compact=1` and get nothing), ignores `numwant`, no `complete`/`incomplete`, no scrape, and bencodes binary fields with JS `string.length`, corrupting `peer_id`.

The "one Durable Object per info_hash" architecture is worth borrowing; the implementation here is written from scratch.

## Quick start

```bash
npm install
npm run dev            # http://127.0.0.1:8787
node scripts/smoke.mjs # protocol self-check against the local dev server

# deploy
npx wrangler login     # one-time browser OAuth
npm run deploy
```

Your announce URL is `https://<worker-name>.<your-subdomain>.workers.dev/announce`.

## Use it from a client

```
magnet:?xt=urn:btih:<40-hex-info-hash>&tr=https://your.domain/announce
```

- qBittorrent: Settings → BitTorrent → "Automatically add these trackers to new torrents" (or per-torrent: right-click → Edit trackers).
- Transmission: torrent properties → Trackers; or `transmission-edit -a https://…/announce <file.torrent>`.
- aria2: `--bt-tracker=https://…/announce` or `bt-tracker=` in `aria2.conf`.

## Configuration

Variables go in `wrangler.jsonc` → `vars`, or as secrets via `wrangler secret put`.

| Variable | Default | Description |
| --- | --- | --- |
| `TRACKER_MODE` | `public` | `private` requires a valid credential on announce/scrape |
| `AUTH_TOKENS` | — | comma-separated passkeys for private mode (**use a secret**) |
| `ALLOWED_INFO_HASHES` | — | lowercase hex allow-list; everything else → 404 |
| `ADMIN_TOKEN` | — | management endpoints + `/api/stats` when `STATS_PUBLIC=false` (**use a secret**) |
| `ANNOUNCE_INTERVAL` | `1800` | client re-announce interval (seconds) |
| `MIN_ANNOUNCE_INTERVAL` | `900` | minimum client-requested interval |
| `DEFAULT_NUMWANT` | `50` | peers returned when client omits `numwant` |
| `MAX_NUMWANT` | `100` | hard cap on peers per response |
| `PEER_TIMEOUT_SEC` | `2700` | drop peers silent this long (≈1.5 × interval) |
| `MAX_PEERS_PER_SWARM` | `2000` | per-swarm cap; evicts oldest beyond it |
| `RATE_LIMIT_PER_MINUTE` | `240` | per-IP token bucket (`0` = unlimited), per-isolate |
| `SCRAPE_ENABLED` | `true` | disable to halve request volume |
| `STATS_PUBLIC` | `true` | set `false` to guard `/api/stats` with `ADMIN_TOKEN` |

```bash
wrangler secret put AUTH_TOKENS   # private mode credentials
wrangler secret put ADMIN_TOKEN   # admin endpoints
```

## Operations endpoints

| Endpoint | Description |
| --- | --- |
| `GET /api/stats` | JSON: active/known torrents, announce counts, downloads, failures, uptime |
| `GET /api/swarm?info_hash=<hex>&token=<ADMIN_TOKEN>` | live peer list for one torrent |
| `GET\|POST /api/purge?info_hash=<hex>&token=<ADMIN_TOKEN>` | wipe a torrent's peer table |
| `GET /health` | liveness probe |
| `GET /ip` | echo the caller's IP (`CF-Connecting-IP`) |
| `GET /` | status dashboard (30s auto-refresh + per-torrent query) |

## Architecture

```
              ┌────────────────────────────────────────────┐
  client ───► │ Worker (no framework, ~27 kB bundle)       │
              │  /announce  /scrape  /api/*  /  (dashboard)│
              └───────┬──────────────────────┬─────────────┘
                      │ idFromName(hash)     │ 'global'
              ┌───────▼────────┐     ┌───────▼────────┐
              │  TorrentSwarm  │  …  │  TrackerStats  │
              │  in-memory     │     │  global counts │
              │  peer table    │     │  + active set  │
              │  alarm sweep   │     │  periodic save │
              └────────────────┘     └────────────────┘
```

- **One `TorrentSwarm` per info_hash**: single-threaded consistency with no locks; peers live in memory (clients re-announce by design, so persistence would only add write latency); a 60s alarm sweeps stale peers and the object `deleteAll()`s its own storage when the swarm empties, so abandoned torrents don't pile up as billable instances.
- **Peer identity = `family|ip|port`**: reconnecting with a new peer_id doesn't double-count, but a new port is a new peer.
- **Abuse control**: in-memory per-IP token bucket; for something harder, put Cloudflare WAF / Rate-Limiting rules in front.

## Implementation gotchas (read before hacking)

1. **Don't parse tracker queries with `URLSearchParams`**: it round-trips through UTF-8 and replaces every byte > 0x7f in `info_hash` with U+FFFD. This repo percent-decodes the raw query manually — and `+` is **not** treated as space.
2. **bencode string lengths are byte counts**: JS `string.length` mis-encodes binary fields (the upstream repos' bug).
3. **Don't pre-encode nested dictionaries**: you'd re-wrap them as byte strings (`5:files72:d20:…`) and break every client. Use the `RawEncoded` wrapper for already-encoded fragments.
4. **The dashboard is inlined** (`src/dashboard.html?raw`) instead of Workers Static Assets: no `/assets` upload flow, and no SPA-fallback-to-index.html swallowing `/announce`.
5. **IPv6 `::` sides must be handled separately**: the zero block sits *between* them; concatenating both sides and padding at the end yields wrong addresses.

## Tests

```bash
npm run test        # 34 unit tests: bencode / IP parsing / announce parsing / peer table
npm run typecheck   # tsc --noEmit
npm run build       # production bundle
node scripts/smoke.mjs https://deployed.domain  # end-to-end protocol self-check
```

`scripts/smoke.mjs` exercises compact + dictionary responses, IPv6 peers6, scrape, completed/stopped lifecycle, auth and the stats endpoint against a live deployment. It supports `HTTP(S)_PROXY` via undici for environments without direct connectivity.

## Cost notes

Every torrent is one Durable Object instance. Fine for personal/small use on the free tier; if you run a public tracker with thousands of torrents, watch Workers requests and DO requests/storage/duration billing — and consider `ALLOWED_INFO_HASHES` before going fully public.