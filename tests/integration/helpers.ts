import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { getPrisma } from '../../src/common/db';
import type { Dispatcher } from '../../src/modules/delivery-attempts/dispatcher';
import { createReceiver, type ReceiverState } from '../../receiver/server';

export const adminAuth = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

export async function resetDb() {
  await getPrisma().$executeRawUnsafe(
    'TRUNCATE applications, endpoints, endpoint_secrets, messages, deliveries, delivery_attempts CASCADE',
  );
}

export async function disconnectDb() {
  await getPrisma().$disconnect();
}

export type TestReceiver = { url: string; state: ReceiverState; close: () => Promise<void> };

/** The real test receiver, in-process on a random port. */
export async function startReceiver(): Promise<TestReceiver> {
  const state: ReceiverState = { secrets: [], status: 200, received: [] };
  const server = createReceiver(state);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/hooks`,
    state,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

export type TestApp = { id: string; auth: { Authorization: string } };

export async function createApplication(app: Express, name = 'Acme'): Promise<TestApp> {
  const res = await request(app).post('/applications').set(adminAuth).send({ name }).expect(201);
  return {
    id: res.body.data.application.id,
    auth: { Authorization: `Bearer ${res.body.data.apiKey}` },
  };
}

export async function createEndpoint(
  app: Express,
  owner: TestApp,
  url: string,
  eventTypes = ['invoice.paid'],
): Promise<{ id: string; secret: string }> {
  const res = await request(app)
    .post('/endpoints')
    .set(owner.auth)
    .send({ url, eventTypes })
    .expect(201);
  return { id: res.body.data.id, secret: res.body.data.secret };
}

export async function sendMessage(app: Express, owner: TestApp, eventType = 'invoice.paid') {
  const res = await request(app)
    .post('/messages')
    .set(owner.auth)
    .send({ eventType, payload: { invoiceId: 'inv_1', amountCents: 4200 } })
    .expect(202);
  return res.body.data.message.id as string;
}

/** Runs the dispatcher until nothing is due. Retries are immediate in tests, so this finishes. */
export async function drain(dispatcher: Dispatcher, maxRounds = 50) {
  for (let round = 0; round < maxRounds; round++) {
    if ((await dispatcher.runOnce()).length === 0) return;
  }
  throw new Error('Dispatcher did not drain');
}

export function deliveriesOf(messageId: string) {
  return getPrisma().delivery.findMany({ where: { messageId }, include: { attempts: true } });
}
