import type { FourPointsAuthConfig } from './config.js';

/** Headers for the FourPoints WebSocket upgrade. */
export type AuthHeaders = () => Promise<Record<string, string>>;

const TOKEN_TIMEOUT_MS = 5_000;
const EXPIRY_MARGIN_MS = 60_000;

/**
 * `none`: local FourPoints (REQUIRE_AUTH unset) — no headers.
 * `client-credentials`: OAuth 2.0 access token (e.g. a Cognito
 * machine-to-machine client) sent as `Authorization: Bearer`. One token is
 * shared by every call on the instance until shortly before it expires, and
 * concurrent callers share one in-flight request — a burst of 100 calls costs
 * one token request, not 100.
 */
export function createAuthHeaders(
  config: FourPointsAuthConfig,
  fetchImpl: typeof fetch = fetch,
): AuthHeaders {
  if (config.mode === 'none') {
    return () => Promise.resolve({});
  }
  const { tokenUrl, clientId, clientSecret, scope } = config;
  let token: { value: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  const requestToken = async (): Promise<string> => {
    const res = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope,
      }).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`token endpoint returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      access_token?: unknown;
      expires_in?: unknown;
    };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('token endpoint returned no access_token');
    }
    const lifetimeS =
      typeof body.expires_in === 'number' ? body.expires_in : 3600;
    token = {
      value: body.access_token,
      expiresAt: Date.now() + lifetimeS * 1000 - EXPIRY_MARGIN_MS,
    };
    return body.access_token;
  };

  return async () => {
    if (token !== undefined && Date.now() < token.expiresAt) {
      return { authorization: `Bearer ${token.value}` };
    }
    inflight ??= requestToken().finally(() => {
      inflight = undefined;
    });
    return { authorization: `Bearer ${await inflight}` };
  };
}
