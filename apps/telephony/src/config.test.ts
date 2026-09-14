import { describe, expect, it } from 'vitest';

import { loadConfig } from './config.js';

const MINIMAL = {
  PUBLIC_BASE_URL: 'https://phone.example.com/',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_AUTH_TOKEN: 'token',
  HUMAN_INTERPRETER_NUMBERS: '{"default":["+15550000001"]}',
};

describe('loadConfig', () => {
  it('applies local-development defaults that work with FourPoints out of the box', () => {
    const config = loadConfig(MINIMAL);
    expect(config).toMatchObject({
      port: 8080,
      publicBaseUrl: 'https://phone.example.com',
      validateSignatures: true,
      fourPointsUrl: 'ws://localhost:8787',
      fourPointsAuth: { mode: 'none' },
      clinicianLanguageId: 'en-US',
      inputSampleRateHz: 16000,
      maxCalls: 20,
      humanNumbers: { default: ['+15550000001'] },
    });
  });

  it('reports every problem at once', () => {
    expect(() => loadConfig({})).toThrowError(
      /PUBLIC_BASE_URL is required[\s\S]*TWILIO_ACCOUNT_SID is required[\s\S]*TWILIO_AUTH_TOKEN is required[\s\S]*"default"/,
    );
  });

  it('refuses insecure settings in production', () => {
    const run = () =>
      loadConfig({
        ...MINIMAL,
        NODE_ENV: 'production',
        PUBLIC_BASE_URL: 'http://phone.example.com',
        TWILIO_VALIDATE_SIGNATURES: 'false',
      });
    expect(run).toThrowError(/must use https in production/);
    expect(run).toThrowError(/TWILIO_VALIDATE_SIGNATURES=false is refused/);
    expect(run).toThrowError(/FOURPOINTS_WS_URL must use wss/);
    expect(run).toThrowError(/FOURPOINTS_AUTH=none is refused/);
  });

  it('accepts a production machine-auth configuration', () => {
    const config = loadConfig({
      ...MINIMAL,
      NODE_ENV: 'production',
      FOURPOINTS_WS_URL: 'wss://app.example.com/ws/telephony',
      FOURPOINTS_AUTH: 'client-credentials',
      FOURPOINTS_TOKEN_URL: 'https://auth.example.com/oauth2/token',
      FOURPOINTS_CLIENT_ID: 'id',
      FOURPOINTS_CLIENT_SECRET: 'secret',
      FOURPOINTS_SCOPE: 'fourpoints-realtime/telephony.session',
    });
    expect(config.fourPointsAuth.mode).toBe('client-credentials');
  });

  it('validates interpreter numbers, URLs and sample rate', () => {
    expect(() =>
      loadConfig({
        ...MINIMAL,
        HUMAN_INTERPRETER_NUMBERS: '{"default":["5550000001"]}',
      }),
    ).toThrowError(/E\.164/);
    expect(() =>
      loadConfig({
        ...MINIMAL,
        PUBLIC_BASE_URL: 'https://phone.example.com/twilio',
      }),
    ).toThrowError(/no path or query/);
    expect(() =>
      loadConfig({ ...MINIMAL, INPUT_SAMPLE_RATE_HZ: '44100' }),
    ).toThrowError(/8000 or 16000/);
    expect(() =>
      loadConfig({ ...MINIMAL, FOURPOINTS_AUTH: 'client-credentials' }),
    ).toThrowError(/FOURPOINTS_TOKEN_URL is required/);
  });
});
