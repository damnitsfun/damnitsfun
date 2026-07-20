/**
 * T18 — end-to-end demo harness (sub-spec 07).
 *
 * Runs the whole Demo Day path in one command, with no manual intervention:
 *
 *   1. provision four demo wallets and top them up from the operator
 *   2. register four agents and take their seats
 *   3. each pays a REAL entry fee into the escrow from its own wallet
 *   4. the arena verifies each payment on-chain before seating
 *   5. a seed is committed on-chain before the deal
 *   6. four independent agent processes play the table out
 *   7. the escrow pays the winner; seed + result hash are revealed on-chain
 *   8. every transaction link is captured for the pitch
 *
 * On wallets: agents never hold keys. Entry-fee payment is operator tooling
 * (sub-spec 05's note), so this harness pays on each agent's behalf from a
 * throwaway demo wallet and hands the arena only a txHash — which the arena then
 * verifies against the chain rather than trusting.
 *
 * Usage: yarn workspace api demo -- [--base http://localhost:8080] [--fee 500000000000000]
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Hash,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import { DAMNITS_ESCROW_ABI, sessionIdToBytes32 } from './chain';
import { loadConfig, type Config } from './config';
import { openDatabase } from './db/index';
import { Orchestrator } from './orchestrator';

const AGENT_NAMES = ['ada', 'bishop', 'clarke', 'dijkstra'];
const WALLET_FILE = join(__dirname, '..', '..', '..', '.demo-wallets.json');

const log = (m: string) => process.stdout.write(`${m}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scan = (kind: 'tx' | 'address', v: string) => `https://testnet.bscscan.com/${kind}/${v}`;

interface DemoWallet {
  name: string;
  privateKey: `0x${string}`;
  address: string;
}

/** Reuse wallets across runs so repeated rehearsals don't re-fund from scratch. */
function loadOrCreateWallets(): DemoWallet[] {
  if (existsSync(WALLET_FILE)) {
    return JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as DemoWallet[];
  }
  const wallets = AGENT_NAMES.map((name) => {
    const privateKey = generatePrivateKey();
    return { name, privateKey, address: privateKeyToAccount(privateKey).address };
  });
  writeFileSync(WALLET_FILE, JSON.stringify(wallets, null, 2));
  log(`Created 4 throwaway demo wallets -> ${WALLET_FILE} (gitignored)`);
  return wallets;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (flag: string, fallback: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
  };
  const baseUrl = arg('--base', 'http://127.0.0.1:8080').replace(/\/$/, '');
  const entryFeeWei = arg('--fee', '500000000000000'); // 0.0005 tBNB

  const config: Config = loadConfig();
  if (!config.operatorPrivateKey || !config.escrowContractAddress) {
    throw new Error('Set OPERATOR_PRIVATE_KEY and ESCROW_CONTRACT_ADDRESS in .env first.');
  }

  const transport = http(config.bscTestnetRpcUrl);
  const publicClient = createPublicClient({ chain: bscTestnet, transport });
  const operatorKey = (
    config.operatorPrivateKey.startsWith('0x')
      ? config.operatorPrivateKey
      : `0x${config.operatorPrivateKey}`
  ) as `0x${string}`;
  const operator = privateKeyToAccount(operatorKey);
  const operatorWallet = createWalletClient({ account: operator, chain: bscTestnet, transport });

  log('════════════════════════════════════════════════════════════');
  log('  damnits.fun — end-to-end demo (T18)');
  log('════════════════════════════════════════════════════════════');
  log(`escrow   : ${config.escrowContractAddress}`);
  log(`operator : ${operator.address}`);
  log(`entry fee: ${formatEther(BigInt(entryFeeWei))} tBNB each`);
  log('');

  // ---- 1. wallets ---------------------------------------------------------
  const wallets = loadOrCreateWallets();
  const needed = BigInt(entryFeeWei) + parseEther('0.0004'); // fee + gas headroom
  log('── funding demo wallets ────────────────────────────────────');
  for (const w of wallets) {
    const balance = await publicClient.getBalance({ address: w.address as `0x${string}` });
    if (balance >= needed) {
      log(`  ${w.name.padEnd(9)} ${formatEther(balance)} tBNB (already funded)`);
      continue;
    }
    const topUp = needed - balance;
    const hash = await operatorWallet.sendTransaction({
      to: w.address as `0x${string}`,
      value: topUp,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    log(`  ${w.name.padEnd(9)} +${formatEther(topUp)} tBNB  ${hash}`);
  }

  // ---- 2. competition -----------------------------------------------------
  const db = openDatabase(config.databasePath);
  const orchestrator = new Orchestrator(db, config);
  let competition = orchestrator
    .listActiveCompetitions()
    .find((c) => c.entryFeeWei === entryFeeWei);
  if (!competition) {
    const id = orchestrator.createCompetition(
      `Demo Day — ${formatEther(BigInt(entryFeeWei))} tBNB`,
      entryFeeWei,
      config.escrowContractAddress,
    );
    competition = orchestrator.listActiveCompetitions().find((c) => c.id === id)!;
    log(`\ncreated competition ${competition.id} (entry fee ${entryFeeWei} wei)`);
  } else {
    log(`\nusing competition ${competition.id}`);
  }
  db.close();

  // ---- 3. register, pay, seat --------------------------------------------
  log('\n── seating agents (each pays a real entry fee) ─────────────');
  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${baseUrl}/api/arena${path}`, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body } as { status: number; body: any };
  };

  const entryFeeTxs: Array<{ name: string; hash: string }> = [];
  const agents: Array<{ name: string; apiKey: string; agentId: string }> = [];
  let sessionId = '';

  for (const w of wallets) {
    const reg = await api('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: w.name }),
    });
    const { agentId, apiKey } = reg.body;
    const headers = { 'content-type': 'application/json', 'x-arena-api-key': apiKey };

    // First join -> 402, telling us which table to pay into.
    const quoted = await api('/session/join', {
      method: 'POST',
      headers,
      body: JSON.stringify({ competitionId: competition.id }),
    });
    if (quoted.status !== 402) {
      throw new Error(`expected 402 for a paid table, got ${quoted.status}: ${JSON.stringify(quoted.body)}`);
    }
    const { sessionId: table, amountWei, contractAddress } = quoted.body.paymentRequired;
    sessionId = table;

    // Pay from the agent's own wallet — real value moving on-chain.
    const wallet = createWalletClient({
      account: privateKeyToAccount(w.privateKey),
      chain: bscTestnet,
      transport,
    });
    const payHash: Hash = await wallet.writeContract({
      address: contractAddress as `0x${string}`,
      abi: DAMNITS_ESCROW_ABI,
      functionName: 'payEntryFee',
      args: [sessionIdToBytes32(table)],
      value: BigInt(amountWei),
    });
    await publicClient.waitForTransactionReceipt({ hash: payHash });
    entryFeeTxs.push({ name: w.name, hash: payHash });

    // Retry the join with the txHash; the arena verifies it against the chain.
    const seated = await api('/session/join', {
      method: 'POST',
      headers,
      body: JSON.stringify({ competitionId: competition.id, txHash: payHash }),
    });
    if (seated.status !== 200) {
      throw new Error(`join after payment failed (${seated.status}): ${JSON.stringify(seated.body)}`);
    }
    log(`  ${w.name.padEnd(9)} paid ${formatEther(BigInt(amountWei))} tBNB  ${payHash}`);
    agents.push({ name: w.name, apiKey, agentId });
  }

  const potBefore = await publicClient.readContract({
    address: config.escrowContractAddress as `0x${string}`,
    abi: DAMNITS_ESCROW_ABI,
    functionName: 'getSession',
    args: [sessionIdToBytes32(sessionId)],
  });
  log(`\nescrow now holds ${formatEther((potBefore as any)[2] as bigint)} tBNB for ${sessionId}`);

  // ---- 4. play ------------------------------------------------------------
  log('\n── four independent agent processes playing ────────────────');
  const agentEntry = join(__dirname, '..', '..', 'reference-agent', 'dist', 'agent.js');
  await Promise.all(
    agents.map(
      (a) =>
        new Promise<void>((resolve) => {
          const child = spawn(
            process.execPath,
            [agentEntry, '--base', baseUrl, '--name', a.name, '--api-key', a.apiKey, '--tables', '1'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
          );
          child.stdout.on('data', (d: Buffer) =>
            String(d).trim().split('\n').forEach((line) => log(`  ${line}`)),
          );
          child.on('close', () => resolve());
        }),
    ),
  );

  // ---- 5. settle + capture -------------------------------------------------
  log('\n── waiting for on-chain settlement ─────────────────────────');
  let record: any = null;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${baseUrl}/api/arena/spectate/session/${sessionId}`);
    record = await res.json();
    if (record.status === 'settled' && record.settleTxHash) break;
    await sleep(1500);
  }

  const winner = agents.find((a) => a.agentId === record.winnerAgentId);
  const winnerWallet = wallets.find((w) => w.name === winner?.name);
  const winnerBalance = winnerWallet
    ? await publicClient.getBalance({ address: winnerWallet.address as `0x${string}` })
    : 0n;

  log('');
  log('════════════════════════════════════════════════════════════');
  log('  DEMO COMPLETE — verifiable on BscScan');
  log('════════════════════════════════════════════════════════════');
  log(`table       : ${sessionId}`);
  log(`winner      : ${winner?.name ?? '(unknown)'} (${record.winnerAgentId})`);
  log(`prize       : ${formatEther((potBefore as any)[2] as bigint)} tBNB`);
  if (winnerWallet) log(`winner now holds ${formatEther(winnerBalance)} tBNB`);
  log('');
  log('escrow contract');
  log(`  ${scan('address', config.escrowContractAddress)}`);
  log('entry fees (real value in)');
  for (const t of entryFeeTxs) log(`  ${t.name.padEnd(9)} ${scan('tx', t.hash)}`);
  log('seed committed before the deal');
  log(`  ${record.commitTxHash ? scan('tx', record.commitTxHash) : '(none)'}`);
  log('settlement: winner paid, seed + result revealed');
  log(`  ${record.settleTxHash ? scan('tx', record.settleTxHash) : '(none)'}`);
  log('');
  log(`spectator replay : ${baseUrl}/  (table "${sessionId}")`);
  log(`seed reveal      : ${record.seedReveal}`);
  log(`result hash      : ${record.resultHash}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`\nDEMO FAILED: ${String(error)}\n`);
  process.exit(1);
});
