// Community drop pipeline. Three lanes for anything landing in the wallet:
// fastlane (pre-approved, next run), pipeline (screen -> cooling -> value
// floor -> auto sweep), quarantine (hostile, denied, or worthless).
//
// The main token NEVER sweeps. It belongs to the daily drip and the curve.
// Excess SOL above the fee reserve sweeps too, when meaningful.
// One sweep per mint per wallet per date, ledger enforced.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { AppConfig, sleep, todayStr } from './config.js';
import { TokenContext, readCsv } from './holders.js';
import { HolderWeight, computeAllocations, fmt, inSellerTimeout, rawToHuman, streakWeight } from './math.js';
import { announce, notify, sendBatch, sentSetForMint } from './airdrop.js';
import { Lane, MintRecord, SweepState, decideLane, quoteValueUsd, screenMint } from './screen.js';

export interface WalletToken {
  mint: string;
  programId: PublicKey;
  amountRaw: bigint;
  decimals: number;
}

function statePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'sweep-state.json');
}

// Read-only state read. Exported for the live poller, which observes the
// pipeline's cooling/screen bookkeeping but never mutates it: screening and
// quoting are network calls with real side effects, reserved for the actual
// sweep run.
export function loadState(cfg: AppConfig): SweepState {
  const f = statePath(cfg);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as SweepState;
  } catch {
    return {};
  }
}

function saveState(cfg: AppConfig, s: SweepState): void {
  fs.writeFileSync(statePath(cfg), JSON.stringify(s, null, 2) + '\n', 'utf8');
}

// Read-only: lists whatever is currently in the wallet. Exported for the
// live poller alongside loadState.
export async function listWalletTokens(cfg: AppConfig): Promise<WalletToken[]> {
  const out: WalletToken[] = [];
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const res = await cfg.connection.getParsedTokenAccountsByOwner(cfg.keypair.publicKey, {
      programId,
    });
    for (const { account } of res.value) {
      const info = account.data.parsed?.info as
        | { mint?: string; tokenAmount?: { amount?: string; decimals?: number } }
        | undefined;
      if (!info?.mint || !info.tokenAmount) continue;
      const amountRaw = BigInt(info.tokenAmount.amount ?? '0');
      if (amountRaw === 0n) continue;
      out.push({
        mint: info.mint,
        programId,
        amountRaw,
        decimals: info.tokenAmount.decimals ?? 0,
      });
    }
  }
  return out;
}

function topHoldersByWeight(cfg: AppConfig, date: string, topN: number): HolderWeight[] {
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  const holders: HolderWeight[] = readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .filter((r) => !inSellerTimeout((r.last_reduced ?? '') || undefined, date, cfg.sellerTimeoutDays))
    .map((r) => ({
      wallet: r.wallet as string,
      balanceRaw: BigInt(r.balance_raw as string),
      streak: Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1),
    }));
  const weight = (h: HolderWeight) => streakWeight(h.balanceRaw, h.streak, cfg.streakCap, cfg.streakExponent);
  holders.sort((a, b) => {
    const wa = weight(a);
    const wb = weight(b);
    return wb > wa ? 1 : wb < wa ? -1 : 0;
  });
  return holders.slice(0, topN);
}

// Evaluates every foreign token in the wallet against the pipeline and
// returns each with its lane. Screens run once and persist. Quotes run only
// for tokens past the cooling window, to keep API traffic minimal.
async function evaluate(
  cfg: AppConfig,
  tokens: WalletToken[]
): Promise<{ token: WalletToken; lane: Lane; reason: string }[]> {
  const state = loadState(cfg);
  const nowSec = Math.floor(Date.now() / 1000);
  const results: { token: WalletToken; lane: Lane; reason: string }[] = [];

  for (const t of tokens) {
    let rec = state[t.mint];
    if (!rec) {
      const screen = await screenMint(cfg.connection, new PublicKey(t.mint), t.programId);
      rec = {
        firstSeen: nowSec,
        screened: true,
        screenOk: screen.ok,
        screenReasons: screen.reasons,
        denied: false,
        lastValueUsd: null,
        sweptDates: [],
      };
      state[t.mint] = rec;
      notify('drop wallet: new token detected', `${t.mint}\n${fmt(rawToHuman(t.amountRaw, t.decimals))} received. screen: ${screen.ok ? 'clean, cooling window started' : 'QUARANTINED, ' + screen.reasons.join(', ')}`);
      await announce(
        'bread landed in the box',
        screen.ok
          ? `${fmt(rawToHuman(t.amountRaw, t.decimals))} of ${t.mint.slice(0, 4)}...${t.mint.slice(-4)} arrived. clean scan. 48 hour window starts now.`
          : `${t.mint.slice(0, 4)}...${t.mint.slice(-4)} arrived and failed the scan. straight to the cage. thanks for the donation.`
      );
    }

    const fastlane = cfg.allowedDropMints.has(t.mint);
    const aged = (nowSec - rec.firstSeen) / 3600 >= cfg.sweepDelayHours;
    if (!rec.denied && rec.screenOk && !fastlane && aged) {
      rec.lastValueUsd = await quoteValueUsd(cfg.jupQuoteUrl, t.mint, t.amountRaw);
    }

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
    results.push({ token: t, lane, reason });
  }

  saveState(cfg, state);
  return results;
}

async function sweepToken(
  cfg: AppConfig,
  date: string,
  top: HolderWeight[],
  t: WalletToken
): Promise<void> {
  const already = sentSetForMint(cfg, date, t.mint);
  // Renormalize against ONLY the wallets not yet paid today, not the full
  // top list. If an earlier attempt today already paid some of them (e.g.
  // a batch that halted partway through), computeAllocations must split the
  // CURRENT remaining balance across exactly who's left -- splitting it
  // against the full list's weight (the old behavior) systematically
  // under-allocates the remainder, since t.amountRaw here is already
  // whatever is left, not the original pool. This is what makes a same-day
  // retry actually finish the job instead of asymptotically trickling out.
  const unpaid = top.filter((h) => !already.has(h.wallet));
  const allocations = computeAllocations(t.amountRaw, unpaid, 'streak', cfg.streakCap, cfg.streakExponent);
  if (allocations.length === 0) {
    console.log(`${t.mint}: already swept today. Skipping.`);
    return;
  }
  const ctx: TokenContext = {
    programId: t.programId,
    programName: t.programId.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL Token',
    supplyRaw: 0n,
    decimals: t.decimals,
  };
  console.log(`Sweeping ${fmt(rawToHuman(t.amountRaw, t.decimals))} of ${t.mint} to ${allocations.length} wallets.`);
  const { sent, failed } = await sendBatch(cfg, ctx, date, allocations, 'sweep', undefined, new PublicKey(t.mint));

  // Only record this mint as swept-today if something actually landed.
  // Previously this pushed unconditionally, so a batch that failed 100/100
  // (e.g. the wallet ran out of SOL) still left a "sweptDates" entry
  // claiming success -- misleading for anyone auditing the history later,
  // even though nothing actually gates re-attempts off this field.
  if (sent > 0) {
    const state = loadState(cfg);
    if (state[t.mint]) {
      state[t.mint]!.sweptDates.push(date);
      saveState(cfg, state);
    }
  }

  notify('drop wallet: sweep complete', `${fmt(rawToHuman(t.amountRaw, t.decimals))} of ${t.mint.slice(0, 8)}... to ${sent} holders. failed: ${failed}.`);

  // Never tell the public "to the top 0 pigeons" -- if nothing sent, there
  // is nothing to announce. The failure is still visible via notify() above
  // (private) and the halted-batch notification from sendBatch itself.
  if (sent > 0) {
    await announce(
      'sweep. the flock eats.',
      `${fmt(rawToHuman(t.amountRaw, t.decimals))} of ${t.mint.slice(0, 4)}...${t.mint.slice(-4)} to the top ${sent} pigeons. size x days held. on chain now.`
    );
  }
}

// Excess SOL above the fee reserve, split by weight across ALL qualifying
// holders, plain system transfers. Every pigeon gets a piece: the published
// pledge for creator-fee drops. Foreign tokens stay top-100, SOL does not.
async function sweepSol(cfg: AppConfig, date: string): Promise<void> {
  let recipients: HolderWeight[];
  try {
    recipients = topHoldersByWeight(cfg, date, Number.MAX_SAFE_INTEGER);
  } catch {
    return; // no snapshot today, nothing to route
  }
  const balance = await cfg.connection.getBalance(cfg.keypair.publicKey);
  const reserveLamports = Math.floor(cfg.solReserve * LAMPORTS_PER_SOL);
  const excess = BigInt(balance - reserveLamports);
  if (excess < BigInt(0.5 * LAMPORTS_PER_SOL)) return; // only meaningful tips

  const already = sentSetForMint(cfg, date, 'SOL');
  const allocations = computeAllocations(excess, recipients, 'streak', cfg.streakCap, cfg.streakExponent).filter(
    (a) => !already.has(a.wallet) && a.amountRaw > cfg.dividendMinRaw // dividend-lane dust floor
  );
  if (allocations.length === 0) return;

  console.log(`Sweeping ${(Number(excess) / LAMPORTS_PER_SOL).toFixed(4)} excess SOL to ${allocations.length} wallets.`);
  let sent = 0;
  for (const a of allocations) {
    try {
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: cfg.keypair.publicKey,
          toPubkey: new PublicKey(a.wallet),
          lamports: a.amountRaw,
        })
      );
      const signature = await sendAndConfirmTransaction(cfg.connection, tx, [cfg.keypair], {
        commitment: 'confirmed',
      });
      fs.appendFileSync(
        path.join(cfg.dirs.logs, `${date}-sent-log.json`),
        JSON.stringify({
          date,
          wallet: a.wallet,
          amount: (Number(a.amountRaw) / LAMPORTS_PER_SOL).toFixed(9),
          amount_raw: a.amountRaw.toString(),
          signature,
          status: 'confirmed',
          type: 'sweep',
          mint: 'SOL',
          ts: new Date().toISOString(),
        }) + '\n',
        'utf8'
      );
      sent++;
    } catch (e) {
      console.log(`SOL send failed for ${a.wallet}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    await sleep(cfg.sendDelayMs);
  }
  notify('drop wallet: SOL sweep', `${(Number(excess) / LAMPORTS_PER_SOL).toFixed(3)} SOL to ${sent} holders.`);
  await announce(
    'sweep. the flock eats.',
    `${(Number(excess) / LAMPORTS_PER_SOL).toFixed(3)} SOL to the top ${sent} pigeons. size x days held. on chain now.`
  );
}

function printReport(results: { token: WalletToken; lane: Lane; reason: string }[]): void {
  const byLane = (l: Lane) => results.filter((r) => r.lane === l);
  console.log('');
  console.log('Drop wallet pipeline');
  console.log('--------------------------------------------------');
  for (const lane of ['sweep', 'fastlane', 'pending', 'quarantined', 'denied'] as Lane[]) {
    const rows = byLane(lane);
    if (rows.length === 0) continue;
    console.log(`${lane.toUpperCase()} (${rows.length})`);
    for (const r of rows) {
      console.log(`  ${r.token.mint}`);
      console.log(`    ${fmt(rawToHuman(r.token.amountRaw, r.token.decimals))}  ${r.reason}`);
    }
  }
  console.log('--------------------------------------------------');
}

// Called by send-auto after the daily drip. No prompt: everything that
// reaches the sweep lane already passed screen, cooling, and value floor.
export async function runAutoSweep(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const mainMint = cfg.mint.toBase58();
  const tokens = (await listWalletTokens(cfg)).filter((t) => t.mint !== mainMint);
  if (tokens.length === 0) {
    await sweepSol(cfg, date);
    return;
  }
  const results = await evaluate(cfg, tokens);
  printReport(results);
  const clear = results.filter((r) => r.lane === 'sweep' || r.lane === 'fastlane');
  if (clear.length === 0) {
    await sweepSol(cfg, date);
    return;
  }
  const top = topHoldersByWeight(cfg, date, cfg.sweepTopN);
  for (const r of clear) {
    await sweepToken(cfg, date, top, r.token);
  }
  await sweepSol(cfg, date);
}

function askConfirm(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question('Type CONFIRM to sweep now, anything else aborts: ', (a) => {
      rl.close();
      resolve(a.trim());
    })
  );
}

// Manual sweep: same pipeline, same lanes, prompt before moving anything.
export async function runSweep(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const mainMint = cfg.mint.toBase58();
  const tokens = (await listWalletTokens(cfg)).filter((t) => t.mint !== mainMint);
  const results = tokens.length > 0 ? await evaluate(cfg, tokens) : [];
  printReport(results);
  const clear = results.filter((r) => r.lane === 'sweep' || r.lane === 'fastlane');
  if (clear.length === 0) {
    console.log('Nothing cleared for sweep. SOL excess still checks on auto runs.');
    return;
  }
  const answer = await askConfirm();
  if (answer !== 'CONFIRM') {
    console.log('Aborted. Nothing moved.');
    return;
  }
  const top = topHoldersByWeight(cfg, date, cfg.sweepTopN);
  for (const r of clear) {
    await sweepToken(cfg, date, top, r.token);
  }
}

export async function runSweepStatus(cfg: AppConfig): Promise<void> {
  const mainMint = cfg.mint.toBase58();
  const tokens = (await listWalletTokens(cfg)).filter((t) => t.mint !== mainMint);
  if (tokens.length === 0) {
    console.log('No foreign tokens in the drop wallet.');
    return;
  }
  const results = await evaluate(cfg, tokens);
  printReport(results);
  console.log('Nothing was moved. This is a report.');
}

export async function runSweepDeny(cfg: AppConfig, mintStr: string): Promise<void> {
  let mint: PublicKey;
  try {
    mint = new PublicKey(mintStr.trim());
  } catch {
    throw new Error('Usage: npm run sweep-deny -- <mint address>');
  }
  const state = loadState(cfg);
  const rec: MintRecord = state[mint.toBase58()] ?? {
    firstSeen: Math.floor(Date.now() / 1000),
    screened: true,
    screenOk: false,
    screenReasons: ['manually denied'],
    denied: false,
    lastValueUsd: null,
    sweptDates: [],
  };
  rec.denied = true;
  state[mint.toBase58()] = rec;
  saveState(cfg, state);
  console.log(`Denied forever: ${mint.toBase58()}. It will never sweep.`);
  notify('drop wallet: mint denied', mint.toBase58());
}
