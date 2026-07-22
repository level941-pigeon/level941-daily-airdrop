// The live observatory's data source. Runs server-side only, holds the
// Helius-backed RPC connection (same cfg.connection every other script
// uses), and writes docs/live-state.json for the dashboard page to fetch
// by relative path. Never writes cfg.connection.rpcEndpoint or any secret
// fragment of it anywhere -- assertNoSecrets refuses the write if it ever
// finds one.
//
// Read-only with respect to the sweep pipeline: this observes
// sweep-state.json and current wallet token balances, but never calls
// screenMint or quoteValueUsd itself. Those are the daily sweep's job,
// not something to fire every poll tick.
//
// Two cadences, on purpose: local writes are cheap and can be frequent
// (DASHBOARD_LOCAL_POLL_MS). Publishing to git is throttled separately
// (DASHBOARD_PUBLISH_INTERVAL_MS) so the public page stays reasonably
// fresh without a commit every few seconds.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { AppConfig, loadConfig, sleep, todayStr } from './config.js';
import { getSenderBalanceRaw, sumDistributed } from './airdrop.js';
import { getTokenContext, readCsv } from './holders.js';
import { listWalletTokens, loadState, WalletToken } from './sweep.js';
import { decideLane } from './screen.js';
import { computeDailyAirdrop, nextNineFortyOne, rawToHuman } from './math.js';

export interface LiveEvent {
  ts: string;
  kind: 'test' | 'daily' | 'sweep' | 'bridge' | 'draw' | 'loyalty' | 'founder';
  label: string;
  amountTokens: string;
  wallet: string; // truncated 4...4
  solscanUrl: string;
}

export type ForeignTokenStatus =
  | 'cooling'
  | 'pending-value' // past cooling, no quote yet or below the realizable-value floor
  | 'ready'
  | 'fastlane'
  | 'quarantined'
  | 'denied'
  | 'pending-screen'; // arrived since the last pipeline run, not yet screened

export interface ForeignToken {
  mint: string;
  amountTokens: string;
  valueUsd: number | null;
  status: ForeignTokenStatus;
  reason: string;
  coolingSecondsRemaining: number | null;
  solscanUrl: string;
}

export interface LiveState {
  generatedAt: string;
  rulesetId: string;
  recentEvents: LiveEvent[];
  foreignTokens: ForeignToken[];
  holderCount: number;
  solBalance: number;
  pigeonBalanceTokens: string;
  allTimeDistributedTokens: string;
  curveHeadroomTokens: string;
  next941: string;
}

function truncateWallet(w: string): string {
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

function mintLabel(cfg: AppConfig, mint: string | undefined): string {
  const main = cfg.mint.toBase58();
  if (!mint || mint === main) return 'pigeon';
  if (mint === 'SOL') return 'SOL';
  return truncateWallet(mint);
}

// Last `days` calendar days of sent-log files, newest confirmed entries first.
function recentEvents(cfg: AppConfig, days: number, limit: number): LiveEvent[] {
  if (!fs.existsSync(cfg.dirs.logs)) return [];
  const files = fs
    .readdirSync(cfg.dirs.logs)
    .filter((f) => f.endsWith('-sent-log.json'))
    .sort()
    .slice(-days);

  type RawEntry = {
    ts?: string;
    type?: string;
    status?: string;
    wallet?: string;
    amount?: string;
    mint?: string;
    signature?: string;
  };
  const events: LiveEvent[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(cfg.dirs.logs, f), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e: RawEntry;
      try {
        e = JSON.parse(line) as RawEntry;
      } catch {
        continue;
      }
      if (e.status !== 'confirmed' || !e.signature || !e.wallet || !e.ts) continue;
      events.push({
        ts: e.ts,
        kind: (e.type as LiveEvent['kind']) ?? 'daily',
        label: `${e.amount ?? '0'} ${mintLabel(cfg, e.mint)} → ${truncateWallet(e.wallet)}`,
        amountTokens: e.amount ?? '0',
        wallet: truncateWallet(e.wallet),
        solscanUrl: `https://solscan.io/tx/${e.signature}`,
      });
    }
  }
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return events.slice(0, limit);
}

// Status comes from the pipeline's OWN decideLane (screen.ts), not a
// reimplementation, so "ready" here means the exact same thing it means
// to the real sweep run: past cooling AND a realizable quote AND above
// the value floor. A null or below-floor quote stays "pending-value",
// never "ready".
async function foreignTokens(cfg: AppConfig): Promise<ForeignToken[]> {
  const mainMint = cfg.mint.toBase58();
  const tokens: WalletToken[] = (await listWalletTokens(cfg)).filter((t) => t.mint !== mainMint);
  const state = loadState(cfg);
  const nowSec = Math.floor(Date.now() / 1000);

  return tokens.map((t) => {
    const rec = state[t.mint];
    const solscanUrl = `https://solscan.io/token/${t.mint}`;
    const amountTokens = rawToHuman(t.amountRaw, t.decimals);

    if (!rec) {
      return {
        mint: t.mint,
        amountTokens,
        valueUsd: null,
        status: 'pending-screen',
        reason: 'arrived since the last pipeline run, not yet screened',
        coolingSecondsRemaining: null,
        solscanUrl,
      };
    }

    const fastlane = cfg.allowedDropMints.has(t.mint);
    const { lane, reason } = decideLane({
      denied: rec.denied,
      fastlane,
      screenOk: rec.screenOk,
      screenReasons: rec.screenReasons,
      firstSeen: rec.firstSeen,
      nowSec,
      delayHours: cfg.sweepDelayHours,
      valueUsd: rec.lastValueUsd,
      minUsd: cfg.sweepMinUsd,
    });

    const remaining = rec.firstSeen + cfg.sweepDelayHours * 3600 - nowSec;
    const stillCooling = remaining > 0;
    const status: ForeignTokenStatus =
      lane === 'sweep' ? 'ready' :
      lane === 'fastlane' ? 'fastlane' :
      lane === 'denied' ? 'denied' :
      lane === 'quarantined' ? 'quarantined' :
      stillCooling ? 'cooling' : 'pending-value';

    return {
      mint: t.mint,
      amountTokens,
      valueUsd: rec.lastValueUsd,
      status,
      reason,
      coolingSecondsRemaining: status === 'cooling' || status === 'pending-value' ? Math.max(0, remaining) : 0,
      solscanUrl,
    };
  });
}

function latestQualifyingCount(cfg: AppConfig): number {
  if (!fs.existsSync(cfg.dirs.snapshots)) return 0;
  const dates = fs
    .readdirSync(cfg.dirs.snapshots)
    .filter((f) => f.endsWith('-qualifying-holders.csv'))
    .map((f) => f.replace('-qualifying-holders.csv', ''))
    .sort();
  if (dates.length === 0) return 0;
  const latest = dates[dates.length - 1]!;
  return readCsv(path.join(cfg.dirs.snapshots, `${latest}-qualifying-holders.csv`)).filter((r) => r.wallet).length;
}

export async function gatherLiveState(cfg: AppConfig): Promise<LiveState> {
  const date = todayStr();
  const ctx = await getTokenContext(cfg);
  const [pigeonBalanceRaw, solLamports, foreign] = await Promise.all([
    getSenderBalanceRaw(cfg, ctx),
    cfg.connection.getBalance(cfg.keypair.publicKey),
    foreignTokens(cfg),
  ]);

  const holderCount = latestQualifyingCount(cfg);
  const totalDistributedRaw = sumDistributed(cfg);
  let reserveRaw = 0n;
  try {
    const { bridgeReserveRaw } = await import('./bridge.js');
    reserveRaw = bridgeReserveRaw(cfg, date, ctx.decimals);
  } catch {
    /* bridge module optional at runtime; headroom still meaningful without it */
  }

  const r = computeDailyAirdrop({
    totalSupplyRaw: ctx.supplyRaw,
    qualifyingHolderCount: holderCount,
    holderGoal: cfg.holderGoal,
    totalDistributedRaw: totalDistributedRaw + reserveRaw,
    senderBalanceRaw: pigeonBalanceRaw,
    scheduledDailyDripRaw: 0n, // headroom (availableTodayRaw) does not depend on the drip amount
    retainedSupplyPercent: cfg.retainedSupplyPercent,
    maxAirdropPoolPercent: cfg.maxAirdropPoolPercent,
  });

  return {
    generatedAt: new Date().toISOString(),
    rulesetId: cfg.rulesetId,
    recentEvents: recentEvents(cfg, 4, 40),
    foreignTokens: foreign,
    holderCount,
    solBalance: solLamports / 1_000_000_000,
    pigeonBalanceTokens: rawToHuman(pigeonBalanceRaw, ctx.decimals),
    allTimeDistributedTokens: rawToHuman(totalDistributedRaw, ctx.decimals),
    curveHeadroomTokens: rawToHuman(r.availableTodayRaw, ctx.decimals),
    next941: nextNineFortyOne().toISOString(),
  };
}

// Hard safety guard: refuses to write if the serialized output contains the
// RPC URL or its api-key fragment. Pure and unit-tested (test/run.ts) so
// this is a provable guarantee, not just a promise in a comment.
export function assertNoSecrets(json: string, rpcUrl: string): void {
  const fragments = [rpcUrl];
  try {
    const key = new URL(rpcUrl).searchParams.get('api-key');
    if (key) fragments.push(key);
  } catch {
    /* rpcUrl not a URL, nothing to extract */
  }
  for (const frag of fragments) {
    if (frag && frag.length > 8 && json.includes(frag)) {
      throw new Error('SECURITY GUARD: live-state output contains a secret fragment from RPC_URL. Refusing to write.');
    }
  }
}

function liveStatePath(): string {
  return path.join(process.cwd(), 'docs', 'live-state.json');
}

export async function writeLiveState(cfg: AppConfig): Promise<LiveState> {
  const state = await gatherLiveState(cfg);
  const json = JSON.stringify(state, null, 2) + '\n';
  assertNoSecrets(json, cfg.connection.rpcEndpoint);
  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(liveStatePath(), json, 'utf8');
  return state;
}

// execFileSync throws with stdout/stderr Buffers attached on non-zero exit;
// this pulls the text out regardless of which of those actually got written.
function execErrorText(e: unknown): string {
  const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const stderr = err.stderr ? err.stderr.toString() : '';
  const stdout = err.stdout ? err.stdout.toString() : '';
  return (stderr + stdout).trim() || err.message || String(e);
}

// Credential/permission rejections (wrong `gh` account active, expired
// token, no repo access) look nothing like a non-fast-forward rejection at
// the git level -- both just make `git push` exit non-zero. Left
// undistinguished, an auth failure gets treated as "remote moved," and the
// rebase-retry below fails too (for the same auth reason), so the cycle
// logs a divergence message forever while commits pile up unpushed. This
// tells the two apart from the process's stderr/stdout so auth failures are
// reported for what they are instead of stranding commits silently.
function isAuthFailure(text: string): boolean {
  return /(^|\W)(403|401)(\W|$)|permission to .* denied|authentication failed|could not read username|could not read password|invalid username or password|remote: repository not found|fatal: could not read from remote repository/i.test(
    text
  );
}

// Best-effort git commit + push of docs/live-state.json only. Never throws
// out of the poll loop: a publish failure (no repo yet, no remote, offline)
// just means the next cycle tries again.
//
// Self-healing: if the remote has moved (someone edited a file via GitHub's
// UI, another machine pushed) the plain push is rejected. Rather than fail
// silently forever -- which once let 1,200+ dead-end local commits pile up
// unpushed -- this rebases the one tiny commit onto the new remote tip and
// retries once. `git rebase` refuses to run at all if the working tree has
// ANY uncommitted changes (not just in live-state.json), so this can never
// clobber concurrent edits sitting in this same directory: it just fails
// cleanly, gets caught below, and the next cycle tries again.
//
// Auth failures are a different failure mode from divergence (see
// isAuthFailure above) and are reported loudly rather than folded into the
// "remote has diverged" message -- rebasing can never fix a bad credential,
// so this skips the pointless rebase attempt and says what's actually wrong.
export function publishLiveState(): void {
  const opts = { stdio: 'pipe' as const };
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], opts);
  } catch {
    console.log('publish: no git repo here yet, writing locally only.');
    return;
  }
  try {
    execFileSync('git', ['add', 'docs/live-state.json'], opts);
    try {
      execFileSync('git', ['diff', '--cached', '--quiet', '--', 'docs/live-state.json'], opts);
      return; // exit 0 = nothing staged, nothing to publish this cycle
    } catch {
      /* exit 1 = there is a diff, fall through to commit */
    }
    execFileSync('git', ['commit', '-m', `live-state: ${new Date().toISOString()}`], opts);

    let firstPushError: unknown;
    try {
      execFileSync('git', ['push'], opts);
      console.log('publish: live-state.json committed and pushed.');
      return;
    } catch (e) {
      firstPushError = e; // rejected -- could be non-fast-forward, could be auth
    }

    const firstPushText = execErrorText(firstPushError);
    if (isAuthFailure(firstPushText)) {
      console.log(
        `publish: AUTH FAILURE pushing to origin, not a divergence -- commit is saved locally but not published. Check credentials (e.g. "gh auth status"). ${firstPushText.slice(0, 300)}`
      );
      return;
    }

    try {
      execFileSync('git', ['fetch', 'origin'], opts);
      execFileSync('git', ['rebase', 'origin/main'], opts);
      execFileSync('git', ['push'], opts);
      console.log('publish: remote had moved, rebased onto it and pushed.');
    } catch (e) {
      try {
        execFileSync('git', ['rebase', '--abort'], opts);
      } catch {
        /* nothing to abort */
      }
      const text = execErrorText(e);
      if (isAuthFailure(text)) {
        console.log(
          `publish: AUTH FAILURE pushing to origin, not a divergence -- commit is saved locally but not published. Check credentials (e.g. "gh auth status"). ${text.slice(0, 300)}`
        );
      } else {
        console.log('publish: remote has diverged and could not be auto-rebased. Skipping this cycle.');
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`publish: skipped (${msg.slice(0, 160)})`);
  }
}

export async function runPoller(cfg: AppConfig): Promise<never> {
  console.log(`Live poller starting. Local write every ${cfg.dashboardLocalPollMs}ms, publish every ${cfg.dashboardPublishIntervalMs}ms.`);
  let lastPublish = 0;
  for (;;) {
    try {
      const state = await writeLiveState(cfg);
      console.log(
        `[${state.generatedAt}] ${state.holderCount} holders, ${state.recentEvents.length} recent events, ${state.foreignTokens.length} foreign tokens in the box.`
      );
    } catch (e) {
      console.log(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const now = Date.now();
    if (now - lastPublish >= cfg.dashboardPublishIntervalMs) {
      publishLiveState();
      lastPublish = now;
    }
    await sleep(cfg.dashboardLocalPollMs);
  }
}

const isDirectRun = process.argv[1]?.endsWith('poller.ts');
if (isDirectRun) {
  const cfg = loadConfig();
  if (process.argv[2] === 'once') {
    writeLiveState(cfg)
      .then((state) => {
        console.log(`Wrote ${liveStatePath()}`);
        console.log(`${state.holderCount} holders, ${state.recentEvents.length} recent events, ${state.foreignTokens.length} foreign tokens.`);
        process.exit(0);
      })
      .catch((e) => {
        console.error('Error:', e instanceof Error ? e.message : e);
        process.exit(1);
      });
  } else {
    runPoller(cfg).catch((e) => {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
  }
}
