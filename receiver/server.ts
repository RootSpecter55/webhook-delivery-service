/**
 * Test receiver for local development (a separate service in docker-compose).
 *
 *   POST /control  {"secrets": ["whsec_..."], "status": 503}   set secrets / force a status code
 *   GET  /received                                             the last 100 webhooks it got
 *   POST anything else                                         a webhook: verified, then answered
 *
 * Unsigned or badly signed requests get 401. Correctly signed ones get the configured status
 * (200 by default), so it can be told to fail (500, 503) or to say the endpoint is gone (410).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { verifyWebhook } from './verify-signature';

export type Received = {
  id: string;
  type?: string;
  verified: boolean;
  answered: number;
  at: string;
};

export type ReceiverState = { secrets: string[]; status: number; received: Received[] };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function createReceiver(state: ReceiverState): Server {
  return createServer(async (req, res) => {
    const body = await readBody(req);
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.url === '/health') return reply(200, { data: { status: 'ok' } });
    if (req.method === 'GET' && req.url === '/received')
      return reply(200, { data: state.received });
    if (req.method === 'POST' && req.url === '/control') {
      const update = JSON.parse(body || '{}') as Partial<ReceiverState>;
      if (Array.isArray(update.secrets)) state.secrets = update.secrets;
      if (typeof update.status === 'number') state.status = update.status;
      return reply(200, { data: { secrets: state.secrets.length, status: state.status } });
    }
    if (req.method !== 'POST')
      return reply(404, { error: { code: 'NOT_FOUND', message: 'Not found' } });

    const verified = verifyWebhook(state.secrets, req.headers, body);
    const answered = verified ? state.status : 401;
    let type: string | undefined;
    try {
      type = (JSON.parse(body) as { type?: string }).type;
    } catch {
      type = undefined;
    }
    state.received.unshift({
      id: String(req.headers['webhook-id'] ?? ''),
      type,
      verified,
      answered,
      at: new Date().toISOString(),
    });
    state.received.length = Math.min(state.received.length, 100);
    reply(answered, { received: verified });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 4000);
  const secrets = (process.env.RECEIVER_SECRETS ?? '').split(',').filter(Boolean);
  createReceiver({ secrets, status: 200, received: [] }).listen(port, () => {
    console.log(`Test receiver listening on port ${port}`);
  });
}
