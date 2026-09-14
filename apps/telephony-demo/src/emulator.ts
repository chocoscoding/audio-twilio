/**
 * Local Twilio emulator and demo web server.
 *
 * Plays Twilio's part so the unchanged gateway can be shown without a Twilio
 * account. The browser phone asks this server to deliver its webhooks; the
 * server adds Twilio's standard call parameters, signs each request with
 * X-Twilio-Signature exactly as Twilio does, and forwards it to the gateway.
 * The media stream is relayed the same way, with a signed handshake. The
 * auth token never reaches the browser.
 */

import { createHmac } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';

import WebSocket, { WebSocketServer } from 'ws';

export interface EmulatorOptions {
  port: number;
  /** The gateway's PUBLIC_BASE_URL; webhooks and streams must target it. */
  gatewayBaseUrl: string;
  accountSid: string;
  authToken: string;
  /** Demo phone numbers shown and sent as From / To. */
  callerNumber: string;
  twilioNumber: string;
  /** Served at GET /demo.json for the page. */
  pageData: object;
  pageHtml: string;
}

export interface Emulator {
  port: number;
  broadcast(event: object): void;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_QUEUED_MESSAGES = 500;

/**
 * Twilio's signing algorithm, from the sender's side. The gateway validates
 * with its own implementation, so a mismatch would show up as a 403.
 */
function sign(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + (params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

function reply(
  res: ServerResponse,
  status: number,
  type: string,
  body: string,
): void {
  res
    .writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
    .end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startEmulator(
  options: EmulatorOptions,
): Promise<Emulator> {
  const base = options.gatewayBaseUrl;
  const wsBase = base.replace(/^http/, 'ws');
  const listeners = new Set<ServerResponse>();

  const broadcast = (event: object) => {
    const frame = `data: ${JSON.stringify({ time: Date.now(), ...event })}\n\n`;
    for (const res of listeners) {
      res.write(frame);
    }
  };

  const deliverWebhook = async (req: IncomingMessage, res: ServerResponse) => {
    let body: { url?: unknown; callSid?: unknown; params?: unknown };
    try {
      body = JSON.parse(await readBody(req)) as typeof body;
    } catch {
      reply(res, 400, 'text/plain', 'Expected JSON { url, callSid, params }');
      return;
    }
    const target = typeof body.url === 'string' ? body.url : '';
    if (!target.startsWith(`${base}/voice/`)) {
      reply(res, 400, 'text/plain', 'Webhook URL must be on the gateway');
      return;
    }
    const extra =
      typeof body.params === 'object' && body.params !== null
        ? Object.fromEntries(
            Object.entries(body.params).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          )
        : {};
    // The parameters Twilio sends on every voice webhook.
    const params: Record<string, string> = {
      AccountSid: options.accountSid,
      ApiVersion: '2010-04-01',
      CallSid: typeof body.callSid === 'string' ? body.callSid : 'CAdemo',
      CallStatus: 'in-progress',
      Direction: 'inbound',
      From: options.callerNumber,
      To: options.twilioNumber,
      ...extra,
    };
    const response = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-twilio-signature': sign(options.authToken, target, params),
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    const twiml = await response.text();
    broadcast({
      kind: 'webhook',
      path: new URL(target).pathname,
      status: response.status,
    });
    reply(res, response.status, 'text/xml; charset=utf-8', twiml);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://demo.local');
    if (req.method === 'GET' && url.pathname === '/') {
      reply(res, 200, 'text/html; charset=utf-8', options.pageHtml);
    } else if (req.method === 'GET' && url.pathname === '/demo.json') {
      reply(res, 200, 'application/json', JSON.stringify(options.pageData));
    } else if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      listeners.add(res);
      req.on('close', () => listeners.delete(res));
    } else if (req.method === 'POST' && url.pathname === '/twilio/webhook') {
      deliverWebhook(req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          reply(
            res,
            502,
            'text/plain',
            `Could not reach the gateway: ${error instanceof Error ? error.message : 'unknown error'}`,
          );
        }
      });
    } else {
      reply(res, 404, 'text/plain', 'Not found');
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    const url = new URL(req.url ?? '/', 'http://demo.local');
    const target = url.searchParams.get('url') ?? '';
    if (url.pathname !== '/twilio/media' || !target.startsWith(`${wsBase}/`)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (browser) => {
      const gateway = new WebSocket(target, {
        headers: { 'x-twilio-signature': sign(options.authToken, target, {}) },
      });
      const queued: string[] = [];
      const closeBoth = () => {
        browser.close();
        gateway.close();
      };
      browser.on('message', (data) => {
        const text = data.toString();
        if (gateway.readyState === WebSocket.OPEN) {
          gateway.send(text);
        } else if (queued.length < MAX_QUEUED_MESSAGES) {
          queued.push(text);
        }
      });
      gateway.on('open', () => {
        broadcast({ kind: 'stream', state: 'connected' });
        for (const text of queued.splice(0)) {
          gateway.send(text);
        }
      });
      gateway.on('message', (data) => {
        if (browser.readyState === WebSocket.OPEN) {
          browser.send(data.toString());
        }
      });
      gateway.on('error', (error) => {
        broadcast({ kind: 'stream', state: 'refused', reason: error.message });
        closeBoth();
      });
      gateway.on('close', () => {
        broadcast({ kind: 'stream', state: 'closed' });
        closeBoth();
      });
      browser.on('error', () => undefined);
      browser.on('close', closeBoth);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); // e.g. EADDRINUSE
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port: (server.address() as AddressInfo).port,
    broadcast,
    close: async () => {
      for (const res of listeners) {
        res.end();
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
