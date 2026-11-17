import { createHmac } from 'node:crypto';

/**
 * Signs one request. The signed content is "id.timestamp.body": the timestamp stops replays of
 * old requests, and the id ties the signature to this message.
 *
 * One `v1,<base64>` entry per active secret, separated by spaces. During a secret rotation the
 * old and new secrets both sign, so receivers can switch at their own pace.
 */
export function signatureHeader(
  secrets: string[],
  id: string,
  timestamp: number,
  body: string,
): string {
  const signedContent = `${id}.${timestamp}.${body}`;
  return secrets
    .map((secret) => `v1,${createHmac('sha256', secret).update(signedContent).digest('base64')}`)
    .join(' ');
}

/** The headers sent with every webhook (the same names as the Standard Webhooks spec). */
export function webhookHeaders(secrets: string[], id: string, body: string, now = Date.now()) {
  const timestamp = Math.floor(now / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signatureHeader(secrets, id, timestamp, body),
  };
}
