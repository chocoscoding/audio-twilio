/**
 * Presentation logs: two plain-English, colored log files meant to be
 * followed live in two terminals (`tail -F`):
 *
 *   twilio.log  — webhooks Twilio sends the gateway, and the TwiML answers
 *   stream.log  — the WebSocket media stream: audio in, audio out, marks
 *
 * Does nothing until openPresentationLogs() is called, so tests and normal
 * mode are unaffected. Caller numbers are masked to their last four digits.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

export type Direction = 'in' | 'out' | 'note';

const color = {
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

const ARROWS: Record<Direction, string> = {
  in: `${color.cyan}TWILIO  ──► GATEWAY${color.reset}`,
  out: `${color.green}GATEWAY ──► TWILIO ${color.reset}`,
  note: `${color.yellow}        •          ${color.reset}`,
};

let twilioFile: WriteStream | undefined;
let streamFile: WriteStream | undefined;

export function openPresentationLogs(dir: string, publicBaseUrl: string): void {
  mkdirSync(dir, { recursive: true });
  twilioFile = createWriteStream(join(dir, 'twilio.log'), { flags: 'w' });
  streamFile = createWriteStream(join(dir, 'stream.log'), { flags: 'w' });
  const wss = `${publicBaseUrl.replace(/^http/, 'ws')}/media`;
  banner(twilioFile, 'TERMINAL 1 · TWILIO CALL LOG', [
    'Twilio calls this gateway over HTTPS for every step of the phone call:',
    `  ${publicBaseUrl}/voice/…`,
    'Each request is checked against your Auth Token, and the gateway answers',
    'with TwiML: instructions for Twilio (say this, wait for a key, open a stream).',
  ]);
  banner(streamFile, 'TERMINAL 2 · AUDIO STREAM LOG', [
    'When the caller picks a language, Twilio opens a WebSocket to:',
    `  ${wss}`,
    'Caller audio arrives as JSON "media" messages: 20 ms of phone audio each',
    '(μ-law, 8000 Hz, mono, base64). The gateway sends audio back the same way,',
    'then a "mark"; Twilio returns the mark once the caller has heard it.',
  ]);
}

function banner(file: WriteStream, title: string, lines: string[]): void {
  const rule = '═'.repeat(76);
  file.write(
    `${color.bold}${rule}\n  ${title}\n${rule}${color.reset}\n` +
      `${color.dim}${lines.join('\n')}${color.reset}\n\n`,
  );
}

function write(
  file: WriteStream | undefined,
  direction: Direction,
  title: string,
  details: string[],
): void {
  if (file === undefined) {
    return;
  }
  const time = new Date().toTimeString().slice(0, 8);
  const ms = String(new Date().getMilliseconds()).padStart(3, '0');
  const body = details
    .map((line) => `\n${' '.repeat(34)}${color.dim}${line}${color.reset}`)
    .join('');
  file.write(
    `${color.dim}${time}.${ms}${color.reset}  ${ARROWS[direction]}  ${title}${body}\n`,
  );
}

export function twilioLog(
  direction: Direction,
  title: string,
  ...details: string[]
): void {
  write(twilioFile, direction, title, details);
}

export function streamLog(
  direction: Direction,
  title: string,
  ...details: string[]
): void {
  write(streamFile, direction, title, details);
}

export const highlight = (text: string) => `${color.bold}${text}${color.reset}`;
export const problem = (text: string) => `${color.red}${text}${color.reset}`;

export function maskPhone(number: string | null): string {
  if (number === null || number === '') {
    return 'unknown number';
  }
  return number.length > 4 ? `•••${number.slice(-4)}` : number;
}

export function shortSid(sid: string | null | undefined): string {
  return sid ? `${sid.slice(0, 6)}…${sid.slice(-4)}` : '?';
}

/** What an incoming Twilio webhook means, in one line. */
export function describeWebhook(path: string, body: URLSearchParams): string {
  const digits = body.get('Digits');
  const pressed =
    digits === null || digits === ''
      ? 'no key pressed (timed out)'
      : `caller pressed ${highlight(digits)}`;
  switch (path) {
    case '/voice/incoming':
      return `${highlight('New call')} from ${maskPhone(body.get('From'))} to ${body.get('To') ?? '?'}`;
    case '/voice/mode':
      return `Main menu answer: ${pressed}`;
    case '/voice/select':
      return `Language menu answer: ${pressed}`;
    case '/voice/stream-status':
      return `Stream status: ${highlight(body.get('StreamEvent') ?? '?')}${body.get('StreamError') ? ` ${problem(body.get('StreamError') ?? '')}` : ''}`;
    case '/voice/ai-ended':
      return 'Stream finished — Twilio asks what to do next';
    case '/voice/human-result':
      return `Interpreter call result: ${highlight(body.get('DialCallStatus') ?? '?')}${body.get('DialCallDuration') ? ` after ${body.get('DialCallDuration')} s` : ''}`;
    case '/voice/status':
      return `Call status: ${highlight(body.get('CallStatus') ?? '?')}${body.get('CallDuration') ? ` after ${body.get('CallDuration')} s` : ''}`;
    default:
      return path;
  }
}

const unescape = (text: string) =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The TwiML verbs of a response, one plain-English line each. */
export function describeTwiml(xml: string): string[] {
  const steps: string[] = [];
  const tag = /<(\w+)([^>]*?)(\/?)>(?:([^<]*)<\/\1>)?/g;
  const attr = (attrs: string, name: string) =>
    unescape(new RegExp(`${name}="([^"]*)"`).exec(attrs)?.[1] ?? '');
  for (const match of xml.matchAll(tag)) {
    const [, name, attrs = '', , text = ''] = match;
    switch (name) {
      case 'Say':
        steps.push(`say     "${unescape(text)}"`);
        break;
      case 'Gather':
        steps.push(
          `gather  wait for ${attr(attrs, 'numDigits')} key(s), then call ${attr(attrs, 'action').replace(/^https?:\/\/[^/]+/, '')}`,
        );
        break;
      case 'Pause':
        steps.push(`pause   ${attr(attrs, 'length')} s`);
        break;
      case 'Connect':
        steps.push('connect hand the call audio to a media stream:');
        break;
      case 'Stream':
        steps.push(`stream  open WebSocket ${highlight(attr(attrs, 'url'))}`);
        break;
      case 'Parameter':
        steps.push(
          `        with ${attr(attrs, 'name')} = ${attr(attrs, 'value')}`,
        );
        break;
      case 'Dial':
        steps.push(
          `dial    ring the interpreter for up to ${attr(attrs, 'timeout')} s, then call ${attr(attrs, 'action').replace(/^https?:\/\/[^/]+/, '')}`,
        );
        break;
      case 'Number':
        steps.push(`        number ${highlight(maskPhone(unescape(text)))}`);
        break;
      case 'Hangup':
        steps.push('hangup  end the call');
        break;
      default:
        break;
    }
  }
  return steps.length > 0 ? steps : ['OK (nothing for Twilio to do)'];
}
