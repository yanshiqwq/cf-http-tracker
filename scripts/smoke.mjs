/**
 * End-to-end check against a running tracker (local dev or deployed).
 *
 *   node scripts/smoke.mjs                         # http://127.0.0.1:8787
 *   node scripts/smoke.mjs https://tracker.example.com
 *
 * Every peer is simulated with the `ip` parameter, which is what real clients
 * behind NAT would rely on anyway.
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')

// Node's built-in fetch ignores HTTPS_PROXY; bridge it through undici when a
// proxy is set (useful when the target is a Cloudflare workers.dev URL).
try {
  const { ProxyAgent, setGlobalDispatcher } = await import('undici')
  const proxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy
  if (proxy) setGlobalDispatcher(new ProxyAgent(proxy))
} catch {
  /* undici is optional — local dev needs no proxy */
}

let failures = 0
function check(label, condition, detail = '') {
  const ok = Boolean(condition)
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? ` -- ${detail}` : ''}`)
}

/* ---------- minimal bencode decoder ---------- */
function decodeBytes(buf) {
  let pos = 0
  const read = () => {
    const byte = buf[pos]
    if (byte === 0x69) {
      pos++
      let end = buf.indexOf(0x65, pos)
      const num = Number(buf.subarray(pos, end).toString())
      pos = end + 1
      return num
    }
    if (byte === 0x6c) {
      pos++
      const out = []
      while (buf[pos] !== 0x65) out.push(read())
      pos++
      return out
    }
    if (byte === 0x64) {
      pos++
      const out = {}
      while (buf[pos] !== 0x65) {
        const raw = read()
        const key = Buffer.from(raw).toString('latin1')
        out[key] = read()
      }
      pos++
      return out
    }
    if (byte >= 0x30 && byte <= 0x39) {
      let end = pos
      while (buf[end] !== 0x3a) end++
      const len = Number(buf.subarray(pos, end).toString())
      pos = end + 1
      const slice = buf.subarray(pos, pos + len)
      pos += len
      return slice
    }
    throw new Error(`bad byte 0x${byte.toString(16)} at ${pos}`)
  }
  const value = read()
  if (pos !== buf.length) throw new Error(`${buf.length - pos} trailing bytes`)
  return value
}

/* ---------- helpers ---------- */
const randomBytes = (n) => Buffer.from(Array.from({ length: n }, () => Math.floor(Math.random() * 256)))
const pct = (bytes) => [...bytes].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')

const infoHash = randomBytes(20)
const seederId = randomBytes(20)
const leecherId = randomBytes(20)
const observerId = randomBytes(20)

async function announce(peerId, ip, { port = 6881, left = 0, event = '', compact = 1, numwant = 50, extra = '' } = {}) {
  const params = [
    `info_hash=${pct(infoHash)}`,
    `peer_id=${pct(peerId)}`,
    `port=${port}`,
    `uploaded=0&downloaded=0&left=${left}`,
    `compact=${compact}&numwant=${numwant}`,
    event ? `event=${event}` : '',
    `ip=${ip}`,
    extra,
  ]
    .filter(Boolean)
    .join('&')
  const res = await fetch(`${BASE}/announce?${params}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return { status: res.status, body: decodeBytes(buf), raw: buf }
}

function peersFromCompact(blob) {
  const out = []
  for (let i = 0; i + 6 <= blob.length; i += 6) {
    out.push(`${blob[i]}.${blob[i + 1]}.${blob[i + 2]}.${blob[i + 3]}:${blob.readUInt16BE(i + 4)}`)
  }
  return out
}

async function scrape(hashes) {
  const query = hashes.map((h) => `info_hash=${pct(h)}`).join('&')
  const res = await fetch(`${BASE}/scrape?${query}`)
  return { status: res.status, body: decodeBytes(Buffer.from(await res.arrayBuffer())) }
}

/* ---------- test sequence ---------- */
console.log(`tracker smoke test -> ${BASE}`)
console.log(`info_hash: ${infoHash.toString('hex')}\n`)

// 1. first leecher joins
{
  const res = await announce(leecherId, '203.0.113.10', { left: 100, event: 'started' })
  check('announce #1 accepted', res.status === 200, `http ${res.status}`)
  check('own peer is excluded from reply', (res.body.peers ?? Buffer.alloc(0)).length === 0)
  check('counts itself as an incomplete peer', res.body.incomplete === 1, `incomplete=${res.body.incomplete}`)
  check('advertises an interval', res.body.interval > 0, `interval=${res.body.interval}`)
}

// 2. seeder joins, sees the leecher as 6 compact bytes
{
  const res = await announce(seederId, '203.0.113.20', { left: 0, port: 51413, event: 'started' })
  const list = peersFromCompact(res.body.peers)
  check('seeder sees leecher', list.includes('203.0.113.10:6881'), JSON.stringify(list))
  check('one seeder counted', res.body.complete === 1, `complete=${res.body.complete}`)
  check('one leecher counted', res.body.incomplete === 1, `incomplete=${res.body.incomplete}`)
}

// 3. leecher finishes -> completed event bumps downloaded once
{
  await announce(leecherId, '203.0.113.10', { left: 0, event: 'completed' })
  const res = await announce(leecherId, '203.0.113.10', { left: 0, event: 'completed' })
  check('downloaded counter does not double count', res.body.downloaded === 1, `downloaded=${res.body.downloaded}`)
  check('finished peer is now a seeder', res.body.complete === 2, `complete=${res.body.complete}`)
}

// 4. non-compact form still works
{
  const res = await announce(observerId, '198.51.100.7', { left: 100, compact: 0 })
  const list = res.body.peers
  check('dictionary peer list returned', Array.isArray(list) && list.length === 2, `entries=${list?.length}`)
  const entry = Array.isArray(list) ? list[0] : {}
  check('dictionary entries carry ip and port', entry.ip && entry.port, JSON.stringify(Object.keys(entry)))
  check('dictionary entries carry peer id unless no_peer_id', entry['peer id']?.length === 20)
}

// 5. scrape
{
  const res = await scrape([infoHash, randomBytes(20)])
  const key = Buffer.from(infoHash).toString('latin1')
  const file = res.body.files?.[key]
  check('scrape returns the known torrent', Boolean(file), Object.keys(res.body.files ?? {}).length + ' entries')
  check('scrape reports seeders', file?.complete?.toString() === '2', `complete=${file?.complete}`)
  check('scrape reports downloads', file?.downloaded?.toString() === '1', `downloaded=${file?.downloaded}`)
}

// 6. protocol failures come back bencoded, not HTML
{
  const res = await fetch(`${BASE}/announce?peer_id=${pct(leecherId)}&port=6881&left=0`)
  const body = decodeBytes(Buffer.from(await res.arrayBuffer()))
  check('missing info_hash is rejected', res.status === 400 && body['failure reason'], String(body['failure reason']))
}

// 7. graceful stop removes the peer immediately
{
  const stopped = await announce(observerId, '198.51.100.7', { left: 100, event: 'stopped' })
  check('stopped peer leaves the swarm', stopped.body.incomplete === 0, `incomplete=${stopped.body.incomplete}`)
  check('stopped peer gets no peers back', (stopped.body.peers ?? Buffer.alloc(0)).length === 0)
  // and re-announcing later re-registers it (that is how clients resume)
  const resumed = await announce(observerId, '198.51.100.7', { left: 100 })
  check('re-announce rejoins the swarm', resumed.body.incomplete === 1, `incomplete=${resumed.body.incomplete}`)
  await announce(observerId, '198.51.100.7', { left: 100, event: 'stopped' })
}

// 8. IPv6 peers ride in peers6 (BEP 7)
{
  await announce(randomBytes(20), '2408:8207:1924:eb70::1', { left: 0, port: 6881 })
  const res = await announce(randomBytes(20), '203.0.113.30', {
    left: 100,
    extra: 'ipv6=2408%3A8207%3A1924%3Aeb70%3A%3Adead',
  })
  const peers6 = res.body.peers6
  check('dual-stack client receives peers6', Buffer.isBuffer(peers6) && peers6.length === 18, `bytes=${peers6?.length}`)
  check('IPv6 peer is the one that joined', peers6?.toString('hex').startsWith('240882071924eb70'), peers6?.subarray(0, 8).toString('hex'))
}

// 8. operator endpoints
{
  const res = await fetch(`${BASE}/api/stats`)
  const json = res.ok ? await res.json() : null
  check('/api/stats responds', res.ok && json.tracker, `http ${res.status}`)
  check('every announce was counted', (json?.stats?.announces ?? 0) >= 9, `announces=${json?.stats?.announces}`)
  check('active torrent tracked', (json?.stats?.activeTorrents ?? 0) >= 1, `active=${json?.stats?.activeTorrents}`)
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
