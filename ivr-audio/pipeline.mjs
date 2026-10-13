#!/usr/bin/env node
/**
 * Two-stage IVR audio pipeline.
 *
 *   Stage 1 — generate: ElevenLabs → review/ (lossless 44.1 kHz source, the
 *             phone-ready μ-law file, and a browser preview of that μ-law
 *             file). Open review/index.html and listen.
 *   Stage 2 — approve: the μ-law file you listened to moves to final/ and is
 *             recorded in final/manifest.json; everything else for that clip
 *             is deleted from review/.
 *
 *   node pipeline.mjs audition                 one line in each candidate voice
 *   node pipeline.mjs generate [ids|groups]    missing/changed clips (default: all)
 *   node pipeline.mjs music [variants=2]       hold-music-a, hold-music-b, …
 *   node pipeline.mjs approve <ids|all>        review → final
 *   node pipeline.mjs redo <ids>               discard and regenerate (new take)
 *   node pipeline.mjs reject <ids>             discard from review
 *   node pipeline.mjs check [ids]              transcribe review clips, flag any that differ from the script
 *   node pipeline.mjs status
 *   node pipeline.mjs serve [port=4870]        review page over http://localhost
 *
 * Final format: WAV, 8 kHz, mono, G.711 μ-law — what Twilio <Play> and Media
 * Streams carry natively, so nothing is transcoded on the call.
 * Needs ffmpeg and ELEVENLABS_API_KEY (env or ivr-audio/.env).
 */

/* global fetch, FormData */
import { Blob, Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, normalize } from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';
import { URL, fileURLToPath } from 'node:url';

import { AUDITION, MUSIC, PART_GAP_MS, PROMPTS, VOICE } from './script.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const REVIEW = join(ROOT, 'review');
const FINAL = join(ROOT, 'final');
const MANIFEST = join(FINAL, 'manifest.json');
const SOURCE_RATE = 44_100;
const CONCURRENCY = 4;

const SPEECH_LUFS = -19;
const MUSIC_LUFS = -25; // ~6 dB under the voice prompts

// ---------------------------------------------------------------- utilities

function apiKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;
  const file = join(ROOT, '.env');
  const match = existsSync(file)
    ? readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m)
    : null;
  if (!match)
    throw new Error('ELEVENLABS_API_KEY is not set (env or ivr-audio/.env)');
  return match[1].trim();
}

/** Trim near-silence from both ends of s16le mono PCM (keeps 20 ms). */
function trimPcm(pcm) {
  const samples = pcm.length >> 1;
  const loud = (i) => Math.abs(pcm.readInt16LE(i * 2)) > 300; // ≈ −40 dBFS
  let start = 0;
  let end = samples;
  while (start < end && !loud(start)) start += 1;
  while (end > start && !loud(end - 1)) end -= 1;
  const keep = Math.round(SOURCE_RATE * 0.02);
  return pcm.subarray(
    Math.max(0, start - keep) * 2,
    Math.min(samples, end + keep) * 2,
  );
}

const sha = (value) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

const speechHash = (prompt) =>
  sha(
    JSON.stringify([
      prompt.parts.length === 1 && !prompt.parts[0].languageCode
        ? prompt.parts[0].speak
        : prompt.parts,
      VOICE.voiceId,
      VOICE.modelId,
      VOICE.settings,
    ]),
  );

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
}

function ffmpeg(args, input) {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-nostdin', '-y', ...args],
    {
      input,
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed: ${result.stderr.toString().slice(-800)}`);
  }
  return result;
}

/**
 * ffmpeg output to a real file, not a pipe: on a pipe it cannot go back and
 * write the WAV length, and browsers (and Twilio) reject "unknown length".
 * Metadata is dropped so the header is a plain RIFF/fmt/data.
 */
let tmpCount = 0;
function ffmpegOut(args, input) {
  const tmp = join(REVIEW, `.tmp-${process.pid}-${(tmpCount += 1)}.wav`);
  try {
    ffmpeg(
      [...args, '-map_metadata', '-1', '-fflags', '+bitexact', tmp],
      input,
    );
    return readFileSync(tmp);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Play time of a WAV, from its data chunk. */
function wavDurationMs(wav) {
  const byteRate = wav.readUInt32LE(28);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = wav.readUInt32LE(offset + 4);
    if (wav.toString('ascii', offset, offset + 4) === 'data')
      return Math.round((size / byteRate) * 1000);
    offset += 8 + size + (size % 2);
  }
  return 0;
}

async function eleven(path, body, attempt = 1) {
  const response = await fetch(`https://api.elevenlabs.io${path}`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 5) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    return eleven(path, body, attempt + 1);
  }
  if (!response.ok) {
    throw new Error(
      `ElevenLabs ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

function tts(text, voiceId, seed, model = VOICE, languageCode = undefined) {
  return eleven(
    `/v1/text-to-speech/${voiceId}?output_format=pcm_${SOURCE_RATE}`,
    {
      text,
      ...(languageCode === undefined ? {} : { language_code: languageCode }),
      model_id: model.modelId,
      voice_settings: model.settings,
      ...(seed === undefined ? {} : { seed }),
    },
  );
}

async function pool(items, worker) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await worker(item);
        } catch (error) {
          failures.push(item.id ?? item);
          console.error(`  ✗ ${item.id ?? item}: ${error.message}`);
        }
      }
    }),
  );
  return failures;
}

// ------------------------------------------------------------ audio shaping

/** Two-pass EBU R128 loudness normalisation settings for `chain`. */
function loudnorm(sourceArgs, chain, lufs) {
  const target = `I=${lufs}:TP=-3:LRA=11`;
  const probe = ffmpeg([
    ...sourceArgs,
    '-af',
    `${chain},loudnorm=${target}:print_format=json`,
    '-f',
    'null',
    '-',
  ]);
  const json = probe.stderr.toString().match(/\{[^{}]*"input_i"[^{}]*\}/);
  const m = json ? JSON.parse(json[0]) : undefined;
  if (!m || !Number.isFinite(Number(m.input_i))) {
    return `loudnorm=${target}`; // too short to measure: single pass
  }
  return (
    `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}` +
    `:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}` +
    `:offset=${m.target_offset}:linear=true`
  );
}

const TO_PHONE =
  'highpass=f=120,lowpass=f=3600,aresample=8000:filter_size=128:phase_shift=10:cutoff=0.97';
const ULAW_OUT = ['-ar', '8000', '-ac', '1', '-c:a', 'pcm_mulaw', '-f', 'wav'];

/** Speech: trim silence both ends, normalise, 100 ms tail, → μ-law WAV. */
function speechToUlaw(sourceWav) {
  const trim =
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,' +
    'areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.06,areverse';
  const src = ['-i', sourceWav];
  const norm = loudnorm(src, trim, SPEECH_LUFS);
  return ffmpegOut([
    ...src,
    '-af',
    `${trim},${norm},apad=pad_dur=0.1,${TO_PHONE}`,
    ...ULAW_OUT,
  ]);
}

/** Music: mono, tail cross-faded into head (seamless loop), quieter, → μ-law WAV. */
function musicToUlaw(sourceWav, durationS) {
  const x = MUSIC.loopCrossfadeS;
  const graph =
    `[0:a]aformat=channel_layouts=mono,asplit=3[a][b][c];` +
    `[a]atrim=0:${x},asetpts=PTS-STARTPTS,afade=t=in:d=${x}:curve=qsin[head];` +
    `[b]atrim=${x}:${durationS - x},asetpts=PTS-STARTPTS[body];` +
    `[c]atrim=${durationS - x},asetpts=PTS-STARTPTS,afade=t=out:d=${x}:curve=qsin[tail];` +
    `[tail][head]amix=inputs=2:normalize=0:duration=longest[joint];` +
    `[joint][body]concat=n=2:v=0:a=1[loop]`;
  const looped = ffmpegOut([
    '-i',
    sourceWav,
    '-filter_complex',
    graph,
    '-map',
    '[loop]',
    '-f',
    'wav',
  ]);
  const tmp = join(REVIEW, `.loop-${process.pid}.wav`);
  writeFileSync(tmp, looped);
  try {
    const src = ['-i', tmp];
    const norm = loudnorm(src, 'anull', MUSIC_LUFS);
    return ffmpegOut([...src, '-af', `${norm},${TO_PHONE}`, ...ULAW_OUT]);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Browsers do not all play μ-law WAV; preview the exact μ-law samples as PCM. */
function ulawPreview(ulawWav) {
  return ffmpegOut(['-i', 'pipe:0', '-c:a', 'pcm_s16le', '-f', 'wav'], ulawWav);
}

function pcmToWav(pcm, channels) {
  return ffmpegOut(
    [
      '-f',
      's16le',
      '-ar',
      String(SOURCE_RATE),
      '-ac',
      String(channels),
      '-i',
      'pipe:0',
      '-f',
      'wav',
    ],
    pcm,
  );
}

// -------------------------------------------------------------- review files

const reviewFiles = (id) => ({
  source: join(REVIEW, `${id}.wav`),
  ulaw: join(REVIEW, `${id}.ulaw.wav`),
  preview: join(REVIEW, `${id}.phone.wav`),
  meta: join(REVIEW, `${id}.json`),
});

function saveForReview(id, sourceWav, toUlaw, meta) {
  const files = reviewFiles(id);
  writeFileSync(files.source, sourceWav);
  const ulaw = toUlaw(files.source);
  writeFileSync(files.ulaw, ulaw);
  writeFileSync(files.preview, ulawPreview(ulaw));
  writeFileSync(
    files.meta,
    JSON.stringify({ ...meta, durationMs: wavDurationMs(ulaw) }, null, 2),
  );
}

function discardReview(id) {
  for (const file of Object.values(reviewFiles(id)))
    rmSync(file, { force: true });
}

const reviewIds = () =>
  existsSync(REVIEW)
    ? readdirSync(REVIEW)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -5))
        .sort()
    : [];

const reviewMeta = (id) => readJson(reviewFiles(id).meta, undefined);

// ----------------------------------------------------------------- commands

function select(args) {
  if (args.length === 0 || args.includes('all')) return PROMPTS;
  const picked = PROMPTS.filter(
    (p) =>
      args.includes(p.id) ||
      args.includes(p.group) ||
      args.some((a) => a.endsWith('*') && p.id.startsWith(a.slice(0, -1))),
  );
  const unknown = args.filter(
    (a) =>
      !PROMPTS.some(
        (p) =>
          p.id === a ||
          p.group === a ||
          (a.endsWith('*') && p.id.startsWith(a.slice(0, -1))),
      ),
  );
  if (unknown.length > 0)
    throw new Error(`Unknown clip or group: ${unknown.join(', ')}`);
  return picked;
}

async function generate(args, { fresh = false } = {}) {
  const force = args.includes('--force');
  const prompts = select(args.filter((a) => a !== '--force'));
  const manifest = readJson(MANIFEST, { clips: {} });
  const todo = prompts.filter((p) => {
    if (force || fresh) return true;
    const hash = speechHash(p);
    return (
      manifest.clips[p.id]?.hash !== hash && reviewMeta(p.id)?.hash !== hash
    );
  });
  if (todo.length === 0) {
    console.log(
      'Nothing to generate: every selected clip is already in review or final.',
    );
    return;
  }
  console.log(`Generating ${todo.length} clip(s) with voice ${VOICE.voiceId}…`);
  const failures = await pool(todo, async (prompt) => {
    // First take is reproducible (fixed seed); a redo asks for a new take.
    const seed = fresh ? Math.floor(Math.random() * 4_294_967_295) : VOICE.seed;
    // Multi-part clips: each part is its own take (same voice), joined with
    // a short gap. Silence inside each take is trimmed only at the clip ends.
    const gap = Buffer.alloc(
      Math.round((SOURCE_RATE * PART_GAP_MS) / 1000) * 2,
    );
    const takes = [];
    for (const part of prompt.parts) {
      takes.push(
        trimPcm(
          await tts(part.speak, VOICE.voiceId, seed, VOICE, part.languageCode),
        ),
      );
    }
    const pcm = Buffer.concat(
      takes.flatMap((take, i) => (i === 0 ? [take] : [gap, take])),
    );
    saveForReview(prompt.id, pcmToWav(pcm, 1), speechToUlaw, {
      id: prompt.id,
      kind: 'speech',
      group: prompt.group,
      text: prompt.text,
      hash: speechHash(prompt),
      voiceId: VOICE.voiceId,
      modelId: VOICE.modelId,
      seed,
    });
    console.log(`  ✓ ${prompt.id}`);
  });
  if (failures.length > 0) process.exitCode = 1;
}

async function audition() {
  console.log(`Audition: ${Object.keys(AUDITION.voices).length} voices…`);
  await pool(
    Object.entries(AUDITION.voices).map(([name, voiceId]) => ({
      id: `audition-${name}`,
      voiceId,
    })),
    async ({ id, voiceId }) => {
      const pcm = await tts(AUDITION.text, voiceId, VOICE.seed, AUDITION);
      saveForReview(id, pcmToWav(pcm, 1), speechToUlaw, {
        id,
        kind: 'audition',
        group: 'audition',
        text: AUDITION.text,
        voiceId,
        modelId: AUDITION.modelId,
      });
      console.log(`  ✓ ${id}`);
    },
  );
}

async function music(args) {
  const named = args.filter((a) => a.startsWith(`${MUSIC.id}-`));
  const variants =
    named.length || Math.min(Math.max(Number(args[0]) || 2, 1), 4);
  const ids =
    named.length > 0
      ? named
      : Array.from(
          { length: variants },
          (_, i) => `${MUSIC.id}-${String.fromCharCode(97 + i)}`,
        );
  console.log(
    `Composing ${variants} hold-music variant(s) (${MUSIC.lengthMs / 1000}s each)…`,
  );
  await pool(
    ids.map((id) => ({ id })),
    async ({ id }) => {
      const prompt =
        MUSIC.takes?.[id.slice(MUSIC.id.length + 1)] ?? MUSIC.prompt;
      const pcm = await eleven(`/v1/music?output_format=pcm_${SOURCE_RATE}`, {
        prompt,
        music_length_ms: MUSIC.lengthMs,
        model_id: 'music_v1',
        force_instrumental: true,
      });
      const durationS = pcm.length / 2 / 2 / SOURCE_RATE; // s16 stereo
      saveForReview(
        id,
        pcmToWav(pcm, 2),
        (src) => musicToUlaw(src, durationS),
        {
          id,
          finalId: MUSIC.id,
          kind: 'music',
          group: 'music',
          text: `Hold music (loops) — ${prompt}`,
          prompt,
        },
      );
      console.log(`  ✓ ${id}`);
    },
  );
}

function approve(args) {
  const ids = args.includes('all') ? reviewIds() : args;
  const manifest = readJson(MANIFEST, {});
  manifest.format = 'wav, 8000 Hz, mono, G.711 mu-law';
  manifest.clips ??= {};
  mkdirSync(FINAL, { recursive: true });
  const approved = [];
  for (const id of ids) {
    const meta = reviewMeta(id);
    if (meta === undefined) {
      console.error(`  ✗ ${id}: not in review`);
      process.exitCode = 1;
      continue;
    }
    if (meta.kind === 'audition') {
      console.log(
        `  · ${id}: auditions are not shipped — set VOICE.voiceId in script.mjs instead`,
      );
      continue;
    }
    const finalId = meta.finalId ?? id;
    // Only one hold-music take can ship; "approve all" keeps the first.
    if (
      meta.kind === 'music' &&
      approved.some((a) => a.startsWith(`${finalId}-`))
    ) {
      console.log(
        `  · ${id}: another ${finalId} take was approved — left in review`,
      );
      continue;
    }
    renameSync(reviewFiles(id).ulaw, join(FINAL, `${finalId}.wav`));
    const {
      kind,
      group,
      text,
      hash,
      voiceId,
      modelId,
      durationMs: ms,
      prompt,
    } = meta;
    manifest.clips[finalId] = {
      file: `${finalId}.wav`,
      kind,
      group,
      text,
      durationMs: ms,
      ...(hash ? { hash, voiceId, modelId } : {}),
      ...(prompt ? { prompt, take: id } : {}),
      approvedAt: new Date().toISOString(),
    };
    discardReview(id);
    approved.push(id);
    console.log(`  ✓ ${id} → final/${finalId}.wav`);
  }
  manifest.clips = Object.fromEntries(
    Object.entries(manifest.clips).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function reject(args) {
  for (const id of args) {
    discardReview(id);
    console.log(`  ✓ ${id} discarded`);
  }
}

// ------------------------------------------------------------ transcript QA

const WORD_DIGITS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];
const words = (text) =>
  text
    .toLowerCase()
    .replace(/fourpoints/g, 'four points')
    .replace(/\b(10|[0-9])\b/g, (d) => WORD_DIGITS[Number(d)])
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

async function transcribe(file) {
  const form = new FormData();
  form.set('model_id', 'scribe_v1');
  form.set(
    'file',
    new Blob([readFileSync(file)], { type: 'audio/wav' }),
    'clip.wav',
  );
  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey() },
    body: form,
  });
  if (!response.ok)
    throw new Error(
      `speech-to-text ${response.status}: ${(await response.text()).slice(0, 200)}`,
    );
  return (await response.json()).text ?? '';
}

/** English parts must match word for word; other languages are shown for a human. */
async function check(args) {
  const ids = (args.length > 0 ? args : reviewIds()).filter(
    (id) => reviewMeta(id)?.kind === 'speech',
  );
  const flagged = [];
  await pool(
    ids.map((id) => ({ id })),
    async ({ id }) => {
      const meta = reviewMeta(id);
      const prompt = PROMPTS.find((p) => p.id === id);
      const transcript = await transcribe(reviewFiles(id).source);
      const english =
        prompt?.parts.find((part) => !part.languageCode)?.speak ?? meta.text;
      const expected = words(english.replace(/\[[^\]]*\]/g, ''));
      const heard = words(transcript);
      const multi = (prompt?.parts.length ?? 1) > 1;
      const ok = multi ? heard.startsWith(expected) : heard === expected;
      meta.transcript = transcript;
      meta.check = ok ? 'match' : 'differs';
      writeFileSync(reviewFiles(id).meta, JSON.stringify(meta, null, 2));
      if (!ok || multi) flagged.push({ id, ok, transcript });
    },
  );
  for (const { id, ok, transcript } of flagged.sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    console.log(`${ok ? '  ✓' : '  ✗'} ${id}: ${transcript}`);
  }
  console.log(
    `${ids.length - flagged.filter((f) => !f.ok).length}/${ids.length} match the script.`,
  );
}

function status() {
  const manifest = readJson(MANIFEST, { clips: {} });
  const inReview = new Set(reviewIds());
  const rows = PROMPTS.map((p) => {
    const hash = speechHash(p);
    const state =
      reviewMeta(p.id)?.hash === hash
        ? 'review'
        : manifest.clips[p.id]?.hash === hash
          ? 'final'
          : manifest.clips[p.id]
            ? 'stale'
            : 'missing';
    return [p.id, state];
  });
  const count = (s) => rows.filter(([, state]) => state === s).length;
  console.log(
    `${PROMPTS.length} speech clips: ${count('final')} final, ${count('review')} in review, ` +
      `${count('stale')} stale (text/voice changed), ${count('missing')} missing`,
  );
  console.log(
    `Hold music: ${manifest.clips[MUSIC.id] ? 'final' : 'not approved'}`,
  );
  const extra = [...inReview].filter((id) => !PROMPTS.some((p) => p.id === id));
  if (extra.length > 0) console.log(`Also in review: ${extra.join(', ')}`);
  const listed = rows.filter(
    ([, state]) =>
      state === 'stale' || (state === 'missing' && count('missing') <= 15),
  );
  for (const [id, state] of listed) console.log(`  ${state}: ${id}`);
}

// ------------------------------------------------------------- review page

const esc = (s) =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );

function writeReviewPage() {
  mkdirSync(REVIEW, { recursive: true });
  const order = [
    'audition',
    'music',
    'opening',
    'language-menu',
    'ai',
    'human',
    'whisper',
    'org',
  ];
  const titles = {
    audition: 'Voice audition — pick one, then set VOICE.voiceId',
    music: 'Hold music — approve one take',
    opening: 'Opening and AI / human menu',
    'language-menu': 'Language menu',
    ai: 'AI interpreter',
    human: 'Human interpreter',
    whisper: 'Heard only by the interpreter',
    org: 'Organization line',
  };
  const metas = reviewIds().map(reviewMeta).filter(Boolean);
  const groups = order
    .map((g) => [g, metas.filter((m) => m.group === g)])
    .filter(([, list]) => list.length > 0);
  const rows = (list) =>
    list
      .map(
        (m) => `
      <tr data-id="${esc(m.id)}">
        <td class="pick"><input type="checkbox" aria-label="Select ${esc(m.id)}"></td>
        <td><code>${esc(m.id)}</code><div class="text">${esc(m.text)}</div>
          <div class="meta">${((m.durationMs ?? 0) / 1000).toFixed(1)} s${m.voiceId ? ` · voice ${esc(m.voiceId)}` : ''}${m.check ? ` · transcript ${m.check === 'match' ? 'matches script' : '<b class="bad">differs</b>'}` : ''}</div>
          ${(m.check && m.check !== 'match') || (m.transcript && m.text !== m.transcript && m.group === 'ai') ? `<div class="meta">Heard: ${esc(m.transcript)}</div>` : ''}</td>
        <td class="players">
          <label>Phone (what callers hear)<audio controls preload="none" src="${esc(m.id)}.phone.wav"></audio></label>
          <label>Studio source<audio controls preload="none" src="${esc(m.id)}.wav"></audio></label>
        </td>
      </tr>`,
      )
      .join('');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IVR Audio Review</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5d50}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#1f1f1d;--ink:#ecece8;--muted:#9a9a93;--line:#33332f;--accent:#7fb8a6}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);padding:14px 16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
h1{font-size:17px;margin:0 auto 0 0}main{max-width:1100px;margin:0 auto;padding:8px 16px 48px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:28px 0 8px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
td{padding:10px 12px;border-top:1px solid var(--line);vertical-align:top}tr:first-child td{border-top:0}
.pick{width:36px}.text{margin-top:2px}.meta{color:var(--muted);font-size:12px;margin-top:4px}
.players{width:340px}.players label{display:block;font-size:12px;color:var(--muted)}.players audio{width:100%;height:32px;margin:2px 0 6px}
code{font-size:12px;color:var(--accent)}button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}#out{width:100%;font:12px ui-monospace,monospace;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
.bad{color:#c0392b}.empty{color:var(--muted);padding:40px 0;text-align:center}
@media (max-width:720px){tr{display:grid;grid-template-columns:36px 1fr}.players{grid-column:1/-1;width:auto}}
</style></head><body>
<header><h1>IVR audio review · ${metas.length} clip(s)</h1>
<button id="all">Select all</button><button id="none">Clear</button>
<button class="primary" data-cmd="approve">Copy “approve”</button><button data-cmd="redo">Copy “redo”</button></header>
<main>
<p><input id="out" readonly placeholder="Select clips, then copy a command and paste it to Claude"></p>
${groups.length === 0 ? '<p class="empty">Nothing waiting for review.</p>' : groups.map(([g, list]) => `<h2>${esc(titles[g] ?? g)}</h2><table>${rows(list)}</table>`).join('\n')}
</main>
<script>
const boxes=()=>[...document.querySelectorAll('tr[data-id] input')];
document.getElementById('all').onclick=()=>boxes().forEach(b=>b.checked=true);
document.getElementById('none').onclick=()=>boxes().forEach(b=>b.checked=false);
document.querySelectorAll('[data-cmd]').forEach(btn=>btn.onclick=async()=>{
  const ids=boxes().filter(b=>b.checked).map(b=>b.closest('tr').dataset.id);
  const out=document.getElementById('out');
  out.value=ids.length?btn.dataset.cmd+' '+ids.join(' '):'';
  out.select();try{await navigator.clipboard.writeText(out.value)}catch{}
});
// One clip at a time.
document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>a!==e.target&&a.pause()),true);
</script></body></html>`;
  writeFileSync(join(REVIEW, 'index.html'), html);
}

// --------------------------------------------------------------------- main

const [command, ...args] = process.argv.slice(2);
mkdirSync(REVIEW, { recursive: true });
try {
  switch (command) {
    case 'audition':
      await audition();
      break;
    case 'generate':
      await generate(args);
      break;
    case 'music':
      await music(args);
      break;
    case 'approve':
      approve(args);
      break;
    case 'redo':
      for (const id of args) discardReview(id);
      if (args.some((id) => id.startsWith(MUSIC.id))) await music(args);
      if (args.some((id) => !id.startsWith(MUSIC.id)))
        await generate(
          args.filter((id) => !id.startsWith(MUSIC.id)),
          { fresh: true },
        );
      break;
    case 'reject':
      reject(args);
      break;
    case 'check':
      await check(args);
      break;
    case 'status':
      status();
      break;
    case 'serve': {
      // file:// pages cannot always load their audio; serve the folder instead.
      writeReviewPage();
      const port = Number(args[0]) || 4870;
      const types = {
        '.html': 'text/html; charset=utf-8',
        '.wav': 'audio/wav',
        '.json': 'application/json',
      };
      createServer((req, res) => {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = normalize(
          join(REVIEW, path === '/' ? 'index.html' : path),
        );
        if (
          req.method !== 'GET' ||
          !file.startsWith(REVIEW) ||
          !existsSync(file)
        ) {
          res.writeHead(404).end('Not found');
          return;
        }
        const body = file.endsWith('index.html')
          ? (writeReviewPage(), readFileSync(file))
          : readFileSync(file);
        res
          .writeHead(200, {
            'content-type':
              types[file.slice(file.lastIndexOf('.'))] ??
              'application/octet-stream',
            'cache-control': 'no-store',
          })
          .end(body);
      }).listen(port, '127.0.0.1', () =>
        console.log(`Review page: http://localhost:${port}/`),
      );
      break;
    }
    default:
      console.log(
        'Usage: node pipeline.mjs audition | generate [ids|groups] | music [n] | approve <ids|all> | redo <ids> | reject <ids> | status',
      );
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  writeReviewPage();
}
if (command && command !== 'status' && command !== 'serve')
  console.log(`Review page: ${join(REVIEW, 'index.html')}`);
