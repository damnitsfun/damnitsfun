/**
 * Block-explorer URLs (sub-spec 23, D173).
 *
 * The battleground has always anchored its games on chain and never shown anyone
 * where: the site says "on-chain" and "revealed" throughout while linking not a
 * single transaction. This module is the one place that knows how to turn a chain
 * id plus a hash or address into a link, so the demo harness, the API and the web
 * all point at the same explorer instead of each hard-coding a host.
 *
 * Derived from the chain id rather than configured. An explorer base is a fact
 * about a network, not a deployment setting, and every env var this project adds
 * is another value that can drift away from the box it describes (see the
 * `PAYOUT_FIELD_FRACTION` note in CLAUDE.md — a default changed in code while two
 * deployments kept paying the old one for days).
 */

const EXPLORERS: Record<number, string> = {
  56: 'https://bscscan.com',
  97: 'https://testnet.bscscan.com',
  204: 'https://opbnbscan.com',
  5611: 'https://testnet.opbnbscan.com',
};

/**
 * The explorer origin for a chain, or `null` when we do not know one.
 *
 * Null is a real answer, not a failure: a local or test deployment runs against
 * a chain id nobody publishes an explorer for, and the caller's job is then to
 * render no link rather than a broken one.
 */
export function explorerBaseUrl(chainId: number): string | null {
  return EXPLORERS[chainId] ?? null;
}

/** A link to one transaction or address, or `null` on an unknown chain. */
export function explorerUrl(
  chainId: number,
  kind: 'tx' | 'address',
  value: string | null | undefined,
): string | null {
  const base = explorerBaseUrl(chainId);
  if (!base || !value) return null;
  return `${base}/${kind}/${value}`;
}
