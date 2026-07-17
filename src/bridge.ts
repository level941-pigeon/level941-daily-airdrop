// The OG bridge. Wallets from the frozen pre-launch replay who buy the
// 10k minimum in the SAME wallet get, on their second consecutive
// qualifying morning: the pigeon constant (5,313) one time, and a streak
// import of their actual OG days held, capped at 94.
//
// Accounting rule that keeps the published equation exact: the moment an
// eligible OG first qualifies, their 5,313 unlock is RESERVED. The daily
// drip skips it, the bridge pays it to them on day two. One unlock, one
// recipient, never double-spent.
//
// Locked-positions lane: wallets in data/og/locked-positions.csv are
// eligible unconditionally and import the full 94. Locks are the deepest
// holds on the list. The file is manual, verified, and public.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, todayStr } from './config.js';
import { readCsv } from './holders.js';
import { fmt, humanToRaw, rawToHuman } from './math.js';

export interface BridgeEligible {
  wallet: string;
  importDays: number; // streak the wallet enters with, capped 94
  locked: boolean;
}

function ogTablePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'og', 'og-all-snapshot.csv');
}

function lockedLanePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'og', 'locked-positions.csv');
}

// The full eligibility map. Null when the replay table does not exist yet,
// which keeps the bridge inert until the table is on disk.
export function loadEligible(cfg: AppConfig): Map<string, BridgeEligible> | null {
  const tablePath = ogTablePath(cfg);
  if (!fs.existsSync(tablePath)) return null;

  const out = new Map<string, BridgeEligible>();
  for (const r of readCsv(tablePath)) {
    if (!r.wallet) continue;
    const days = Number.parseInt(r.days_held_to_snapshot ?? '0', 10) || 0;
    if (days < cfg.bridgeMinOgDays) continue;
    out.set(r.wallet, {
      wallet: r.wallet,
      importDays: Math.min(days, cfg.streakCap),
      locked: false,
    });
  }

  // Verified locks override everything: unconditional eligibility, full cap.
  const lockPath = lockedLanePath(cfg);
  if (fs.existsSync(lockPath)) {
    for (const r of readCsv(lockPath)) {
      if (!r.wallet) continue;
      out.set(r.wallet, { wallet: r.wallet, importDays: cfg.streakCap, locked: true });
    }
  }
  return out;
}

export function bridgeWindowOpen(cfg: AppConfig, date: string): boolean {
  if (!cfg.bridgeOpenDate || !cfg.bridgeCloseDate) return false;
  return date >= cfg.bridgeOpenDate && date <= cfg.bridgeCloseDate;
}

function qualifyingWallets(cfg: AppConfig, date: string): Set<string> | null {
  const f = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(f)) return null;
  return new Set(readCsv(f).map((r) => r.wallet as string).filter(Boolean));
}

// First-qualified-inside-the-window state. "Second qualifying morning"
// means a later date than the recorded first sighting INSIDE the window.
// Without this, a wallet qualifying before the doors opened was payable
// on opening day, and stale snapshots faked consecutiveness. Audit finding.
interface BridgeState {
  [wallet: string]: { firstQualifiedInWindow: string };
}

function bridgeStatePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'og', 'bridge-state.json');
}

export function loadBridgeState(cfg: AppConfig): BridgeState {
  const p = bridgeStatePath(cfg);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8')) as BridgeState;
  } catch {
    return {};
  }
}

export function saveBridgeState(cfg: AppConfig, s: BridgeState): void {
  fs.mkdirSync(path.dirname(bridgeStatePath(cfg)), { recursive: true });
  fs.writeFileSync(bridgeStatePath(cfg), JSON.stringify(s, null, 2) + '\n', 'utf8');
}

// Records today's first sightings. Returns the updated state.
export function recordSightings(cfg: AppConfig, date: string): BridgeState {
  const state = loadBridgeState(cfg);
  if (!bridgeWindowOpen(cfg, date)) return state;
  const pending = pendingBridgeWallets(cfg, date);
  let changed = false;
  for (const e of pending) {
    if (!state[e.wallet]) {
      state[e.wallet] = { firstQualifiedInWindow: date };
      changed = true;
    }
  }
  if (changed) saveBridgeState(cfg, state);
  return state;
}

// Every wallet ever paid a bridge bonus, from the append-only ledger.
export function bridgePaidSet(cfg: AppConfig): Set<string> {
  const paid = new Set<string>();
  if (!fs.existsSync(cfg.dirs.logs)) return paid;
  for (const f of fs.readdirSync(cfg.dirs.logs)) {
    if (!f.endsWith('-sent-log.json')) continue;
    for (const line of fs.readFileSync(path.join(cfg.dirs.logs, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; wallet?: string; status?: string };
        if (e.type === 'bridge' && e.status === 'confirmed' && e.wallet) paid.add(e.wallet);
      } catch {
        // skip bad line
      }
    }
  }
  return paid;
}

// Eligible, qualifying today, not yet paid. These wallets' unlocks are
// reserved out of the daily pool so the drip cannot spend them first.
export function pendingBridgeWallets(cfg: AppConfig, date: string): BridgeEligible[] {
  if (!bridgeWindowOpen(cfg, date)) return [];
  const eligible = loadEligible(cfg);
  if (!eligible) return [];
  const today = qualifyingWallets(cfg, date);
  if (!today) return [];
  const paid = bridgePaidSet(cfg);
  const out: BridgeEligible[] = [];
  for (const [wallet, e] of eligible) {
    if (today.has(wallet) && !paid.has(wallet)) out.push(e);
  }
  return out;
}

// The reserve the preview subtracts from the daily pool.
export function bridgeReserveRaw(cfg: AppConfig, date: string, decimals: number): bigint {
  const pending = pendingBridgeWallets(cfg, date);
  if (pending.length === 0) return 0n;
  return BigInt(pending.length) * humanToRaw(String(cfg.bridgeBonusTokens), decimals);
}

// Pending AND first sighted inside the window on an EARLIER date: the
// day-two rule, enforced from stored state, not from whichever prior
// snapshot happens to exist.
export function payableToday(cfg: AppConfig, date: string): BridgeEligible[] {
  const pending = pendingBridgeWallets(cfg, date);
  if (pending.length === 0) return [];
  const state = recordSightings(cfg, date);
  return pending.filter((e) => {
    const first = state[e.wallet]?.firstQualifiedInWindow;
    return Boolean(first && first < date);
  });
}

// Payment-time authority gate. The equation outranks the calendar: bridge
// pays only inside banked curve headroom, oldest sightings first. An OG
// who was already a holder minted no new headroom and waits for growth.
// Audit finding: preview-side reservation alone did not bound payment.
export async function bridgeHeadroom(cfg: AppConfig, date: string): Promise<bigint> {
  const { getTokenContext } = await import('./holders.js');
  const { sumDistributed } = await import('./airdrop.js');
  const ctx = await getTokenContext(cfg);
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) return 0n;
  const holders = readCsv(qualFile).filter((r) => r.wallet).length;
  const maxPool = (ctx.supplyRaw * BigInt(cfg.maxAirdropPoolPercent)) / 100n;
  const unlocked = (maxPool * BigInt(Math.min(holders, cfg.holderGoal))) / BigInt(cfg.holderGoal);
  const distributed = sumDistributed(cfg);
  return unlocked > distributed ? unlocked - distributed : 0n;
}

// Pays the bonuses and imports the streaks. Runs inside the daily auto
// pipeline. Streaks seed only for wallets with a confirmed send today.
export async function runBridgeAuto(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  if (!bridgeWindowOpen(cfg, date)) return;

  let payable = payableToday(cfg, date);
  if (payable.length === 0) return;

  const { sendBatch, announce, notify } = await import('./airdrop.js');
  const { getTokenContext, loadStreaks, saveStreaks } = await import('./holders.js');

  const ctx = await getTokenContext(cfg);
  const bonusRaw = humanToRaw(String(cfg.bridgeBonusTokens), ctx.decimals);

  // Gate at payment time. Pay oldest sightings first, defer the rest.
  const headroom = await bridgeHeadroom(cfg, date);
  const fundable = Number(headroom / bonusRaw);
  if (fundable < payable.length) {
    const state = loadBridgeState(cfg);
    payable = [...payable]
      .sort((a, b) =>
        (state[a.wallet]?.firstQualifiedInWindow ?? '9999').localeCompare(
          state[b.wallet]?.firstQualifiedInWindow ?? '9999'
        )
      )
      .slice(0, Math.max(0, fundable));
    console.log(
      `Bridge headroom funds ${payable.length} of the queue today. The rest wait for growth, oldest first.`
    );
    notify('bridge queue', `headroom funds ${payable.length}, remainder deferred to growth.`);
    if (payable.length === 0) return;
  }
  const allocations = payable.map((e) => ({ wallet: e.wallet, amountRaw: bonusRaw }));

  console.log('');
  console.log(`BRIDGE: ${payable.length} OG wallet(s) on their second qualifying day.`);
  const { sent, failed } = await sendBatch(cfg, ctx, date, allocations, 'bridge');

  // Seed streaks for confirmed payments only, never below a live streak.
  const paidToday = new Set<string>();
  const logFile = path.join(cfg.dirs.logs, `${date}-sent-log.json`);
  if (fs.existsSync(logFile)) {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; wallet?: string; status?: string };
        if (e.type === 'bridge' && e.status === 'confirmed' && e.wallet) paidToday.add(e.wallet);
      } catch {
        // skip
      }
    }
  }
  const streaks = loadStreaks(cfg);
  let seeded = 0;
  for (const e of payable) {
    if (!paidToday.has(e.wallet)) continue;
    const rec = streaks[e.wallet];
    if (rec) {
      if (rec.streak < e.importDays) {
        rec.streak = e.importDays;
        seeded++;
      }
    } else {
      streaks[e.wallet] = {
        streak: e.importDays,
        lastBalanceRaw: '0',
        lastDate: date,
      };
      seeded++;
    }
  }
  saveStreaks(cfg, streaks);

  console.log(`Bridge complete. Paid: ${sent}. Failed: ${failed}. Streaks imported: ${seeded}.`);
  notify('bridge', `${sent} OG wallets paid, ${seeded} streaks imported, ${failed} failed.`);
  await announce(
    'the bridge. OGs came home.',
    `${sent} original pigeon(s) crossed today. ${fmt(String(cfg.bridgeBonusTokens))} each, funded by their own arrival. streaks imported, day for day. the flock remembers its own.`
  );
}

export async function runBridgeStatus(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const eligible = loadEligible(cfg);
  if (!eligible) {
    console.log('Bridge inert: no replay table at data/og/og-all-snapshot.csv yet.');
    return;
  }
  const paid = bridgePaidSet(cfg);
  const pending = pendingBridgeWallets(cfg, date);
  // Read-only: do NOT call payableToday here, it records sightings.
  const state = loadBridgeState(cfg);
  const payableCount = pending.filter((e) => {
    const first = state[e.wallet]?.firstQualifiedInWindow;
    return Boolean(first && first < date);
  }).length;
  const locked = [...eligible.values()].filter((e) => e.locked).length;
  console.log('');
  console.log('Bridge status');
  console.log('--------------------------------------------------');
  console.log(`window                 ${cfg.bridgeOpenDate || 'unset'} to ${cfg.bridgeCloseDate || 'unset'} (${bridgeWindowOpen(cfg, date) ? 'OPEN' : 'closed'})`);
  console.log(`gate                   ${cfg.bridgeMinOgDays}+ OG days, locks unconditional`);
  console.log(`eligible OG wallets    ${eligible.size} (${locked} via verified locks)`);
  console.log(`already paid           ${paid.size}`);
  console.log(`sighted, awaiting day2 ${pending.length - payableCount} (pay on a later qualifying morning)`);
  console.log(`payable (read-only est) ${payableCount} (before the headroom gate)`);
  console.log(`curve headroom (raw)   ${await bridgeHeadroom(cfg, date)}`);
  console.log(`reserve held from drip ${fmt(rawToHuman(bridgeReserveRaw(cfg, date, 6), 6))} (at 6 decimals)`);
  console.log('--------------------------------------------------');
}
