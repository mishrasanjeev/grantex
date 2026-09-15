import { BlockList, isIP } from 'node:net';

/**
 * Address ranges an outbound fetch of a client metadata document must never
 * reach: loopback, private, link-local, carrier-grade NAT, unique-local,
 * multicast, documentation, benchmarking and other special-purpose ranges
 * (IANA IPv4 and IPv6 Special-Purpose Address Registries), plus IPv6 forms
 * that embed an IPv4 address and so could tunnel to one of the above.
 */
const IPV4_DENIED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_DENIED: Array<[string, number]> = [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96], // IPv4-mapped
  ['::', 96], // IPv4-compatible (deprecated)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments, including Teredo
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // segment routing
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

// Only global unicast IPv6 (2000::/3) is ever routable on the public internet.
const ipv6GlobalUnicast = new BlockList();
ipv6GlobalUnicast.addSubnet('2000::', 3, 'ipv6');

// Separate lists: a BlockList holding the IPv4-mapped IPv6 range matches
// every IPv4 address, so the two families must not share one.
const deniedV4 = new BlockList();
for (const [network, prefix] of IPV4_DENIED) deniedV4.addSubnet(network, prefix, 'ipv4');
const deniedV6 = new BlockList();
for (const [network, prefix] of IPV6_DENIED) deniedV6.addSubnet(network, prefix, 'ipv6');

/**
 * True only for a syntactically valid IP address outside every denied range.
 * Anything that is not an IP address is refused.
 */
export function isPublicAddress(address: string): boolean {
  const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return !deniedV4.check(bare, 'ipv4');
  if (family === 6) {
    if (bare.includes('%')) return false; // zone ids only appear on link-local addresses
    return ipv6GlobalUnicast.check(bare, 'ipv6') && !deniedV6.check(bare, 'ipv6');
  }
  return false;
}
