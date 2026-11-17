import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
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

const container = buildContainer();
const app = createApp(container);
let receiver: TestReceiver;
let owner: TestApp;

beforeAll(async () => {
  receiver = await startReceiver();
});
beforeEach(async () => {
  await resetDb();
  receiver.state.received = [];
  receiver.state.status = 200;
  owner = await createApplication(app);
});
afterAll(async () => {
  await receiver.close();
  await disconnectDb();
});

async function endpointToReceiver() {
  const endpoint = await createEndpoint(app, owner, receiver.url);
  receiver.state.secrets = [endpoint.secret];
  return endpoint;
}

describe('delivery', () => {
  it('delivers a signed webhook that the customer verification code accepts', async () => {
    await endpointToReceiver();
    const messageId = await sendMessage(app, owner);

    await drain(container.createDispatcher());

    expect(receiver.state.received).toMatchObject([
      { id: messageId, type: 'invoice.paid', verified: true, answered: 200 },
    ]);
    const [delivery] = await deliveriesOf(messageId);
    expect(delivery).toMatchObject({ status: 'SUCCEEDED', attemptCount: 1 });
    expect(delivery!.attempts[0]).toMatchObject({ statusCode: 200, succeeded: true, error: null });
    expect(delivery!.attempts[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('retries a failure and stops at the first 2xx', async () => {
    await endpointToReceiver();
    const messageId = await sendMessage(app, owner);
    const dispatcher = container.createDispatcher();

    receiver.state.status = 500;
    await dispatcher.runOnce();
    receiver.state.status = 200;
    await drain(dispatcher);

    const [delivery] = await deliveriesOf(messageId);
    expect(delivery).toMatchObject({ status: 'SUCCEEDED', attemptCount: 2 });
    expect(delivery!.attempts.map((a) => a.statusCode).sort()).toEqual([200, 500]);
    // A success resets the endpoint's failure count.
    expect((await getPrisma().endpoint.findFirstOrThrow()).consecutiveFailures).toBe(0);
  });

  it('gives up after the last scheduled retry', async () => {
    await endpointToReceiver();
    receiver.state.status = 503;
    const messageId = await sendMessage(app, owner);

    await drain(container.createDispatcher());

    // RETRY_SCHEDULE_SECONDS=0,0 in tests: one attempt plus two retries.
    const [delivery] = await deliveriesOf(messageId);
    expect(delivery).toMatchObject({ status: 'FAILED', attemptCount: 3 });
    expect(delivery!.completedAt).not.toBeNull();
  });

  it('disables the endpoint when it answers 410 Gone', async () => {
    const endpoint = await endpointToReceiver();
    receiver.state.status = 410;
    const first = await sendMessage(app, owner);
    await drain(container.createDispatcher());

    const [delivery] = await deliveriesOf(first);
    expect(delivery).toMatchObject({ status: 'FAILED', attemptCount: 1 });
    const res = await request(app).get(`/endpoints/${endpoint.id}`).set(owner.auth).expect(200);
    expect(res.body.data).toMatchObject({ status: 'DISABLED', disabledReason: 'GONE' });

    // A disabled endpoint gets no new deliveries.
    const second = await sendMessage(app, owner);
    expect(await deliveriesOf(second)).toHaveLength(0);
  });

  it('opens the circuit after repeated failures, and resumes when re-enabled', async () => {
    // Threshold 3, with enough retries left that the delivery is still pending when it opens.
    const breaker = buildContainer({
      config: { CIRCUIT_BREAKER_THRESHOLD: 3, RETRY_SCHEDULE_SECONDS: [0, 0, 0, 0] },
    });
    const endpoint = await endpointToReceiver();
    receiver.state.status = 503;
    const messageId = await sendMessage(app, owner);

    await drain(breaker.createDispatcher());

    const disabled = await request(app).get(`/endpoints/${endpoint.id}`).set(owner.auth);
    expect(disabled.body.data).toMatchObject({
      status: 'DISABLED',
      disabledReason: 'FAILING',
      consecutiveFailures: 3,
    });
    const [waiting] = await deliveriesOf(messageId);
    expect(waiting).toMatchObject({ status: 'PENDING', attemptCount: 3 });

    receiver.state.status = 200;
    const enabled = await request(app)
      .post(`/endpoints/${endpoint.id}/enable`)
      .set(owner.auth)
      .expect(200);
    expect(enabled.body.data).toMatchObject({ status: 'ENABLED', consecutiveFailures: 0 });

    await drain(breaker.createDispatcher());
    const [resumed] = await deliveriesOf(messageId);
    expect(resumed).toMatchObject({ status: 'SUCCEEDED', attemptCount: 4 });
  });

  it('stores timeouts and truncates long response bodies to 1 KB', async () => {
    const quick = buildContainer({
      config: { DELIVERY_TIMEOUT_MS: 200, RETRY_SCHEDULE_SECONDS: [] },
    });
    let mode: 'slow' | 'verbose' = 'verbose';
    const odd: Server = createServer((_req, res) => {
      if (mode === 'slow') return; // never answers
      res.writeHead(500).end('x'.repeat(5000));
    });
    await new Promise<void>((resolve) => odd.listen(0, '127.0.0.1', resolve));
    const { port } = odd.address() as AddressInfo;
    await createEndpoint(app, owner, `http://127.0.0.1:${port}/`);

    const verbose = await sendMessage(app, owner);
    await drain(quick.createDispatcher());
    mode = 'slow';
    const slow = await sendMessage(app, owner);
    await drain(quick.createDispatcher());
    odd.closeAllConnections();
    await new Promise((resolve) => odd.close(resolve));

    const [verboseDelivery] = await deliveriesOf(verbose);
    expect(verboseDelivery!.attempts[0]!.statusCode).toBe(500);
    expect(verboseDelivery!.attempts[0]!.responseBody).toHaveLength(1024);
    const [slowDelivery] = await deliveriesOf(slow);
    expect(slowDelivery!.attempts[0]).toMatchObject({
      statusCode: null,
      error: 'Timed out after 200 ms',
      succeeded: false,
    });
  });

  it('lists deliveries and their attempts for the owning application only', async () => {
    await endpointToReceiver();
    const messageId = await sendMessage(app, owner);
    await drain(container.createDispatcher());

    const list = await request(app)
      .get(`/deliveries?messageId=${messageId}`)
      .set(owner.auth)
      .expect(200);
    expect(list.body.meta.total).toBe(1);
    const deliveryId = list.body.data[0].id;
    const attempts = await request(app)
      .get(`/deliveries/${deliveryId}/attempts`)
      .set(owner.auth)
      .expect(200);
    expect(attempts.body.data).toMatchObject([{ attemptNumber: 1, statusCode: 200 }]);

    const other = await createApplication(app, 'Other');
    await request(app).get(`/deliveries/${deliveryId}`).set(other.auth).expect(404);
    const otherList = await request(app).get('/deliveries').set(other.auth).expect(200);
    expect(otherList.body.meta.total).toBe(0);
  });
});
