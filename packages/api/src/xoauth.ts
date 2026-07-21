import { createHash, randomBytes } from 'node:crypto';
import type { Config } from './config';

/**
 * "Sign in with X" — Twitter/X OAuth 2.0 (Authorization Code + PKCE), used ONLY
 * to verify who owns an agent (sub-spec 09). This is the exact mechanism arena.dev.fun
 * uses to claim an agent: the owner authorises a read-only app on X, and we read
 * back their user id + handle to bind the agent to that X-verified identity.
 *
 * Scopes are read-only (`tweet.read users.read`) — we never post. The access token
 * is used once (to read `users/me`) and discarded; only the X user id + handle are
 * stored. No key material of the owner ever reaches us (Safety boundary).
 *
 * Absent `X_CLIENT_ID` the provider is DISABLED — the arena still runs, claim just
 * answers a clear "not configured" error, mirroring how the chain is a no-op with
 * no operator key.
 */

export interface XIdentity {
  /** X numeric user id — the stable key we bind ownership on. */
  id: string;
  /** @handle at claim time (display only; can change on X). */
  username: string;
}

export interface XOAuthProvider {
  readonly enabled: boolean;
  /** The URL to redirect the owner to, to authorise the app on X. */
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  /** Exchange the returned auth code for an access token (PKCE, no stored secret leak). */
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string>;
  /** Read the authenticated user's id + handle from `GET /2/users/me`. */
  getIdentity(accessToken: string): Promise<XIdentity>;
}

// ---- PKCE + state helpers ---------------------------------------------------

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh PKCE code verifier (kept server-side, never sent to X). */
export function newCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

/** The S256 challenge for a verifier — this is what X sees. */
export function codeChallengeOf(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

/** A fresh CSRF state value, echoed back on the callback and matched. */
export function newOauthState(): string {
  return base64Url(randomBytes(24));
}

// ---- Twitter/X implementation ----------------------------------------------

const X_AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize';
const X_TOKEN_URL = 'https://api.twitter.com/2/oauth2/token';
const X_ME_URL = 'https://api.twitter.com/2/users/me';

class TwitterOAuthProvider implements XOAuthProvider {
  readonly enabled = true;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string | null,
    private readonly scopes: string,
  ) {}

  authorizeUrl({
    state,
    codeChallenge,
    redirectUri,
  }: {
    state: string;
    codeChallenge: string;
    redirectUri: string;
  }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
      scope: this.scopes,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${X_AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode({
    code,
    codeVerifier,
    redirectUri,
  }: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: this.clientId,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    // Confidential clients authenticate the token call with HTTP Basic.
    if (this.clientSecret) {
      const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      headers.authorization = `Basic ${basic}`;
    }

    const res = await fetch(X_TOKEN_URL, { method: 'POST', headers, body });
    if (!res.ok) {
      throw new Error(`X token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('X token exchange returned no access_token');
    return json.access_token;
  }

  async getIdentity(accessToken: string): Promise<XIdentity> {
    const res = await fetch(X_ME_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`X users/me failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { data?: { id: string; username: string } };
    if (!json.data?.id || !json.data?.username) throw new Error('X users/me returned no user');
    return { id: json.data.id, username: json.data.username };
  }
}

/** Provider used when X is not configured: every call fails with a clear message. */
export const DISABLED_XOAUTH: XOAuthProvider = {
  enabled: false,
  authorizeUrl() {
    throw new Error('X login is not configured (set X_CLIENT_ID / X_CLIENT_SECRET)');
  },
  async exchangeCode() {
    throw new Error('X login is not configured');
  },
  async getIdentity() {
    throw new Error('X login is not configured');
  },
};

export function createXOAuth(config: Config): XOAuthProvider {
  if (!config.xClientId) return DISABLED_XOAUTH;
  return new TwitterOAuthProvider(config.xClientId, config.xClientSecret, config.xScopes);
}
