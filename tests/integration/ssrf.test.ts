import request from 'supertest';
import { createApp } from '../../src/app';
import { buildContainer } from '../../src/container';
import {
  createApplication,
  createEndpoint,
  deliveriesOf,
  disconnectDb,
  drain,
  resetDb,
  sendMessage,
  startReceiver,
  type TestApp,
  type TestReceiver,
} from './helpers';

/** Production settings: private addresses refused. DNS is faked so no network is needed. */
const fakeDns: Record<string, string[]> = {
  'hooks.example.com': ['93.184.215.14'],
  'internal.example.com': ['10.0.0.12'],
  'sneaky.example.com': ['93.184.215.14', '127.0.0.1'],
};
const strict = buildContainer({
  config: { ALLOW_PRIVATE_ENDPOINTS: false },
  resolve: async (host) => {
    const addresses = fakeDns[host];
    if (!addresses) throw new Error('ENOTFOUND');
    return addresses;
  },
});
const strictApp = createApp(strict);
let owner: TestApp;
let receiver: TestReceiver;

beforeAll(async () => {
  receiver = await startReceiver();
});
beforeEach(async () => {
  await resetDb();
  owner = await createApplication(strictApp);
});
afterAll(async () => {
  await receiver.close();
  await disconnectDb();
});

function createWithUrl(url: string) {
  return request(strictApp)
    .post('/endpoints')
    .set(owner.auth)
    .send({ url, eventTypes: ['x.y'] });
}

describe('SSRF protection', () => {
  it.each([
    'http://127.0.0.1/hook',
    'http://localhost:8080/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://internal.example.com/hook',
    'http://sneaky.example.com/hook',
  ])('rejects %s', async (url) => {
    // localhost resolves through the fake DNS too: it is not listed, so it fails to resolve.
    const res = await createWithUrl(url);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ENDPOINT_URL');
  });

  it('accepts a public hostname', async () => {
    await createWithUrl('https://hooks.example.com/webhooks').expect(201);
  });

  it('refuses to connect to a private address at send time (DNS rebinding)', async () => {
    // The endpoint was created while private URLs were allowed, then the worker runs strictly.
    const lax = buildContainer();
    const laxApp = createApp(lax);
    const laxOwner = await createApplication(laxApp, 'Lax');
    await createEndpoint(laxApp, laxOwner, receiver.url.replace('127.0.0.1', 'localhost'));
    await createEndpoint(laxApp, laxOwner, receiver.url);
    receiver.state.received = [];
    const messageId = await sendMessage(laxApp, laxOwner);

    await drain(
      buildContainer({
        config: { ALLOW_PRIVATE_ENDPOINTS: false, RETRY_SCHEDULE_SECONDS: [] },
      }).createDispatcher(),
    );

    expect(receiver.state.received).toHaveLength(0);
    const errors = (await deliveriesOf(messageId)).map((d) => d.attempts[0]!.error);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Blocked: localhost resolves to (127\.0\.0\.1|::1)$/),
        'Blocked: 127.0.0.1 is not a public address',
      ]),
    );
  });
});
