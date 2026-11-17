import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { guardedLookup, isBlockedAddress } from '../../common/url-safety';

export const RESPONSE_BODY_LIMIT = 1024;

export type SendRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
};

/** Either an HTTP response (any status) or an error; never throws. */
export type SendResult = {
  statusCode?: number;
  responseBody?: string;
  error?: string;
  durationMs: number;
};

export interface WebhookSender {
  send(request: SendRequest): Promise<SendResult>;
}

/**
 * Sends with node:http(s). It does not follow redirects (a redirect could point inside the
 * network), stops reading the response after 1 KB, and enforces a total timeout. Unless private
 * endpoints are allowed, every connection goes through guardedLookup, which refuses private,
 * loopback and link-local addresses at connect time.
 */
export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly allowPrivate: boolean) {}

  send({ url, headers, body, timeoutMs }: SendRequest): Promise<SendResult> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: Omit<SendResult, 'durationMs'>) => {
        if (settled) return;
        settled = true;
        resolve({ ...result, durationMs: elapsed() });
      };

      const target = new URL(url);
      // IP literals skip DNS, so the lookup hook never sees them: check them here.
      const host = target.hostname.replace(/^\[|\]$/g, '');
      if (!this.allowPrivate && net.isIP(host) && isBlockedAddress(host)) {
        return finish({ error: `Blocked: ${host} is not a public address` });
      }

      const client = target.protocol === 'https:' ? https : http;
      const req = client.request(
        target,
        {
          method: 'POST',
          headers: {
            ...headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'user-agent': 'webhook-delivery-service/0.1',
          },
          lookup: this.allowPrivate ? undefined : guardedLookup,
          signal: AbortSignal.timeout(timeoutMs),
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            text += chunk;
            // Enough kept: stop downloading the rest.
            if (text.length >= RESPONSE_BODY_LIMIT) res.destroy();
          });
          res.on('close', () =>
            finish({
              statusCode: res.statusCode,
              responseBody: text.slice(0, RESPONSE_BODY_LIMIT),
            }),
          );
        },
      );
      req.on('error', (err) => {
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        finish({ error: timedOut ? `Timed out after ${timeoutMs} ms` : err.message });
      });
      req.end(body);
    });
  }
}
