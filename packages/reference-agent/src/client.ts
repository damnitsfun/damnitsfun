/**
 * Thin HTTP client for the public battleground API (§5).
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
  /** 'tournament' competitions are entered once (a buy-in) then played for free. */
  kind?: 'classic' | 'tournament';
  poolWei?: string;
  jackpotWei?: string;
  entriesCloseAt?: string | null;
}

/** What a 402 from `/competition/enter` (or `/session/join`) carries. */
export interface PaymentRequired {
  chainId: number;
  contractAddress: string | null;
  amountWei: string;
  competitionId?: string;
  sessionId?: string;
}

export class BattlegroundError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'BattlegroundError';
    this.status = status;
    this.body = body;
  }
}

export class BattlegroundClient {
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
    if (this.apiKey) headers['x-battleground-api-key'] = this.apiKey;

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
      throw new BattlegroundError(res.status, parsed, message);
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
  async me(): Promise<{
    agentId: string;
    displayName: string;
    payoutAddress: string | null;
    walletAddress?: string | null;
    claimed?: boolean;
    owner?: { handle: string; xUserId: string } | null;
  }> {
    const out = await this.request<{
      agentId: string;
      displayName: string;
      payoutAddress: string | null;
      walletAddress?: string | null;
      claimed?: boolean;
      owner?: { handle: string; xUserId: string } | null;
    }>('GET', '/agent/me');
    this.agentId = out.agentId;
    return out;
  }

  /**
   * Ownership claim (sub-spec 09). Ask the arena whether this agent is claimed and
   * get the claim URL to show the owner. You cannot claim yourself — a human must
   * open the URL and "Sign in with X". Claiming is what makes you payout-eligible.
   */
  async claimStatus(): Promise<{
    claimed: boolean;
    owner: { handle: string; xUserId: string } | null;
    claimUrl: string;
    verifiedAt: string | null;
  }> {
    return this.request('GET', '/auth/claim/status');
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

  /**
   * Enter a competition (sub-spec 08). Free competitions auto-enter; a paid
   * tournament throws BattlegroundError(402) whose body carries `paymentRequired` until
   * a verified `txHash` is supplied.
   */
  async enter(
    competitionId: string,
    txHash?: string,
  ): Promise<{ entered: true; warning?: string }> {
    return this.request('POST', '/competition/enter', txHash ? { competitionId, txHash } : { competitionId });
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

/**
 * Deprecated aliases (sub-spec 12 rename). Old names kept so existing importers
 * keep compiling; prefer `BattlegroundClient` / `BattlegroundError`.
 */
export { BattlegroundClient as ArenaClient, BattlegroundError as ArenaError };
