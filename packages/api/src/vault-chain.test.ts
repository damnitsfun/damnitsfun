import { loadConfig } from './config';
import { createVaultChain, DISABLED_VAULT_CHAIN, DAMNITS_VAULT_ABI } from './vault-chain';

/**
 * The degradation path (T134, DoD 9). A deployment with no vault must still run
 * the whole game — so every call has to answer, never throw, and reads have to
 * return null rather than blowing up an onboarding request.
 */
describe('vault chain client', () => {
  it('is disabled without an operator key or a vault address', () => {
    const noKey = createVaultChain(loadConfig({ env: { VAULT_CONTRACT_ADDRESS: '0xvault' } }));
    expect(noKey.enabled).toBe(false);
    expect(noKey.contractAddress).toBeNull();

    const noAddress = createVaultChain(loadConfig({ env: { OPERATOR_PRIVATE_KEY: '0xabc' } }));
    expect(noAddress.enabled).toBe(false);
  });

  it('answers every write with a clean failure instead of throwing', async () => {
    const v = DISABLED_VAULT_CHAIN;
    const results = await Promise.all([
      v.openSeason('comp_x', '1000', 1, 2, null),
      v.seedPot('comp_x', '1000'),
      v.closeRegistration('comp_x'),
      v.resolve('comp_x', [], [], '0x00'),
      v.exitStale('comp_x'),
      v.verifyDeposit('comp_x', '0xtx', '1000'),
    ]);
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/disabled/);
    }
  });

  it('returns null from reads rather than a thrown error', async () => {
    await expect(DISABLED_VAULT_CHAIN.readSeason('comp_x')).resolves.toBeNull();
    await expect(DISABLED_VAULT_CHAIN.readOwed('0xabc')).resolves.toBeNull();
  });

  /**
   * The deposit check is what stops any txHash buying a seat, so the event it
   * reads has to stay in the ABI with exactly these fields (D190).
   */
  it('carries the Deposited event the seat check reads', () => {
    const deposited = DAMNITS_VAULT_ABI.find(
      (e) => e.type === 'event' && e.name === 'Deposited',
    ) as { inputs: ReadonlyArray<{ name: string; type: string }> } | undefined;
    expect(deposited).toBeDefined();
    expect(deposited?.inputs.map((i) => i.name)).toEqual(['seasonId', 'player', 'amount']);
  });

  /** The public exit takes no proof and no operator argument — anyone can call it. */
  it('exposes exitStale as a one-argument call', () => {
    const exit = DAMNITS_VAULT_ABI.find(
      (e) => e.type === 'function' && e.name === 'exitStale',
    ) as { inputs: ReadonlyArray<unknown> } | undefined;
    expect(exit?.inputs).toHaveLength(1);
  });
});
