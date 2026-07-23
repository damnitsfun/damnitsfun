import type { Config } from './config';

/**
 * "Sign in with Google" — Google OAuth 2.0 (Authorization Code + PKCE), used to
 * authenticate a PERSON into the web app (sub-spec 11). This is the low-friction
 * browser login; claiming/owning agents is a separate step ("connect X", 09).
 *
 * Scopes are identity-only (`openid email profile`) — we read the stable subject
 * id + email + name and nothing else. The access token is used once (to read the
 * userinfo endpoint) and discarded; no refresh token is kept.
 *
 * Absent `GOOGLE_CLIENT_ID` the provider is DISABLED — the arena still runs, web
 * login just answers a clear "not configured" error (mirrors 09's X and the chain).
 *
 * The shape mirrors `xoauth.ts` deliberately, so both providers share the same
 * PKCE/state plumbing and are trivially swappable.
 */

export interface GoogleIdentity {
  /** Google's stable subject id — the key we key an account on. */
  sub: string;
  email: string | null;
  name: string | null;
}

export interface GoogleOAuthProvider {
  readonly enabled: boolean;
  authorizeUrl(params: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(params: { code: string; codeVerifier: string; redirectUri: string }): Promise<string>;
  getIdentity(accessToken: string): Promise<GoogleIdentity>;
}

const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

class RealGoogleOAuthProvider implements GoogleOAuthProvider {
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
      // Identity only — no offline access, so Google issues no refresh token.
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
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
    // Google requires the client secret for a "web" client (PKCE alone isn't enough).
    if (this.clientSecret) body.set('client_secret', this.clientSecret);

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`);
    }
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new Error('Google token exchange returned no access_token');
    return json.access_token;
  }

  async getIdentity(accessToken: string): Promise<GoogleIdentity> {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Google userinfo failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { sub?: string; email?: string; name?: string };
    if (!json.sub) throw new Error('Google userinfo returned no subject');
    return { sub: json.sub, email: json.email ?? null, name: json.name ?? null };
  }
}

/** Provider used when Google is not configured: every call fails with a clear message. */
export const DISABLED_GOOGLE_OAUTH: GoogleOAuthProvider = {
  enabled: false,
  authorizeUrl() {
    throw new Error('Google login is not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
  },
  async exchangeCode() {
    throw new Error('Google login is not configured');
  },
  async getIdentity() {
    throw new Error('Google login is not configured');
  },
};

export function createGoogleOAuth(config: Config): GoogleOAuthProvider {
  if (!config.googleClientId) return DISABLED_GOOGLE_OAUTH;
  return new RealGoogleOAuthProvider(config.googleClientId, config.googleClientSecret, config.googleScopes);
}
