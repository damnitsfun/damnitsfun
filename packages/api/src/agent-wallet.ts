import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

/**
 * Custodial agent wallets (sub-spec 14, T48).
 *
 * Every agent is issued a fresh EOA at registration so that ANY agent — claimed
 * or not — can receive a Rainbow-Storm jackpot to its own on-chain identity. The
 * arena holds the key custodially, so it is stored ENCRYPTED at rest with
 * AES-256-GCM under `WALLET_ENCRYPTION_KEY` (§9 secret). The plaintext key never
 * leaves this module: it is not returned by the API, never logged, and never put
 * in the event log. Losing/rotating `WALLET_ENCRYPTION_KEY` forfeits custody.
 *
 * The store is a pure crypto/keygen helper — the orchestrator owns the DB rows.
 */

export interface GeneratedWallet {
  /** Public EOA address — safe to expose (this is what a jackpot pays). */
  address: string;
  /** `ivHex:authTagHex:cipherHex` — persist verbatim; opaque outside this module. */
  encPrivateKey: string;
}

export interface WalletStore {
  /** True when `WALLET_ENCRYPTION_KEY` is set; false disables auto-wallets entirely. */
  readonly enabled: boolean;
  /** Generate a fresh EOA + its encrypted key, or `null` when disabled. */
  generate(): GeneratedWallet | null;
  /** Decrypt a stored key for signing (a future withdrawal path). Throws if disabled/tampered. */
  decrypt(encPrivateKey: string): `0x${string}`;
}

/** A no-op store: agents register walletless and a storm is recorded but not paid. */
const DISABLED_WALLET_STORE: WalletStore = {
  enabled: false,
  generate: () => null,
  decrypt() {
    throw new Error('wallet store disabled — WALLET_ENCRYPTION_KEY is not set');
  },
};

export function createWalletStore(encryptionKey: string | null): WalletStore {
  if (!encryptionKey) return DISABLED_WALLET_STORE;

  // Derive a 32-byte AES key from the configured secret. The secret is the
  // entropy; the fixed salt only domain-separates this use from any other.
  const aesKey = scryptSync(encryptionKey, 'damnits.agent-wallet.v1', 32);

  const encrypt = (plaintext: string): string => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
  };

  return {
    enabled: true,
    generate() {
      const privateKey = generatePrivateKey();
      const address = privateKeyToAccount(privateKey).address;
      return { address, encPrivateKey: encrypt(privateKey) };
    },
    decrypt(encPrivateKey) {
      const [ivHex, tagHex, dataHex] = encPrivateKey.split(':');
      if (!ivHex || !tagHex || !dataHex) throw new Error('malformed encrypted key');
      const decipher = createDecipheriv('aes-256-gcm', aesKey, Buffer.from(ivHex, 'hex'));
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
      const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
      return dec.toString('utf8') as `0x${string}`;
    },
  };
}
