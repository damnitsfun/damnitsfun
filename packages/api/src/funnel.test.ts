import { loadConfig } from './config';
import { openDatabase } from './db/index';
import { formatFunnel, onboardingFunnel } from './funnel';
import { Orchestrator } from './orchestrator';

/**
 * Reconstructs the production incident: three agents given identical
 * instructions, two of which played and one of which registered and vanished.
 */
describe('onboarding funnel', () => {
  const boot = (): { db: ReturnType<typeof openDatabase>; o: Orchestrator; comp: string } => {
    const config = loadConfig({
      env: { TABLE_MIN_SIZE: '2', TABLE_MAX_SIZE: '2', DECISION_TIMEOUT_MS: '999999999' },
    });
    const db = openDatabase(':memory:');
    const o = new Orchestrator(db, config);
    return { db, o, comp: o.createCompetition('Funnel') };
  };

  it('separates registered-but-never-seated from everyone else', async () => {
    const { db, o, comp } = boot();
    const played1 = o.registerAgent('kestrel');
    const played2 = o.registerAgent('atlas');
    o.registerAgent('nova'); // registers and never joins — the real case

    await o.joinSession(played1.agentId, comp);
    await o.joinSession(played2.agentId, comp); // fills the 2-seat table, deals

    const f = onboardingFunnel(db);
    expect(f.registered).toBe(3);
    expect(f.everSeated).toBe(2);
    expect(f.stalledAfterRegister.map((a) => a.displayName)).toEqual(['nova']);
  });

  it('reports how long a stalled agent has been idle', () => {
    const { db, o } = boot();
    o.registerAgent('nova');
    // created_at is SQL UTC; pretend it is 45 minutes later.
    const f = onboardingFunnel(db, Date.now() + 45 * 60_000);
    expect(f.stalledAfterRegister).toHaveLength(1);
    expect(f.stalledAfterRegister[0]!.idleMinutes).toBeGreaterThanOrEqual(44);
  });

  it('distinguishes seated-but-never-finished from never-seated', async () => {
    const { db, o, comp } = boot();
    const a = o.registerAgent('waiting');
    await o.joinSession(a.agentId, comp); // seated, but the table never fills

    const f = onboardingFunnel(db);
    expect(f.stalledAfterRegister).toHaveLength(0); // it DID take a seat
    expect(f.stalledAfterSeating.map((x) => x.displayName)).toEqual(['waiting']);
  });

  it('says nothing alarming when every agent played', async () => {
    const { db, o, comp } = boot();
    const a = o.registerAgent('a');
    const b = o.registerAgent('b');
    await o.joinSession(a.agentId, comp);
    await o.joinSession(b.agentId, comp);

    const f = onboardingFunnel(db);
    expect(f.stalledAfterRegister).toEqual([]);
    expect(formatFunnel(f)).not.toContain('NEVER took a seat');
  });

  it('names the stalled agents in the report, not just a count', () => {
    const { db, o } = boot();
    o.registerAgent('nova');
    const text = formatFunnel(onboardingFunnel(db));
    expect(text).toContain('nova');
    expect(text).toContain('registered but NEVER took a seat');
    // The report must point at the agent side rather than imply a server fault.
    expect(text).toContain('No server error explains');
  });
});
