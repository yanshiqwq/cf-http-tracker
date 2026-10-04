/**
 * IP helpers. Implemented from scratch so the tracker runs without
 * nodejs_compat and never has to guess when building compact wire data.
 */

export type IpFamily = 4 | 6

export function detectFamily(ip: string): IpFamily | null {
  if (isIPv4(ip)) return 4
  if (isIPv6(ip)) return 6
  return null
}

export function isIPv4(ip: string): boolean {
  if (!ip || ip.length < 7 || ip.length > 15) return false
  let groups = 0
  let value = 0
  let digits = 0
  for (let i = 0; i <= ip.length; i++) {
    const code = i < ip.length ? ip.charCodeAt(i) : 46
    if (code >= 48 && code <= 57) {
      value = value * 10 + (code - 48)
      digits++
      if (digits > 3) return false
      continue
    }
    if (code !== 46) return false
    if (digits === 0 || value > 255) return false
    groups++
    value = 0
    digits = 0
  }
  return groups === 4
}

export function ipv4ToBytes(ip: string): Uint8Array | null {
  if (!isIPv4(ip)) return null
  const out = new Uint8Array(4)
  let index = 0
  let value = 0
  for (let i = 0; i <= ip.length; i++) {
    const code = i < ip.length ? ip.charCodeAt(i) : 46
    if (code >= 48 && code <= 57) {
      value = value * 10 + (code - 48)
      continue
    }
    out[index++] = value
    value = 0
  }
  return out
}

export function isIPv6(ip: string): boolean {
  return ipv6ToBytes(ip) !== null
}

/**
 * Accepts every form a peer address can legally take: full form, `::`
 * compression, embedded IPv4 (`::ffff:1.2.3.4`), and a zone id (`%eth0`) which
 * is stripped because it has no meaning on the wire.
 */
export function ipv6ToBytes(input: string): Uint8Array | null {
  if (!input) return null
  let text = input.trim()
  if (text.length < 2 || text.length > 45) return null

  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null

  const compressed = text.indexOf('::')
  let leftRaw: string
  let rightRaw: string
  if (compressed >= 0) {
    if (text.indexOf('::', compressed + 1) >= 0) return null
    leftRaw = text.slice(0, compressed)
    rightRaw = text.slice(compressed + 2)
  } else {
    leftRaw = text
    rightRaw = ''
  }
  if (leftRaw !== '' && (leftRaw.startsWith(':') || leftRaw.endsWith(':'))) return null
  if (rightRaw !== '' && (rightRaw.startsWith(':') || rightRaw.endsWith(':'))) return null

  // The two sides of `::` must be kept apart: the zero block is *between* them.
  const leftGroups = leftRaw === '' ? [] : leftRaw.split(':').filter((group) => group !== '')
  const rightGroups = rightRaw === '' ? [] : rightRaw.split(':').filter((group) => group !== '')

  // An embedded IPv4 literal is only legal as the final group.
  let embeddedIPv4: Uint8Array | null = null
  const lastRight = rightGroups[rightGroups.length - 1]
  const lastLeft = leftGroups[leftGroups.length - 1]
  if (lastRight !== undefined && lastRight.includes('.')) {
    embeddedIPv4 = ipv4ToBytes(rightGroups.pop() as string)
    if (!embeddedIPv4) return null
  } else if (rightGroups.length === 0 && lastLeft !== undefined && lastLeft.includes('.')) {
    embeddedIPv4 = ipv4ToBytes(leftGroups.pop() as string)
    if (!embeddedIPv4) return null
  }

  for (const group of [...leftGroups, ...rightGroups]) {
    if (group.length < 1 || group.length > 4 || !/^[0-9a-fA-F]+$/.test(group)) return null
  }

  const groupCount = leftGroups.length + rightGroups.length + (embeddedIPv4 ? 2 : 0)
  const out = new Uint8Array(16)

  if (compressed >= 0) {
    const zeroGroups = 8 - groupCount
    if (zeroGroups < 1) return null
    let offset = 0
    for (const group of leftGroups) writeGroup(out, offset, group), (offset += 2)
    offset += zeroGroups * 2
    for (const group of rightGroups) writeGroup(out, offset, group), (offset += 2)
    if (embeddedIPv4) out.set(embeddedIPv4, offset)
    return out
  }

  if (groupCount !== 8) return null
  let offset = 0
  for (const group of leftGroups) writeGroup(out, offset, group), (offset += 2)
  if (embeddedIPv4) out.set(embeddedIPv4, offset)
  return out
}

function writeGroup(out: Uint8Array, offset: number, group: string): void {
  const value = Number.parseInt(group, 16)
  out[offset] = value >> 8
  out[offset + 1] = value & 0xff
}

export function ipToBytes(ip: string): Uint8Array | null {
  const family = detectFamily(ip)
  if (family === 4) return ipv4ToBytes(ip)
  if (family === 6) return ipv6ToBytes(ip)
  return null
}
