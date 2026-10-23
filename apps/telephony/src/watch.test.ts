import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';

import { encodeMulaw } from './audio.js';
import type { ReleaseResult, TwilioRest } from './twilio-rest.js';
import { runWatch } from './watch.js';

const ACCOUNT_SID = `AC${'1'.repeat(32)}`;
const CALL_SID = `CA${'a'.repeat(32)}`;
const TWIML = '<Response><Hangup/></Response>';

/** Just enough of a ws WebSocket for runWatch. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closedWith: number | undefined;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number): void {
    if (this.readyState !== this.OPEN) {
      return;
    }
    this.readyState = 3;
    this.closedWith = code;
    this.emit('close');
  }

  /** A text frame from Twilio. */
  receive(message: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(message)), false);
  }
}

const ROWS: Record<string, [number, number]> = {
  '#': [941, 1477],
  '*': [941, 1209],
  '1': [697, 1209],
};

/** μ-law audio of one keypress (or silence), split into 20 ms frames. */
function frames(key: string | null, ms: number): string[] {
  const length = (8000 * ms) / 1000;
  const [low, high] = key === null ? [0, 0] : (ROWS[key] ?? [0, 0]);
  const pcm = Int16Array.from({ length }, (_, i) =>
    key === null
      ? 0
      : Math.round(
          8000 *
            (Math.sin((2 * Math.PI * low * i) / 8000) +
              Math.sin((2 * Math.PI * high * i) / 8000)),
        ),
  );
  const mulaw = encodeMulaw(pcm);
  const out: string[] = [];
  for (let i = 0; i < mulaw.length; i += 160) {
    out.push(Buffer.from(mulaw.subarray(i, i + 160)).toString('base64'));
  }
  return out;
}

function fakeRest(result: ReleaseResult | Promise<ReleaseResult> = 'released') {
  const releaseHumanLeg = vi.fn(async (_sid: string, _twiml: string) => result);
  return { rest: { releaseHumanLeg } satisfies TwilioRest, releaseHumanLeg };
}

function setup(result?: ReleaseResult | Promise<ReleaseResult>) {
  const socket = new FakeSocket();
  const { rest, releaseHumanLeg } = fakeRest(result);
  const onEnd = vi.fn();
  runWatch(socket as unknown as WebSocket, {
    accountSid: ACCOUNT_SID,
    rest,
    releaseTwiml: TWIML,
    onEnd,
  });
  const start = (overrides: Record<string, unknown> = {}) =>
    socket.receive({
      event: 'start',
      start: {
        accountSid: ACCOUNT_SID,
        callSid: CALL_SID,
        streamSid: `MZ${'b'.repeat(32)}`,
        tracks: ['inbound'],
        ...overrides,
      },
    });
  const audio = (payloads: string[]) => {
    for (const payload of payloads) {
      socket.receive({ event: 'media', media: { track: 'inbound', payload } });
    }
  };
  const press = (key: string) => {
    audio(frames(key, 80));
    audio(frames(null, 100));
  };
  return { socket, releaseHumanLeg, onEnd, start, audio, press };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('runWatch', () => {
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logged = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const events = () =>
    logged.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as Record<string, unknown>,
    );

  it('releases the human leg on ### heard in the audio, then closes', async () => {
    const { socket, releaseHumanLeg, onEnd, start, press } = setup('released');
    start();
    press('#');
    press('#');
    expect(releaseHumanLeg).not.toHaveBeenCalled();
    press('#');
    expect(releaseHumanLeg).toHaveBeenCalledTimes(1);
    expect(releaseHumanLeg).toHaveBeenCalledWith(CALL_SID, TWIML);
    await flush();
    expect(socket.closedWith).toBe(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    const names = events().map((e) => e['event']);
    expect(names).toEqual(
      expect.arrayContaining([
        'watch.started',
        'watch.switch_requested',
        'watch.switch_result',
        'watch.ended',
      ]),
    );
    expect(
      events().find((e) => e['event'] === 'watch.switch_result')?.['result'],
    ).toBe('released');
  });

  it('requests the switch only once', async () => {
    const { socket, releaseHumanLeg, start, press } = setup('none');
    start();
    for (let i = 0; i < 9; i++) {
      press('#');
    }
    await flush();
    expect(releaseHumanLeg).toHaveBeenCalledTimes(1);
    expect(socket.closedWith).toBeUndefined(); // not released: keep listening quietly
  });

  it('does not switch when other keys break the sequence', () => {
    const { releaseHumanLeg, start, press } = setup();
    start();
    for (const key of ['#', '#', '*', '#', '#', '1', '#']) {
      press(key);
    }
    expect(releaseHumanLeg).not.toHaveBeenCalled();
  });

  it('a long # press counts once', () => {
    const { releaseHumanLeg, start, audio } = setup();
    start();
    audio(frames('#', 3_000));
    audio(frames(null, 100));
    expect(releaseHumanLeg).not.toHaveBeenCalled();
  });

  it('switches on Twilio dtmf events too, without double counting tones', () => {
    const { socket, releaseHumanLeg, start, press } = setup();
    start();
    const dtmf = (digit: string) =>
      socket.receive({
        event: 'dtmf',
        dtmf: { track: 'inbound_track', digit },
      });
    // First press arrives both as a tone and as an event.
    press('#');
    dtmf('#');
    // From now on only events count.
    press('#');
    press('#');
    expect(releaseHumanLeg).not.toHaveBeenCalled();
    dtmf('#');
    expect(releaseHumanLeg).not.toHaveBeenCalled();
    dtmf('#');
    expect(releaseHumanLeg).toHaveBeenCalledTimes(1);
  });

  it('ignores media before start and on the outbound track', () => {
    const { socket, releaseHumanLeg, start, press } = setup();
    press('#');
    press('#');
    start();
    const outbound = frames('#', 80);
    for (let i = 0; i < 3; i++) {
      for (const payload of [...outbound, ...frames(null, 100)]) {
        socket.receive({
          event: 'media',
          media: { track: 'outbound', payload },
        });
      }
    }
    press('#');
    expect(releaseHumanLeg).not.toHaveBeenCalled();
  });

  it('closes a stream from another Twilio account', () => {
    const { socket, releaseHumanLeg, onEnd, start, press } = setup();
    start({ accountSid: `AC${'2'.repeat(32)}` });
    expect(socket.closedWith).toBe(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
    press('#');
    press('#');
    press('#');
    expect(releaseHumanLeg).not.toHaveBeenCalled();
    expect(
      events().find((e) => e['event'] === 'watch.closed_by_gateway')?.[
        'reason'
      ],
    ).toBe('wrong_account');
  });

  it('closes a stream with an invalid call SID', () => {
    const { socket, onEnd, start } = setup();
    start({ callSid: 'CA../../x' });
    expect(socket.closedWith).toBe(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('closes when start never arrives', () => {
    vi.useFakeTimers();
    const { socket, onEnd } = setup();
    vi.advanceTimersByTime(4_999);
    expect(socket.closedWith).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(socket.closedWith).toBe(1000);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ignores binary, malformed and oversized messages', () => {
    const { socket, releaseHumanLeg, start, press } = setup();
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ event: 'stop' })),
      true,
    );
    socket.emit('message', Buffer.from('{not json'), false);
    socket.emit('message', Buffer.from('null'), false);
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ event: 'stop', pad: 'x'.repeat(20_000) })),
      false,
    );
    start();
    socket.receive({ event: 'media', media: { payload: 'A'.repeat(9_000) } });
    socket.receive({ event: 'media', media: { payload: 42 } });
    socket.receive({ event: 'dtmf', dtmf: { digit: '###' } });
    press('#');
    press('#');
    press('#');
    expect(releaseHumanLeg).toHaveBeenCalledTimes(1);
  });

  it('ends once on stop, then close', () => {
    const { socket, onEnd, start } = setup();
    start();
    socket.receive({ event: 'stop', stop: {} });
    socket.emit('close');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('ends once on close', () => {
    const { socket, onEnd, start } = setup();
    start();
    socket.emit('close');
    socket.emit('close');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('logs no audio, digits or raw call SID', async () => {
    const { start, press } = setup('error');
    start();
    press('#');
    press('#');
    press('#');
    await flush();
    const output = logged.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).not.toContain(CALL_SID);
    expect(output).not.toContain('#');
    expect(output).not.toContain('payload');
    expect(
      events().find((e) => e['event'] === 'watch.switch_result')?.['result'],
    ).toBe('error');
  });
});
