import { signatureHeader, webhookHeaders } from '../../src/modules/delivery-attempts/signature';
import { verifyWebhook } from '../../receiver/verify-signature';

const body = JSON.stringify({ id: 'msg_1', type: 'invoice.paid', data: { amount: 42 } });
const now = Date.UTC(2026, 0, 1);

describe('signing (service) and verifying (customer example)', () => {
  it('produces a signature the customer code accepts', () => {
    const headers = webhookHeaders(['whsec_a'], 'msg_1', body, now);
    expect(headers['webhook-timestamp']).toBe(String(now / 1000));
    expect(verifyWebhook(['whsec_a'], headers, body, 300, now)).toBe(true);
  });

  it('signs "id.timestamp.body" with HMAC-SHA256, base64 encoded', () => {
    // Fixed vector: echo -n 'msg_1.1767225600.{}' | openssl dgst -sha256 -hmac whsec_a -binary | base64
    expect(signatureHeader(['whsec_a'], 'msg_1', 1767225600, '{}')).toBe(
      'v1,Ot51Vi84/rLTdPm29/LZP7EHnfhpOUuUBCz4wus77q8=',
    );
  });

  it('includes one signature per active secret, and either secret verifies', () => {
    const headers = webhookHeaders(['whsec_new', 'whsec_old'], 'msg_1', body, now);
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(verifyWebhook(['whsec_old'], headers, body, 300, now)).toBe(true);
    expect(verifyWebhook(['whsec_new'], headers, body, 300, now)).toBe(true);
    expect(verifyWebhook(['whsec_other'], headers, body, 300, now)).toBe(false);
  });

  it('rejects a changed body, id or timestamp', () => {
    const headers = webhookHeaders(['whsec_a'], 'msg_1', body, now);
    expect(verifyWebhook(['whsec_a'], headers, body.replace('42', '43'), 300, now)).toBe(false);
    expect(verifyWebhook(['whsec_a'], { ...headers, 'webhook-id': 'msg_2' }, body, 300, now)).toBe(
      false,
    );
    const shifted = { ...headers, 'webhook-timestamp': String(now / 1000 + 1) };
    expect(verifyWebhook(['whsec_a'], shifted, body, 300, now)).toBe(false);
  });

  it('rejects timestamps outside the tolerance, so old requests cannot be replayed', () => {
    const headers = webhookHeaders(['whsec_a'], 'msg_1', body, now);
    expect(verifyWebhook(['whsec_a'], headers, body, 300, now + 299_000)).toBe(true);
    expect(verifyWebhook(['whsec_a'], headers, body, 300, now + 301_000)).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(verifyWebhook(['whsec_a'], {}, body)).toBe(false);
  });
});
