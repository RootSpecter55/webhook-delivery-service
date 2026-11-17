import dns from 'node:dns';
import net from 'node:net';
import { AppError } from './errors';

/**
 * SSRF protection. A webhook URL is chosen by a customer, so without this check the worker
 * could be made to POST to internal services, the cloud metadata endpoint (169.254.169.254)
 * or localhost.
 */
const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes broadcast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::ffff:0:0', 96], // IPv4-mapped: could hide any IPv4 address, so all are refused
  ['64:ff9b::', 96], // NAT64: same reason
  ['fc00::', 7], // unique local (private)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, 'ipv6');
}

/** True for any address a webhook must never be sent to. Anything that is not an IP is refused. */
export function isBlockedAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Resolve = (hostname: string) => Promise<string[]>;

const resolveAll: Resolve = async (hostname) =>
  (await dns.promises.lookup(hostname, { all: true })).map((a) => a.address);

function invalidUrl(message: string, details?: unknown) {
  return new AppError(422, 'INVALID_ENDPOINT_URL', message, details);
}

/**
 * Checked when an endpoint is created or its URL changes. Every address the hostname resolves
 * to must be public. The worker checks again at connect time (see guardedLookup), because DNS
 * can change after this check.
 */
export async function assertSafeUrl(
  url: string,
  { allowPrivate, resolve = resolveAll }: { allowPrivate: boolean; resolve?: Resolve },
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalidUrl('Not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidUrl('URL must use http or https');
  }
  if (parsed.username || parsed.password) throw invalidUrl('URL must not contain credentials');
  if (allowPrivate) return;

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // IPv6 literals come in brackets
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await resolve(host);
  } catch {
    throw invalidUrl(`Hostname ${host} does not resolve`);
  }
  const bad = addresses.filter(isBlockedAddress);
  if (addresses.length === 0 || bad.length > 0) {
    throw invalidUrl('URL resolves to a private, loopback or link-local address', {
      addresses: bad,
    });
  }
}

/**
 * A DNS lookup for http.request() that refuses blocked addresses. Because it runs for the
 * connection actually being made, a hostname that was public at creation time and now points
 * inside the network (DNS rebinding) is still refused.
 */
export const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const bad = addresses.find((a) => isBlockedAddress(a.address));
    if (bad || addresses.length === 0) {
      const error = new Error(`Blocked: ${hostname} resolves to ${bad?.address ?? 'nothing'}`);
      return callback(error as NodeJS.ErrnoException, '', 0);
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
};
