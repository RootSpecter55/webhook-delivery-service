/**
 * How a customer verifies a webhook from this service. Copy this function: it needs only
 * node:crypto. (Any language works the same way: HMAC-SHA256 over "id.timestamp.body".)
 *
 *   const ok = verifyWebhook([process.env.WEBHOOK_SECRET], req.headers, rawBody);
 *   if (!ok) return res.status(401).end();
 *
 * Use the raw request body exactly as received. Re-serialising parsed JSON changes the bytes.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function verifyWebhook(
  secrets: string[],
  headers: WebhookHeaders,
  rawBody: string,
  toleranceSeconds = 300,
  nowMs = Date.now(),
): boolean {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signature = headers['webhook-signature'];
  if (typeof id !== 'string' || typeof timestamp !== 'string' || typeof signature !== 'string') {
    return false;
  }

  // Reject old (or future) timestamps, so a captured request cannot be replayed later.
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(nowMs / 1000 - sentAt) > toleranceSeconds) {
    return false;
  }

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  // The header holds one "v1,<base64>" entry per active secret, separated by spaces.
  const given = signature
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => Buffer.from(entry.slice('v1,'.length), 'base64'));

  return secrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signedContent).digest();
    return given.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
  });
}
