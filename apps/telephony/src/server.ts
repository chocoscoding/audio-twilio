/**
 * HTTP + WebSocket front door:
 *   GET  /healthz   liveness; 503 while draining
 *   POST /voice/*   Twilio webhooks → TwiML (signature-checked)
 *   WS   /media     Twilio bidirectional Media Streams (signature-checked)
 *
 * The only per-instance state is a count of active calls, used to refuse new
 * AI streams at MAX_CALLS. A refused stream is not an outage: Twilio continues
 * at <Connect action> and the caller reaches a human interpreter.
 */

import {
  STATUS_CODES,
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { WebSocketServer } from 'ws';

import { runCall } from './call.js';
import type { TelephonyConfig } from './config.js';
import type { FourPointsTarget } from './fourpoints.js';
import { handleVoiceWebhook } from './ivr.js';
import type { LanguageMenu } from './languages.js';
import { log } from './log.js';
import { isValidTwilioSignature } from './twilio-signature.js';

const MAX_WEBHOOK_BODY_BYTES = 16 * 1024;
const MAX_TWILIO_MESSAGE_BYTES = 64 * 1024;

export interface TelephonyServerOptions {
  config: TelephonyConfig;
  target: FourPointsTarget;
  menu: () => LanguageMenu;
}

export interface TelephonyServer {
  readonly port: number;
  readonly activeCalls: number;
  /** Refuse new calls, let active calls finish (up to drainMs), then close. */
  close(drainMs?: number): Promise<void>;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
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

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.removeAllListeners('data');
        req.resume(); // discard the rest; answer 413
        resolve(null);
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function createTelephonyServer(
  options: TelephonyServerOptions,
): Promise<TelephonyServer> {
  const { config } = options;
  let activeCalls = 0;
  let draining = false;
  const aiAvailable = () => !draining && activeCalls < config.maxCalls;

  const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      reply(
        res,
        draining ? 503 : 200,
        'application/json',
        JSON.stringify({
          status: draining ? 'draining' : 'ok',
          activeCalls,
          version: process.env['APP_VERSION'] ?? 'dev',
        }),
      );
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/voice/')) {
      reply(res, 404, 'text/plain', 'Not found');
      return;
    }
    const raw = await readBody(req, MAX_WEBHOOK_BODY_BYTES);
    if (raw === null) {
      reply(res, 413, 'text/plain', 'Payload too large');
      return;
    }
    const body = new URLSearchParams(raw);
    if (
      config.validateSignatures &&
      !isValidTwilioSignature(
        config.twilioAuthToken,
        header(req, 'x-twilio-signature'),
        `${config.publicBaseUrl}${req.url ?? ''}`,
        body,
      )
    ) {
      log('webhook.rejected', { path: url.pathname });
      reply(res, 403, 'text/plain', 'Forbidden');
      return;
    }
    const twiml = handleVoiceWebhook(url.pathname, url.searchParams, body, {
      config,
      menu: options.menu(),
      aiAvailable: aiAvailable(),
    });
    if (twiml === null) {
      reply(res, 404, 'text/plain', 'Not found');
      return;
    }
    reply(res, 200, 'text/xml', twiml);
  };

  const server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) {
        reply(res, 500, 'text/plain', 'Internal error');
      }
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_TWILIO_MESSAGE_BYTES,
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => undefined);
    const refuse = (status: number, reason: string) => {
      log('media.refused', { reason });
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\n\r\n`,
      );
    };
    const url = new URL(req.url ?? '/', 'http://gateway.invalid');
    if (url.pathname !== '/media') {
      refuse(404, 'unknown_path');
      return;
    }
    if (config.validateSignatures) {
      // Twilio signs the <Stream url> with no parameters; its docs advise
      // also accepting the trailing-slash form.
      const signed = `${config.publicBaseUrl.replace(/^http/, 'ws')}${req.url ?? ''}`;
      const signature = header(req, 'x-twilio-signature');
      if (
        ![signed, `${signed}/`].some((candidate) =>
          isValidTwilioSignature(config.twilioAuthToken, signature, candidate),
        )
      ) {
        refuse(403, 'bad_signature');
        return;
      }
    }
    if (!aiAvailable()) {
      refuse(503, draining ? 'draining' : 'at_capacity');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      activeCalls += 1;
      runCall(ws, {
        config,
        target: options.target,
        menu: options.menu,
        onEnd: () => {
          activeCalls -= 1;
        },
      });
    });
  });

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null
      ? address.port
      : config.port;

  return {
    port,
    get activeCalls() {
      return activeCalls;
    },
    close: async (drainMs = 25_000) => {
      draining = true;
      const deadline = Date.now() + drainMs;
      while (activeCalls > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      for (const client of wss.clients) {
        client.close(1001);
      }
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
