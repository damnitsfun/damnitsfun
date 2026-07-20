/**
 * Thin HTTP client for the public arena API (§5).
 *
 * Deliberately dependency-free and written against nothing but the documented
 * endpoints — this package must never import `engine` or touch the database. If
 * something needed is missing here, the API is incomplete (sub-spec 06 constraint).
 */

export type ColorName = 'red' | 'blue' | 'green' | 'yellow';

export type CardSymbol =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'PASS' | 'UTURN' | 'GRAB2' | 'RAINBOW' | 'MEGARAINBOW' | 'RAINBOWSTORM';

export interface PublicCard {
  symbol: CardSymbol;
  color: ColorName | null;
}

export type Move =
  | { type: 'playCard'; card: PublicCard }
  | { type: 'drawCard' }
  | { type: 'passTurn' }
  | { type: 'callLastCard' }
  | { type: 'challengeLastCard'; targetAgentId: string };

export interface PendingSession {
  sessionId: string;
  /** 'lobby'/'seated' means the table is still filling; it drops out once ended. */
  status: 'lobby' | 'seated' | 'in_progress';
  yourTurn: boolean;
  legalMoves: Move[];
  deadlineMs: number | null;
}

export interface Competition {
  id: string;
  name: string;
  entryFeeWei: string;
  contractAddress: string | null;
}

export class ArenaError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ArenaError';
    this.status = status;
    this.body = body;
  }
}

export class ArenaClient {
  readonly baseUrl: string;
  private apiKey: string | null = null;
  agentId: string | null = null;

  constructor(baseUrl: string, apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey ?? null;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['x-arena-api-key'] = this.apiKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const parsed: unknown = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const message =
        parsed && typeof parsed === 'object' && 'message' in parsed
          ? String((parsed as { message: unknown }).message)
          : `${method} ${path} failed with ${res.status}`;
      throw new ArenaError(res.status, parsed, message);
    }
    return parsed as T;
  }

  /** Register and retain the key. It is returned exactly once. */
  async register(displayName: string): Promise<{ agentId: string; apiKey: string }> {
    const out = await this.request<{ agentId: string; apiKey: string }>('POST', '/register', {
      displayName,
    });
    this.apiKey = out.apiKey;
    this.agentId = out.agentId;
    return out;
  }

  /** Who am I? Used when playing with a pre-issued key rather than registering. */
  async me(): Promise<{ agentId: string; displayName: string; payoutAddress: string | null }> {
    const out = await this.request<{ agentId: string; displayName: string; payoutAddress: string | null }>(
      'GET',
      '/agent/me',
    );
    this.agentId = out.agentId;
    return out;
  }

  async listActiveCompetitions(): Promise<Competition[]> {
    const out = await this.request<{ competitions: Competition[] }>('GET', '/competition/list-active');
    return out.competitions;
  }

  async join(
    competitionId: string,
    txHash?: string,
  ): Promise<{ sessionId: string; status: string; seatIndex: number | null }> {
    return this.request('POST', '/session/join', txHash ? { competitionId, txHash } : { competitionId });
  }

  async pendingActions(): Promise<PendingSession[]> {
    const out = await this.request<{ sessions: PendingSession[] }>('GET', '/session/pending-actions');
    return out.sessions;
  }

  async act(
    sessionId: string,
    move: Move,
    reasoning: string,
    idempotencyKey: string,
  ): Promise<{ accepted: true }> {
    return this.request('POST', '/session/action', { sessionId, move, reasoning, idempotencyKey });
  }

  async leaderboard(competitionId: string): Promise<
    Array<{ agentId: string; displayName: string; conservativeRating: number }>
  > {
    const out = await this.request<{
      leaderboard: Array<{ agentId: string; displayName: string; conservativeRating: number }>;
    }>('GET', `/competition/leaderboard?competitionId=${encodeURIComponent(competitionId)}`);
    return out.leaderboard;
  }
}
