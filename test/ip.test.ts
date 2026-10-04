import { describe, expect, it } from 'vitest'
import { detectFamily, ipv4ToBytes, ipv6ToBytes, isIPv4, isIPv6 } from '../src/ip'

describe('ip parsing', () => {
  it('validates IPv4', () => {
    expect(isIPv4('192.168.1.1')).toBe(true)
    expect(isIPv4('0.0.0.0')).toBe(true)
    expect(isIPv4('255.255.255.255')).toBe(true)
    expect(isIPv4('256.1.1.1')).toBe(false)
    expect(isIPv4('1.2.3')).toBe(false)
    expect(isIPv4('1.2.3.4.5')).toBe(false)
    expect(isIPv4('1..2.3')).toBe(false)
    expect(isIPv4('01.2.3.4')).toBe(true)
    expect(isIPv4('')).toBe(false)
  })

  it('converts IPv4 to bytes', () => {
    expect([...(ipv4ToBytes('10.0.0.1') ?? [])]).toEqual([10, 0, 0, 1])
    expect(ipv4ToBytes('10.0.0.256')).toBeNull()
  })

  it('parses IPv6 in every legal form', () => {
    expect([...(ipv6ToBytes('2001:db8::1') ?? [])]).toEqual([
      0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ])
    // loopback, fully written out
    expect([...(ipv6ToBytes('0:0:0:0:0:0:0:1') ?? [])]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    // compressed all-zero address
    expect([...(ipv6ToBytes('::') ?? [])]).toEqual(new Array(16).fill(0))
    // embedded IPv4
    expect([...(ipv6ToBytes('::ffff:192.168.0.1') ?? [])]).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 192, 168, 0, 1,
    ])
    // zone id is stripped
    expect(isIPv6('fe80::1%eth0')).toBe(true)
  })

  it('rejects malformed IPv6', () => {
    expect(ipv6ToBytes('')).toBeNull()
    expect(ipv6ToBytes('gggg::1')).toBeNull()
    expect(ipv6ToBytes('1:2:3:4:5:6:7')).toBeNull()
    expect(ipv6ToBytes('1:2:3:4:5:6:7:8:9')).toBeNull()
    expect(ipv6ToBytes('1:2:3:4:5:6:7:8::')).toBeNull()
    expect(ipv6ToBytes('1::2::3')).toBeNull()
    expect(ipv6ToBytes('12345::1')).toBeNull()
    expect(ipv6ToBytes('1.2.3.4')).toBeNull()
  })

  it('detects family', () => {
    expect(detectFamily('1.2.3.4')).toBe(4)
    expect(detectFamily('2408:8207:1924:eb70::1')).toBe(6)
    expect(detectFamily('nonsense')).toBeNull()
  })
})
