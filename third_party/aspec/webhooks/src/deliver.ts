import * as http from 'node:http';
import * as https from 'node:https';
import { WebhooksError } from './errors.js';
import { type LookupFn, type ResolvedTarget, resolveSafeUrl, type SsrfOptions } from './ssrf.js';

export interface DeliverHttpOptions {
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  lookup?: LookupFn | undefined;
  ssrf?: SsrfOptions | undefined;
  allowHosts?: readonly string[] | undefined;
  requireHttps?: boolean | undefined;
}

export interface DeliverHttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  durationMs: number;
}

/**
 * POSTs JSON to a resolved, SSRF-checked target. Pins the IP for the TCP connection while
 * preserving Host and SNI. Refuses redirects. Truncates the response body.
 */
export async function postWebhook(
  targetUrl: string,
  body: string,
  headers: Record<string, string>,
  options: DeliverHttpOptions = {},
): Promise<DeliverHttpResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxResponseBytes = options.maxResponseBytes ?? 64_000;
  const ssrf: SsrfOptions = {
    requireHttps: options.requireHttps ?? options.ssrf?.requireHttps ?? true,
    allowHosts: options.allowHosts ?? options.ssrf?.allowHosts,
    allowNonDefaultPorts: options.ssrf?.allowNonDefaultPorts,
    lookup: options.lookup ?? options.ssrf?.lookup,
  };
  const target = await resolveSafeUrl(targetUrl, ssrf);
  return postPinned(target, body, headers, timeoutMs, maxResponseBytes);
}

async function postPinned(
  target: ResolvedTarget,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<DeliverHttpResult> {
  const started = Date.now();
  const isHttps = target.protocol === 'https:';
  const lib = isHttps ? https : http;
  const bodyBuf = Buffer.from(body, 'utf8');

  const requestHeaders: Record<string, string | number> = {
    ...headers,
    Host: target.url.host,
    'Content-Type': 'application/json',
    'Content-Length': bodyBuf.byteLength,
    Connection: 'close',
  };

  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.address,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'POST',
        headers: requestHeaders,
        servername: isHttps ? target.hostname : undefined,
        setHost: false,
        agent: false,
        timeout: timeoutMs,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          reject(
            new WebhooksError('WEBHOOKS_DELIVERY_FAILED', 'Redirects are not followed', {
              status: 502,
              expose: false,
              details: { status: res.statusCode },
            }),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxResponseBytes) chunks.push(chunk);
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const truncated =
            size > maxResponseBytes ? `${raw.toString('utf8')}…[truncated]` : raw.toString('utf8');
          const responseHeaders: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') responseHeaders[k] = v;
            else if (Array.isArray(v)) responseHeaders[k] = v.join(', ');
          }
          resolve({
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            body: truncated.slice(0, maxResponseBytes),
            durationMs: Date.now() - started,
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new WebhooksError('WEBHOOKS_DELIVERY_FAILED', 'Delivery timed out', { status: 504 }));
    });
    req.on('error', (err) => {
      reject(
        new WebhooksError('WEBHOOKS_DELIVERY_FAILED', err.message, {
          status: 502,
          cause: err,
        }),
      );
    });
    req.write(bodyBuf);
    req.end();
  });
}
