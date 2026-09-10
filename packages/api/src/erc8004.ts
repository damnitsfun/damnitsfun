import type { AgentRow } from './orchestrator';

/**
 * ERC-8004 agent identity (sub-spec 23, § B).
 *
 * Every agent here is already issued a custodial EOA at registration (sub-spec
 * 14). This module gives that EOA a public, on-chain identity in the ERC-8004
 * Identity Registry — the standard BNB Chain's own agent stack is built on, and
 * the registry BNB Chain's MCP server points at.
 *
 * It is deliberately ADDITIVE. There is no agent registry in this codebase to
 * migrate off, nothing here gates play, settlement or payout, and an agent whose
 * registration never lands is an agent that works exactly as it did before.
 *
 * The document this module builds is served live (D178) rather than frozen into
 * a base64 `data:` URI, so the on-chain identity resolves to the agent's real
 * profile page instead of a snapshot taken the moment it registered.
 */

/**
 * The ERC-8004 Identity Registry, deployed at the same deterministic address on
 * every chain that has one (`erc-8004/erc-8004-contracts`).
 *
 * Verified present on BSC testnet before this was written: `eth_getCode` at the
 * chain-97 address returns a deployed proxy. Do not add a chain here without
 * checking the same way — a wrong address fails as a silent no-op, because a
 * call to an address with no code returns success and empty data.
 */
const IDENTITY_REGISTRY: Record<number, string> = {
  // mainnets (BSC 56 among them)
  56: '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432',
  // testnets (BSC testnet 97 among them)
  97: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

export function identityRegistryAddress(chainId: number): string | null {
  return IDENTITY_REGISTRY[chainId] ?? null;
}

/** One entry in the document's `services` array. */
interface RegistrationService {
  name: string;
  endpoint: string;
  capabilities?: string[];
}

/**
 * An ERC-8004 registration file.
 *
 * The shape mirrors what `@bnbagent/sdk`'s `AgentURIGenerator` produces, so a
 * reader that understands one understands the other. We build it here rather
 * than calling the SDK because this route is public, hot and must not depend on
 * a chain client being constructible — the SDK is needed to WRITE an identity,
 * never to describe one.
 */
export interface RegistrationDocument {
  type: string;
  name: string;
  description: string;
  image: string;
  services: RegistrationService[];
  /**
   * Empty until the agent is registered on chain, which is the normal state for
   * the window between `POST /register` and the next reconciler pass — and the
   * permanent state on a deployment with no chain wiring at all.
   */
  registrations: Array<{ agentId: number; agentRegistry: string }>;
  /**
   * The agent's own EOA — the address a prize is actually paid to.
   *
   * An extension to the base schema, and deliberately so: it states plainly, in
   * the document itself, which address a prize is paid to, without a reader
   * having to infer it from the token's owner. Since D177 those are the same
   * address — the agent signs its own registration, so it owns its own identity —
   * but a reader should not have to know that to find the wallet. A reader that
   * does not know the field ignores it.
   */
  walletAddress: string | null;
}

export interface RegistrationDocumentOptions {
  agent: Pick<AgentRow, 'id' | 'display_name' | 'wallet_address' | 'erc8004_agent_id'>;
  /** Public origin of this deployment, no trailing slash. */
  publicBaseUrl: string;
  /** API prefix the machine-readable record is served under. */
  apiBaseUrl: string;
  chainId: number;
}

export function registrationDocument(opts: RegistrationDocumentOptions): RegistrationDocument {
  const { agent, publicBaseUrl, apiBaseUrl, chainId } = opts;
  const base = publicBaseUrl.replace(/\/$/, '');
  const api = apiBaseUrl.replace(/\/$/, '');
  const registry = identityRegistryAddress(chainId);

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: agent.display_name,
    description:
      `An autonomous agent competing in the damnits.fun battleground: a shedding-style ` +
      `card game played over HTTP against other autonomous agents, with commit-reveal ` +
      `shuffles and on-chain prize settlement on BNB Smart Chain. Its full record — every ` +
      `table, every move, and a replay of each — is public at ${base}/agent/${agent.id}.`,
    // The agent's face, served live from this deployment (D178) rather than
    // inlined as a data: URI. It was empty until § B's avatar route existed,
    // which meant every damnits identity rendered as a blank square in any
    // reader outside our own site — 8004scan, wallets, explorers — while the
    // web app had been drawing that same face since sub-spec 19.
    image: `${api}/agent/${agent.id}/avatar.svg`,
    services: [
      // The human-readable record. This is the same `profileUrl` that
      // `GET /agent/me` hands the agent's own operator (sub-spec 19, D127), so
      // the on-chain identity and the product point at one page, not two.
      { name: 'web', endpoint: `${base}/agent/${agent.id}` },
      // The machine-readable one, for a reader that wants the record rather
      // than the page.
      {
        name: 'battleground',
        endpoint: `${api}/agent/${agent.id}/profile`,
        capabilities: ['damnits.battleground.profile.v1'],
      },
    ],
    // Populated only once all three parts are known, matching the SDK's own rule.
    registrations:
      agent.erc8004_agent_id !== null && registry
        ? [
            {
              agentId: agent.erc8004_agent_id,
              agentRegistry: `eip155:${chainId}:${registry}`,
            },
          ]
        : [],
    walletAddress: agent.wallet_address,
  };
}

// ---------------------------------------------------------------------------
// Registration (D175–D177, D179)
// ---------------------------------------------------------------------------

/** What one successful registration produced. */
export interface RegistrationResult {
  agentId: number;
  txHash: string;
  /**
   * Effective gas price of the registration, as a decimal string.
   *
   * Recorded on purpose (D179/T121). On BSC testnet this is currently `"0"` —
   * MegaFuel sponsors the write, measured — but that is somebody else's policy
   * and it can be withdrawn. Logging the real number is how a withdrawal shows
   * up as data instead of as a surprise bill.
   */
  gasPrice: string | null;
}

/**
 * The seam every registration goes through.
 *
 * One interface so the reconciler can be tested against a stub: the cases that
 * matter (the registry is down, the call hangs, it fails and then succeeds) are
 * not reachable against a real chain in a unit test.
 */
export interface IdentityRegistrar {
  register(input: {
    agentId: string;
    displayName: string;
    privateKey: `0x${string}`;
    agentUri: string;
  }): Promise<RegistrationResult>;
}

/**
 * The real registrar, backed by `@bnbagent/sdk`.
 *
 * Imported lazily so the SDK is loaded only by a deployment that actually
 * registers identities — a test, a local box, or a chainless deployment never
 * pays for it, and an SDK that fails to load cannot take the server down with it.
 *
 * `persist: false` is load-bearing: without it the SDK writes a Keystore V3 file
 * to `~/.bnbagent/wallets/`, which would put a second copy of every agent's
 * private key on disk outside the AES-256-GCM store that is supposed to be the
 * only place one lives at rest (sub-spec 14).
 */
export function createIdentityRegistrar(opts: {
  chainId: number;
  rpcUrl: string;
  network?: string;
}): IdentityRegistrar | null {
  if (!identityRegistryAddress(opts.chainId)) return null;
  const network = opts.network ?? (opts.chainId === 56 ? 'bsc-mainnet' : 'bsc-testnet');

  return {
    async register({ privateKey, agentUri }) {
      // The SDK reads its RPC from the environment; its own default for chain 97
      // timed out in testing, so pin ours for the duration of the call.
      const previous = process.env.RPC_URL;
      process.env.RPC_URL = opts.rpcUrl;
      try {
        const { EVMWalletProvider } = await import('@bnbagent/sdk');
        const { ERC8004Agent, AgentEndpoint } = await import('@bnbagent/sdk/erc8004');

        const walletProvider = new EVMWalletProvider({
          // Never persisted, so this password protects nothing on disk; it exists
          // because the SDK's constructor requires one.
          password: 'damnits-in-memory-signer',
          privateKey,
          persist: false,
        });
        const client = await ERC8004Agent.create({ walletProvider, network });

        // The URI we register is our own live document (D178), not the SDK's
        // base64 snapshot — `generateAgentUri` is deliberately not used.
        const result = await client.registerAgent(agentUri, [
          { key: 'agentUri', value: agentUri },
        ]);
        if (result.agentId === null) {
          throw new Error('registry assigned no agent id');
        }
        return {
          agentId: result.agentId,
          txHash: result.transactionHash,
          gasPrice:
            result.receipt?.effectiveGasPrice !== undefined
              ? String(result.receipt.effectiveGasPrice)
              : null,
        };
      } finally {
        if (previous === undefined) delete process.env.RPC_URL;
        else process.env.RPC_URL = previous;
      }
    },
  };
}

export interface ReconcileDeps {
  db: import('./db/index').Db;
  registrar: IdentityRegistrar | null;
  walletStore: import('./agent-wallet').WalletStore;
  publicBaseUrl: string;
  apiBaseUrl: string;
  chainId: number;
  log?: (message: string) => void;
  /** Cap per pass, so a large backlog cannot hold up boot. Passes repeat. */
  limit?: number;
}

export interface ReconcileSummary {
  registered: number;
  failed: number;
  /** Agents deliberately not attempted — see `isPubliclyResolvable`. */
  skipped: number;
}

/**
 * Can the registry actually fetch a document at this base URL?
 *
 * ERC-8004 resolves the `agentUri` before accepting a registration, and does so
 * behind an SSRF guard that rejects loopback, private, link-local and reserved
 * ranges. So a document served from `http://localhost:8080` is unregisterable by
 * construction — not a transient failure, and not worth retrying.
 */
export function isPubliclyResolvable(baseUrl: string): boolean {
  let host: string;
  try {
    const url = new URL(baseUrl);
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return false;
  // IPv4 literals in the ranges the guard rejects: loopback, private, link-local
  // and CGNAT. A hostname that is not an IP literal is assumed resolvable — DNS
  // can still point it somewhere private, and the registry will say so.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return true;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  return true;
}

function countPending(db: import('./db/index').Db): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM agents a
           JOIN agent_wallets w ON w.agent_id = a.id
          WHERE a.erc8004_agent_id IS NULL`,
      )
      .get() as { n: number }
  ).n;
}

/**
 * Give an on-chain identity to every agent that has a wallet and no identity yet
 * (D176).
 *
 * Runs at boot and after each `POST /register`, never from a constructor. The
 * query that finds work asks "no identity yet", never "just registered", so a
 * crash mid-flight, a registry outage or an RPC failure all self-heal on the next
 * pass rather than stranding an agent forever.
 *
 * Never throws. An agent with no identity registers, plays, settles and is paid
 * exactly as it did before this spec existed — identity is decoration on a
 * working system and has to behave like it.
 */
export async function reconcileIdentities(deps: ReconcileDeps): Promise<ReconcileSummary> {
  const { db, registrar, walletStore, log = () => {}, limit = 25 } = deps;
  const summary: ReconcileSummary = { registered: 0, failed: 0, skipped: 0 };
  if (!registrar || !walletStore.enabled) return summary;

  // The registry RESOLVES the agentUri before it accepts a registration, behind
  // an SSRF guard that rejects loopback and private addresses. That is the price
  // of D178's live document over a frozen base64 one, and it is worth paying —
  // but it means a laptop can never register, and without this check every dev
  // box would retry forever and log a confusing "Failed to parse agent URI" per
  // agent per pass. Say it once, plainly, and leave them for a box that can.
  if (!isPubliclyResolvable(deps.apiBaseUrl)) {
    const pending = countPending(db);
    if (pending > 0) {
      log(
        `[erc8004] skipping ${pending} agent(s): PUBLIC_BASE_URL is ${deps.apiBaseUrl}, which the ` +
          `registry cannot fetch. Identities register from a publicly reachable deployment.`,
      );
    }
    summary.skipped = pending;
    return summary;
  }

  const pending = db
    .prepare(
      `SELECT a.id AS id, a.display_name AS display_name, w.enc_private_key AS enc_private_key
         FROM agents a
         JOIN agent_wallets w ON w.agent_id = a.id
        WHERE a.erc8004_agent_id IS NULL
        ORDER BY a.created_at ASC
        LIMIT ?`,
    )
    .all(limit) as Array<{ id: string; display_name: string; enc_private_key: string }>;

  for (const row of pending) {
    try {
      const agentUri = `${deps.apiBaseUrl.replace(/\/$/, '')}/agent/${row.id}/erc8004.json`;
      const result = await registrar.register({
        agentId: row.id,
        displayName: row.display_name,
        privateKey: walletStore.decrypt(row.enc_private_key),
        agentUri,
      });
      db.prepare(
        `UPDATE agents
            SET erc8004_agent_id = ?, erc8004_tx_hash = ?, erc8004_registered_at = datetime('now')
          WHERE id = ?`,
      ).run(result.agentId, result.txHash, row.id);
      summary.registered += 1;
      // T121: the gas price is the durability signal for D179's sponsorship.
      log(
        `[erc8004] ${row.id} -> agent ${result.agentId} (tx ${result.txHash}, ` +
          `gasPrice ${result.gasPrice ?? 'unknown'})`,
      );
    } catch (err) {
      // Recorded, not thrown — same rule as chain.ts. The next pass retries it.
      summary.failed += 1;
      log(`[erc8004] ${row.id} registration failed, will retry: ${(err as Error).message}`);
    }
  }
  return summary;
}
