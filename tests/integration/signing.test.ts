import request from 'supertest';
import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
import { buildContainer } from '../../src/container';
import {
  createApplication,
  createEndpoint,
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

/** Sends one message to the endpoint and reports whether the receiver could verify it. */
async function verifiesWith(secrets: string[]) {
  receiver.state.secrets = secrets;
  receiver.state.received = [];
  await sendMessage(app, owner);
  await drain(container.createDispatcher());
  return receiver.state.received[0]!.verified;
}

describe('signing and secret rotation', () => {
  it('rejects a request signed with a different secret', async () => {
    await createEndpoint(app, owner, receiver.url);
    expect(await verifiesWith(['whsec_not-the-right-one'])).toBe(false);
  });

  it('signs with both secrets during the grace period, then only with the new one', async () => {
    const endpoint = await createEndpoint(app, owner, receiver.url);
    const oldSecret = endpoint.secret;

    const rotated = await request(app)
      .post(`/endpoints/${endpoint.id}/rotate-secret`)
      .set(owner.auth)
      .expect(200);
    const newSecret = rotated.body.data.secret as string;
    expect(newSecret).not.toBe(oldSecret);
    const current = await request(app).get(`/endpoints/${endpoint.id}/secret`).set(owner.auth);
    expect(current.body.data.secret).toBe(newSecret);

    // Grace period: a receiver that only knows either secret can verify.
    expect(await verifiesWith([oldSecret])).toBe(true);
    expect(await verifiesWith([newSecret])).toBe(true);

    // Grace period over: the old secret no longer signs.
    await getPrisma().endpointSecret.updateMany({
      where: { expiresAt: { not: null } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await verifiesWith([oldSecret])).toBe(false);
    expect(await verifiesWith([newSecret])).toBe(true);
  });
});
