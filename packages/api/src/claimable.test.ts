import { payoutContracts, sumOwed } from './chain';
import type { Config } from './config';

/**
 * The profile page's "prize ready" badge (sub-spec 28).
 *
 * It read `owed[address]` off `DamnitsTournament` only, so a settled STAKED
 * season — which credits prizes and refunds in `DamnitsVault` — showed an owner
 * nothing waiting while a settled FEE season showed a claim button. The money was
 * credited either way. These pin the two decisions that fixed it: which contracts
 * get asked, and what their answers add up to.
 */

const cfg = (over: Partial<Config> = {}) =>
  ({ tournamentContractAddress: null, vaultContractAddress: null, ...over }) as Config;

describe('payoutContracts', () => {
  it('asks BOTH payout contracts — the vault is where a staked season pays', () => {
    expect(payoutContracts(cfg({ tournamentContractAddress: '0xT', vaultContractAddress: '0xV' })))
      .toEqual(['0xT', '0xV']);
  });

  it('skips one that is not deployed, rather than reading a null address', () => {
    expect(payoutContracts(cfg({ vaultContractAddress: '0xV' }))).toEqual(['0xV']);
    expect(payoutContracts(cfg({ tournamentContractAddress: '0xT' }))).toEqual(['0xT']);
  });

  it('is empty on a chainless box', () => {
    expect(payoutContracts(cfg())).toEqual([]);
  });
});

describe('sumOwed', () => {
  it('adds what both contracts owe — the bug was showing only one of them', () => {
    expect(sumOwed([10n, 32n])).toBe('42');
  });

  it('surfaces a staked-only prize the old single-contract read hid', () => {
    expect(sumOwed([0n, 200000000000000000n])).toBe('200000000000000000');
  });

  it('reports a measured zero as zero, so no badge is shown', () => {
    expect(sumOwed([0n, 0n])).toBe('0');
  });

  it('is null when every read failed — unknown is not zero', () => {
    expect(sumOwed([null, null])).toBeNull();
    expect(sumOwed([])).toBeNull();
  });

  it('counts what answered when the other read failed, rather than voiding the total', () => {
    // An understated prize still gets the owner to a claim button; a null would
    // hide money that is really there because one RPC was slow.
    expect(sumOwed([null, 5n])).toBe('5');
  });
});
