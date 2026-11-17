import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
import { buildContainer } from '../../src/container';
import {
  adminAuth,
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

describe('applications and auth', () => {
  it('stores only a hash of the API key and rejects bad keys', async () => {
    const row = await getPrisma().application.findFirstOrThrow();
    expect(row.apiKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(owner.auth.Authorization).not.toContain(row.apiKeyHash);

    await request(app).get('/endpoints').expect(401);
    await request(app).get('/endpoints').set({ Authorization: 'Bearer whk_wrong' }).expect(401);
    await request(app).post('/applications').send({ name: 'x' }).expect(401);
    const list = await request(app).get('/applications').set(adminAuth).expect(200);
    expect(list.body.data[0]).not.toHaveProperty('apiKeyHash');
  });
});

describe('fan-out', () => {
  it('creates one delivery per enabled endpoint subscribed to the event type', async () => {
    const a = await createEndpoint(app, owner, receiver.url, ['invoice.paid', 'invoice.voided']);
    const b = await createEndpoint(app, owner, receiver.url, ['invoice.paid']);
    await createEndpoint(app, owner, receiver.url, ['customer.created']);
    const disabled = await createEndpoint(app, owner, receiver.url, ['invoice.paid']);
    await request(app).post(`/endpoints/${disabled.id}/disable`).set(owner.auth).expect(200);

    const res = await request(app)
      .post('/messages')
      .set(owner.auth)
      .send({ eventType: 'invoice.paid', payload: { id: 1 } })
      .expect(202);
    expect(res.body.data.deliveryCount).toBe(2);
    const deliveries = await deliveriesOf(res.body.data.message.id);
    expect(deliveries.map((d) => d.endpointId).sort()).toEqual([a.id, b.id].sort());
  });

  it('returns the original message for a repeated idempotency key', async () => {
    await createEndpoint(app, owner, receiver.url);
    const body = { eventType: 'invoice.paid', payload: { id: 1 }, idempotencyKey: 'order-42' };
    const first = await request(app).post('/messages').set(owner.auth).send(body).expect(202);
    const again = await request(app).post('/messages').set(owner.auth).send(body).expect(200);
    expect(again.body.data).toMatchObject({
      duplicate: true,
      message: { id: first.body.data.message.id },
    });
    expect(await getPrisma().delivery.count()).toBe(1);
  });

  it('keeps applications apart', async () => {
    const endpoint = await createEndpoint(app, owner, receiver.url);
    const other = await createApplication(app, 'Other');
    await request(app).get(`/endpoints/${endpoint.id}`).set(other.auth).expect(404);
    await request(app).get(`/endpoints/${endpoint.id}/secret`).set(other.auth).expect(404);
    const res = await request(app)
      .post('/messages')
      .set(other.auth)
      .send({ eventType: 'invoice.paid', payload: {} })
      .expect(202);
    expect(res.body.data.deliveryCount).toBe(0);
  });
});

describe('replay', () => {
  it('replays one message as a new delivery', async () => {
    const endpoint = await createEndpoint(app, owner, receiver.url);
    receiver.state.secrets = [endpoint.secret];
    const messageId = await sendMessage(app, owner);
    await drain(container.createDispatcher());

    const res = await request(app)
      .post(`/messages/${messageId}/replay`)
      .set(owner.auth)
      .send({ endpointId: endpoint.id })
      .expect(202);
    expect(res.body.data.deliveryCount).toBe(1);
    await drain(container.createDispatcher());
    expect(receiver.state.received.filter((r) => r.id === messageId)).toHaveLength(2);
  });

  it('replays every failed message for an endpoint since a given time', async () => {
    const endpoint = await createEndpoint(app, owner, receiver.url);
    receiver.state.secrets = [endpoint.secret];
    receiver.state.status = 503;
    const before = new Date();
    const failed = [await sendMessage(app, owner), await sendMessage(app, owner)];
    await drain(container.createDispatcher());
    expect(await getPrisma().delivery.count({ where: { status: 'FAILED' } })).toBe(2);

    // Six failed attempts tripped the circuit breaker (threshold 5): replay needs it enabled.
    const blocked = await request(app)
      .post(`/endpoints/${endpoint.id}/replay-failed`)
      .set(owner.auth)
      .send({ since: before.toISOString() });
    expect(blocked.status).toBe(409);
    receiver.state.status = 200;
    await request(app).post(`/endpoints/${endpoint.id}/enable`).set(owner.auth).expect(200);
    const res = await request(app)
      .post(`/endpoints/${endpoint.id}/replay-failed`)
      .set(owner.auth)
      .send({ since: before.toISOString() })
      .expect(202);
    expect(res.body.data.replayed).toBe(2);
    await drain(container.createDispatcher());

    for (const messageId of failed) {
      const statuses = (await deliveriesOf(messageId)).map((d) => d.status).sort();
      expect(statuses).toEqual(['FAILED', 'SUCCEEDED']);
    }
    const later = await request(app)
      .post(`/endpoints/${endpoint.id}/replay-failed`)
      .set(owner.auth)
      .send({ since: new Date(Date.now() + 60_000).toISOString() })
      .expect(202);
    expect(later.body.data.replayed).toBe(0);
  });
});

describe('endpoints CRUD', () => {
  it('updates, paginates and deletes endpoints, validating input', async () => {
    const endpoint = await createEndpoint(app, owner, receiver.url);
    await createEndpoint(app, owner, receiver.url);

    const updated = await request(app)
      .patch(`/endpoints/${endpoint.id}`)
      .set(owner.auth)
      .send({ eventTypes: ['a.b', 'a.b', 'c.d'] })
      .expect(200);
    expect(updated.body.data.eventTypes).toEqual(['a.b', 'c.d']);

    const page = await request(app).get('/endpoints?pageSize=1').set(owner.auth).expect(200);
    expect(page.body.meta).toEqual({ page: 1, pageSize: 1, total: 2, totalPages: 2 });

    const invalid = await request(app)
      .post('/endpoints')
      .set(owner.auth)
      .send({ url: 'ftp://example.com', eventTypes: [] });
    expect(invalid.status).toBe(400);

    await request(app).delete(`/endpoints/${endpoint.id}`).set(owner.auth).expect(204);
    await request(app).get(`/endpoints/${endpoint.id}`).set(owner.auth).expect(404);
  });
});
