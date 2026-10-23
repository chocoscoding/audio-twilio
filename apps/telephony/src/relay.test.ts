import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { dtmfTone } from './audio.js';
import { StaticCompanySource } from './companies.js';
import { loadConfig } from './config.js';
import { PromptLibrary } from './prompts.js';
import { RelayHub, runRelayCaller, runRelayLeg } from './relay.js';
import type { CallInfo, NewCall, TwilioRest } from './twilio-rest.js';

/**
 * The human-call relay: the gateway rings the interpreter line, passes audio
 * both ways, hears ###, and leaves the reason for /voice/relay-ended.
 */

const ACCOUNT_SID = `AC${'0'.repeat(32)}`;
const CALLER = `CA${'a'.repeat(32)}`;
const LEG = `CA${'b'.repeat(32)}`;
const CHICAGO = '+18723047712';
const OPI = '+14342483776';
const RELEASE = '<Response><Say>bye</Say><Hangup/></Response>';

const config = loadConfig({
  PUBLIC_BASE_URL: 'https://phone.example.com',
  TWILIO_ACCOUNT_SID: ACCOUNT_SID,
  TWILIO_AUTH_TOKEN: 'token',
  HUMAN_INTERPRETER_NUMBER: '+15550000001',
});
const companies = StaticCompanySource.from([
  {
    orgNumber: 17,
    organizationId: '40c9f321-ffb2-4be7-aca6-36669c4fce70',
    companyName: 'VerbatUm',
    lines: [{ twilioNumber: CHICAGO }],
    humanNumber: OPI,
  },
]);
const prompts = PromptLibrary.of([
  {
    id: 'hold-music',
    text: 'Hold music',
    mulaw: new Uint8Array(1600).fill(0x22),
  },
]);

/** Just enough of a ws WebSocket for the relay. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(): void {
    if (this.readyState !== this.OPEN) {
      return;
    }
    this.readyState = 3;
    this.emit('close');
  }

  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }

  payloads(): string[] {
    return this.sent
      .filter((m) => m['event'] === 'media')
      .map((m) => (m['media'] as { payload: string }).payload);
  }
}

const settle = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeRest(legStatus = 'ringing') {
  const created: NewCall[] = [];
  const rest = {
    getCall: vi.fn(async (sid: string): Promise<CallInfo | undefined> =>
      sid === CALLER
        ? { to: CHICAGO, status: 'in-progress' }
        : { to: OPI, status: legStatus },
    ),
    createCall: vi.fn(async (call: NewCall) => {
      created.push(call);
      return LEG;
    }),
    updateCall: vi.fn(async () => true),
    endCall: vi.fn(async () => true),
  } satisfies TwilioRest;
  return { rest, created };
}

function startCaller(
  params: Record<string, string>,
  rest: TwilioRest,
  hub = new RelayHub(),
  timing = { ringTimeoutMs: 2_000, pollMs: 1_000 },
) {
  const caller = new FakeSocket();
  const onEnd = vi.fn();
  runRelayCaller(caller as unknown as WebSocket, {
    config,
    rest,
    hub,
    companies,
    prompts,
    releaseTwiml: RELEASE,
    onEnd,
    timing,
  });
  caller.receive({
    event: 'start',
    start: {
      accountSid: ACCOUNT_SID,
      callSid: CALLER,
      streamSid: 'MZcaller',
      customParameters: params,
    },
  });
  return { caller, hub, onEnd };
}

function answer(hub: RelayHub) {
  const leg = new FakeSocket();
  runRelayLeg(leg as unknown as WebSocket, { accountSid: ACCOUNT_SID, hub });
  leg.receive({
    event: 'start',
    start: {
      accountSid: ACCOUNT_SID,
      callSid: LEG,
      streamSid: 'MZleg',
      customParameters: { parent: CALLER },
    },
  });
  return leg;
}

const media = (payload: string) => ({
  event: 'media',
  media: { track: 'inbound', payload },
});
const press = (socket: FakeSocket, digit: string) =>
  socket.receive({ event: 'dtmf', dtmf: { track: 'inbound_track', digit } });

describe('human-call relay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rings the company's own line from the number the caller dialed, with music while it rings", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest, created } = fakeRest();
    const { caller } = startCaller({ switch: '1', lang: 'es-US' }, rest);
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ to: OPI, from: CHICAGO });
    expect(created[0]?.twiml).toContain(
      '<Stream url="wss://phone.example.com/relay-leg">',
    );
    expect(created[0]?.twiml).toContain(
      `<Parameter name="parent" value="${CALLER}"/>`,
    );
    expect(Buffer.from(caller.payloads()[0] ?? '', 'base64')[0]).toBe(0x22);
  });

  it('passes audio both ways once the line answers, and stops the music', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const { caller, hub } = startCaller({ switch: '1' }, rest);
    await settle();
    const leg = answer(hub);
    expect(caller.sent.at(-1)).toEqual({
      event: 'clear',
      streamSid: 'MZcaller',
    });
    caller.receive(media('Y2FsbGVy'));
    leg.receive(media('bGVn'));
    expect(leg.sent).toContainEqual({
      event: 'media',
      streamSid: 'MZleg',
      media: { payload: 'Y2FsbGVy' },
    });
    expect(caller.sent.at(-1)).toEqual({
      event: 'media',
      streamSid: 'MZcaller',
      media: { payload: 'bGVn' },
    });
  });

  it('### moves the caller to the AI: the interpreter hears a notice, the reason is kept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const { caller, hub, onEnd } = startCaller({ switch: '1' }, rest);
    await settle();
    const leg = answer(hub);
    press(caller, '#');
    press(caller, '#');
    press(caller, '#');
    expect(rest.updateCall).toHaveBeenCalledWith(LEG, RELEASE);
    expect(caller.readyState).toBe(3);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(hub.take(CALLER)).toBe('switch_to_ai');
    expect(hub.take(CALLER)).toBeUndefined(); // read once
    // The first two # reached the interpreter line as tones.
    expect(leg.payloads()).toEqual([
      Buffer.from(dtmfTone('#')).toString('base64'),
      Buffer.from(dtmfTone('#')).toString('base64'),
    ]);
  });

  it('other keys reach the interpreter line as tones; ### is passed on when switching is not allowed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const { caller, hub } = startCaller({}, rest);
    await settle();
    const leg = answer(hub);
    for (const digit of ['1', '#', '#', '#']) {
      press(caller, digit);
    }
    expect(leg.payloads()).toHaveLength(4);
    expect(rest.updateCall).not.toHaveBeenCalled();
    expect(caller.readyState).toBe(1);
  });

  it('the interpreter hanging up ends the relay as interpreter_ended', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const { caller, hub } = startCaller({ switch: '1' }, rest);
    await settle();
    const leg = answer(hub);
    leg.receive({ event: 'stop' });
    expect(caller.readyState).toBe(3);
    expect(hub.take(CALLER)).toBe('interpreter_ended');
  });

  it('a busy or unanswered line ends the relay as no_answer', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest('busy');
    const { caller, hub } = startCaller({ switch: '1' }, rest, new RelayHub(), {
      ringTimeoutMs: 2_000,
      pollMs: 10,
    });
    await settle(60);
    expect(caller.readyState).toBe(3);
    expect(hub.take(CALLER)).toBe('no_answer');
  });

  it('gives up ringing after the ring time and hangs up the attempt', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest('ringing');
    const { caller, hub } = startCaller({}, rest, new RelayHub(), {
      ringTimeoutMs: 40,
      pollMs: 1_000,
    });
    await settle(80);
    expect(rest.endCall).toHaveBeenCalledWith(LEG);
    expect(caller.readyState).toBe(3);
    expect(hub.take(CALLER)).toBe('no_answer');
  });

  it('the caller hanging up hangs up the interpreter line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const { caller, hub } = startCaller({ switch: '1' }, rest);
    await settle();
    answer(hub);
    caller.receive({ event: 'stop' });
    expect(rest.endCall).toHaveBeenCalledWith(LEG);
    expect(hub.take(CALLER)).toBeUndefined();
  });

  it('refuses a stream from another account, and a leg no caller waits for', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { rest } = fakeRest();
    const caller = new FakeSocket();
    runRelayCaller(caller as unknown as WebSocket, {
      config,
      rest,
      hub: new RelayHub(),
      releaseTwiml: RELEASE,
      onEnd: () => undefined,
    });
    caller.receive({
      event: 'start',
      start: {
        accountSid: `AC${'9'.repeat(32)}`,
        callSid: CALLER,
        streamSid: 'MZ',
      },
    });
    expect(caller.readyState).toBe(3);
    expect(rest.createCall).not.toHaveBeenCalled();
    const stray = answer(new RelayHub());
    expect(stray.readyState).toBe(3);
  });

  it('logs no numbers or audio', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
    const { rest } = fakeRest();
    const { caller, hub } = startCaller({ switch: '1' }, rest);
    await settle();
    const leg = answer(hub);
    caller.receive(media('Y2FsbGVy'));
    leg.receive({ event: 'stop' });
    const all = lines.join('\n');
    expect(all).toContain('relay.connected');
    for (const secret of [OPI, CHICAGO, 'Y2FsbGVy', CALLER]) {
      expect(all).not.toContain(secret);
    }
  });
});
