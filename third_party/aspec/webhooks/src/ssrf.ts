import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { invalidConfig, WebhooksError } from './errors.js';

export type LookupFn = (
  hostname: string,
  options: { all: true; family?: 0 | 4 | 6 },
) => Promise<Array<{ address: string; family: number }>>;

export interface SsrfOptions {
  /** When true (default in production-like configs), only https URLs are allowed. */
  requireHttps?: boolean | undefined;
  /** Extra hostnames or IPs allowed even when private (dev/test only). */
  allowHosts?: readonly string[] | undefined;
  /** Allow non-default ports (not 443/80). Default false. */
  allowNonDefaultPorts?: boolean | undefined;
  /** Injectable DNS resolver for tests (including rebinding simulations). */
  lookup?: LookupFn | undefined;
}

// Special-purpose ranges (RFC 6890 and successors) a webhook must never reach.
const BLOCKED = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // this network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001::', 32], // Teredo
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
] as const) {
  BLOCKED.addSubnet(net, prefix, 'ipv6');
}

/** Expands an IPv6 address (including a dotted IPv4 tail) to eight 16-bit groups. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const octets = dotted[1].split('.').map(Number);
    const hex = `${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
    text = text.slice(0, -dotted[1].length) + hex;
  }
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...Array<string>(Math.max(fill, 0)).fill('0'), ...tail].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : undefined;
}

function v4From(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * IPv4 addresses carried inside IPv6: mapped (::ffff:0:0/96), compatible (::/96),
 * NAT64 (64:ff9b::/96), and 6to4 (2002::/16). Each is checked against the IPv4 list,
 * so "[::ffff:127.0.0.1]" or "[64:ff9b::a9fe:a9fe]" cannot reach loopback or metadata.
 */
function embeddedV4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g) return undefined;
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 5) && g[5] === 0xffff) return v4From(g[6] ?? 0, g[7] ?? 0);
  if (zeros(0, 6) && ((g[6] ?? 0) !== 0 || (g[7] ?? 0) > 1)) return v4From(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return v4From(g[6] ?? 0, g[7] ?? 0);
  if (g[0] === 0x2002) return v4From(g[1] ?? 0, g[2] ?? 0);
  return undefined;
}

export function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED.check(address, 'ipv4');
  if (family !== 6) return true;
  const v4 = embeddedV4(address);
  if (v4 !== undefined) return BLOCKED.check(v4, 'ipv4');
  return BLOCKED.check(address, 'ipv6');
}

export interface ResolvedTarget {
  url: URL;
  address: string;
  family: number;
  /** Hostname preserved for SNI / Host header. */
  hostname: string;
  port: number;
  protocol: 'http:' | 'https:';
}

/** Validates a subscription URL and resolves a non-blocked address, pinning against DNS rebinding. */
export async function resolveSafeUrl(
  raw: string,
  options: SsrfOptions = {},
): Promise<ResolvedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhooksError('WEBHOOKS_INVALID_INPUT', 'Invalid webhook URL', {
      status: 400,
      expose: true,
    });
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'Only http and https URLs are allowed', {
      status: 400,
      expose: true,
    });
  }
  const requireHttps = options.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:') {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'HTTPS is required for webhook URLs', {
      status: 400,
      expose: true,
    });
  }
  if (url.username || url.password) {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'URLs with credentials are not allowed', {
      status: 400,
      expose: true,
    });
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  if (!options.allowNonDefaultPorts && port !== defaultPort) {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'Non-default ports are not allowed', {
      status: 400,
      expose: true,
    });
  }
  // WHATWG URLs keep IPv6 literals in brackets ("[::1]"); compare and resolve the bare address.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  const allow = new Set(
    (options.allowHosts ?? []).map((h) => h.replace(/^\[(.*)\]$/, '$1').toLowerCase()),
  );
  const hostAllowed = allow.has(host);
  const lookup = options.lookup ?? ((hostname, opts) => dnsLookup(hostname, opts));

  if (isIP(host)) {
    if (!hostAllowed && isBlockedIp(host)) {
      throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'Destination address is not allowed', {
        status: 400,
        expose: true,
      });
    }
    return {
      url,
      address: host,
      family: isIP(host),
      hostname: url.hostname,
      port,
      protocol: url.protocol as 'http:' | 'https:',
    };
  }

  const records = await lookup(host, { all: true });
  if (!records.length) {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'DNS lookup returned no addresses', {
      status: 400,
      expose: true,
    });
  }
  const safe = records.find((r) => hostAllowed || !isBlockedIp(r.address));
  if (!safe) {
    throw new WebhooksError('WEBHOOKS_SSRF_BLOCKED', 'Destination address is not allowed', {
      status: 400,
      expose: true,
    });
  }
  return {
    url,
    address: safe.address,
    family: safe.family,
    hostname: url.hostname,
    port,
    protocol: url.protocol as 'http:' | 'https:',
  };
}

export function assertUrlAllowedForCreate(raw: string, options: SsrfOptions): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidConfig('url', 'must be a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalidConfig('url', 'must be http or https');
  }
  const requireHttps = options.requireHttps !== false;
  if (requireHttps && url.protocol !== 'https:') {
    throw invalidConfig('url', 'must be https when requireHttps is enabled');
  }
}
