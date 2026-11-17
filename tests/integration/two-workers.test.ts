import { createApp } from '../../src/app';
import { getPrisma } from '../../src/common/db';
import { buildContainer } from '../../src/container';
import {
  createApplication,
  createEndpoint,
  disconnectDb,
  resetDb,
  sendMessage,
  startReceiver,
  type TestReceiver,
} from './helpers';

const container = buildContainer();
const app = createApp(container);
let receiver: TestReceiver;

beforeAll(async () => {
  receiver = await startReceiver();
});
beforeEach(resetDb);
afterAll(async () => {
  await receiver.close();
  await disconnectDb();
});

/** Runs a dispatcher until nothing is due, recording every delivery id it claimed. */
async function work(name: string, claimedBy: Map<string, string[]>) {
  const dispatcher = container.createDispatcher();
  for (;;) {
    const ids = await dispatcher.runOnce();
    if (ids.length === 0) return;
    for (const id of ids) claimedBy.set(id, [...(claimedBy.get(id) ?? []), name]);
  }
}

describe('two workers', () => {
  it('never claim the same delivery: 40 deliveries, 40 sends, one attempt each', async () => {
    const owner = await createApplication(app);
    const endpoint = await createEndpoint(app, owner, receiver.url);
    receiver.state.secrets = [endpoint.secret];
    receiver.state.received = [];
    for (let i = 0; i < 40; i++) await sendMessage(app, owner);

    const claimedBy = new Map<string, string[]>();
    await Promise.all([work('worker-1', claimedBy), work('worker-2', claimedBy)]);

    // Every delivery was claimed exactly once, and both workers took part.
    expect(claimedBy.size).toBe(40);
    expect([...claimedBy.values()].every((names) => names.length === 1)).toBe(true);
    const owners = new Set([...claimedBy.values()].map((names) => names[0]));
    expect(owners).toEqual(new Set(['worker-1', 'worker-2']));

    expect(receiver.state.received).toHaveLength(40);
    expect(new Set(receiver.state.received.map((r) => r.id)).size).toBe(40);
    expect(await getPrisma().deliveryAttempt.count()).toBe(40);
    expect(await getPrisma().delivery.count({ where: { status: 'SUCCEEDED' } })).toBe(40);
  });
});
