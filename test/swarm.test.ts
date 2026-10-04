import { describe, expect, it } from 'vitest'
import { SwarmTable } from '../src/swarm'
import type { PeerSeedInput } from '../src/peers'
import { pickRandom, toIPv4Compact, toIPv6Compact } from '../src/peers'

const options = { peerTimeoutSec: 1800, maxPeers: 100 }
const PEER_ID = new Uint8Array(20).fill(7)

function seed(ip: string, port: number, seeder: boolean, family: 4 | 6 = 4): PeerSeedInput {
  return { ip, port, seeder, family }
}

describe('swarm bookkeeping', () => {
  it('counts seeders and leechers and never returns the caller itself', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000

    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: 'started', numwant: 50 }, t)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('2.2.2.2', 6882, false)], clientFamilies: [4], event: 'started', numwant: 50 }, t + 1)
    const reply = swarm.announce({ peerId: PEER_ID, seeds: [seed('3.3.3.3', 6883, false)], clientFamilies: [4], event: '', numwant: 50 }, t + 2)

    expect(reply.complete).toBe(1)
    expect(reply.incomplete).toBe(2)
    expect(reply.size).toBe(3)
    expect(reply.peers.map((p) => p.ip).sort()).toEqual(['1.1.1.1', '2.2.2.2'])
  })

  it('treats a re-announce from the same ip:port as the same peer', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, false)], clientFamilies: [4], event: 'started', numwant: 50 }, t)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: 'completed', numwant: 50 }, t + 1000)
    expect(swarm.size).toBe(1)
    expect(swarm.scrape(t + 2000).complete).toBe(1)
  })

  it('drops a peer on the stopped event', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, false)], clientFamilies: [4], event: 'started', numwant: 50 }, t)
    const reply = swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, false)], clientFamilies: [4], event: 'stopped', numwant: 50 }, t + 1)
    expect(reply.size).toBe(0)
    expect(reply.peers).toHaveLength(0)
    expect(swarm.size).toBe(0)
  })

  it('counts each completed transition exactly once', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, false)], clientFamilies: [4], event: 'started', numwant: 0 }, t)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: 'completed', numwant: 0 }, t + 1)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: 'completed', numwant: 0 }, t + 2)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: '', numwant: 0 }, t + 3)
    expect(swarm.scrape(t + 4).downloaded).toBe(1)
  })

  it('sweeps peers that stop announcing', () => {
    const swarm = new SwarmTable({ peerTimeoutSec: 100, maxPeers: 100 })
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: 'started', numwant: 0 }, t)
    expect(swarm.scrape(t + 99_000).size).toBe(1)
    expect(swarm.scrape(t + 101_000).size).toBe(0)
  })

  it('evicts the oldest peers past the swarm cap', () => {
    const swarm = new SwarmTable({ peerTimeoutSec: 3600, maxPeers: 2 })
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: '', numwant: 0 }, t)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('2.2.2.2', 6882, true)], clientFamilies: [4], event: '', numwant: 0 }, t + 1)
    swarm.announce({ peerId: PEER_ID, seeds: [seed('3.3.3.3', 6883, true)], clientFamilies: [4], event: '', numwant: 0 }, t + 2)
    expect(swarm.size).toBe(2)
    const ips = swarm.debug().map((peer) => peer.ip).sort()
    expect(ips).toEqual(['2.2.2.2', '3.3.3.3'])
  })

  it('respects the numwant budget, preferring the client address family', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000
    for (let i = 1; i <= 4; i++) {
      swarm.announce({ peerId: PEER_ID, seeds: [seed(`10.0.0.${i}`, 6881, true)], clientFamilies: [4], event: '', numwant: 0 }, t + i)
      swarm.announce({ peerId: PEER_ID, seeds: [seed(`2408:8207::${i}`, 6881, true, 6)], clientFamilies: [6], event: '', numwant: 0 }, t + i)
    }

    // IPv4 caller spends the whole budget on IPv4 peers first
    const v4 = swarm.announce({ peerId: PEER_ID, seeds: [seed('203.0.113.1', 6999, true)], clientFamilies: [4], event: '', numwant: 2 }, t + 10)
    expect(v4.peers).toHaveLength(2)
    expect(v4.peers6).toHaveLength(0)

    // IPv6 caller gets IPv6 peers
    const v6 = swarm.announce({ peerId: PEER_ID, seeds: [seed('2408:8207::99', 6999, true, 6)], clientFamilies: [6], event: '', numwant: 3 }, t + 11)
    expect(v6.peers).toHaveLength(0)
    expect(v6.peers6).toHaveLength(3)
  })

  it('returns nothing when numwant is zero', () => {
    const swarm = new SwarmTable(options)
    const t = 1_700_000_000_000
    swarm.announce({ peerId: PEER_ID, seeds: [seed('1.1.1.1', 6881, true)], clientFamilies: [4], event: '', numwant: 0 }, t)
    const reply = swarm.announce({ peerId: PEER_ID, seeds: [seed('2.2.2.2', 6882, false)], clientFamilies: [4], event: '', numwant: 0 }, t + 1)
    expect(reply.peers).toHaveLength(0)
    expect(reply.complete).toBe(1)
  })
})

describe('peer encoding helpers', () => {
  it('builds compact IPv4 and IPv6 frames', () => {
    const peers = [
      { family: 4 as const, ip: '10.0.0.1', port: 6881, peerId: PEER_ID, seeder: true, seenCompleted: false, lastSeen: 0 },
      { family: 6 as const, ip: '2408:8207:1924:eb70::1', port: 51413, peerId: PEER_ID, seeder: false, seenCompleted: false, lastSeen: 0 },
    ]
    expect([...toIPv4Compact(peers)]).toEqual([10, 0, 0, 1, 0x1a, 0xe1])
    expect([...toIPv6Compact(peers)]).toEqual([
      0x24, 0x08, 0x82, 0x07, 0x19, 0x24, 0xeb, 0x70, 0, 0, 0, 0, 0, 0, 0, 1, 0xc8, 0xd5,
    ])
  })

  it('samples a shuffled subset', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const picked = pickRandom(items, 4)
    expect(picked).toHaveLength(4)
    expect(new Set(picked).size).toBe(4)
    expect(pickRandom(items, 0)).toEqual([])
    expect(pickRandom(items, 50).sort((a, b) => a - b)).toEqual(items)
  })
})
