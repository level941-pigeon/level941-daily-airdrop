// The flock-builder: who is actually bringing in new qualifying holders.
//
// Attribution, not self-report. For a NEW qualifying wallet, we find who
// funded its very first transaction (the fee payer of its oldest signature
// is, for a fresh wallet, almost always who created it). That signal alone
// is trivially farmable -- fund N wallets, send them your own tokens
// directly, claim N recruits. So a funder only gets credit when ALL of:
//
//   1. they were ALREADY a qualifying holder before they funded the new
//      wallet (no fresh throwaway "recruiter" wallets)
//   2. the new wallet's tokens did NOT come directly from the funder (kills
//      the cheap bag-splitting attack -- this is the load-bearing filter)
//   3. the new wallet sustains qualification for a real streak, not a
//      snapshot-and-dump
//
// A funder racking up an unusual cluster of recruits on the same day is not
// blocked, but is flagged "under review" in the published output. This is a
// cost-raising, farming-detection design, not a cryptographic proof of a
// real human relationship -- that does not exist in a pseudonymous system
// without identity. No reward is wired to this yet: it exists to be watched.
//
// Tracking starts from a baseline snapshot at first run. Wallets that were
// already qualifying before that point are never treated as "new" -- this
// is prospective (who joins from here on), not retroactive.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { AppConfig, sleep, todayStr } from './config.js';
import { readCsv } from './holders.js';

const STREAK_THRESHOLD = 3; // days a recruit must sustain qualification before counting
const BURST_THRESHOLD = 3; // confirmed recruits sharing a funding date -> flagged for review

interface RecruitRecord {
  wallet: string;
  firstQualifiedDate: string;
  funderWallet: string | null;
  funderTxSignature: string | null;
  funderWasQualifying: boolean;
  tokensFromFunderDirectly: boolean;
  crawlComplete: boolean;
  crawlError: string | null;
}

type RecruitState = Record<string, RecruitRecord>;

function statePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'recruit-state.json');
}
function baselinePath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'recruit-baseline.json');
}

function loadState(cfg: AppConfig): RecruitState {
  const f = statePath(cfg);
  if (!fs.existsSync(f)) return {};
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as RecruitState;
  } catch {
    return {};
  }
}
function saveState(cfg: AppConfig, s: RecruitState): void {
  fs.writeFileSync(statePath(cfg), JSON.stringify(s, null, 2) + '\n', 'utf8');
}

// RPC calls here have no default timeout in @solana/web3.js -- a slow or
// unresponsive backend hangs the whole scan indefinitely rather than
// erroring, which a plain retry-on-throw loop (the pattern used elsewhere
// in this codebase) never even gets a chance to catch. Race every call
// against a hard deadline, and retry a bounded number of times on top.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      promise.finally(() => clearTimeout(t)).catch(() => {});
    }),
  ]);
}

async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await withTimeout(fn(), 20000, label);
    } catch (e) {
      lastErr = e;
      if (i < attempts) await sleep(1000 * i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function latestQualifyingFile(cfg: AppConfig, onOrBefore: string): string | null {
  if (!fs.existsSync(cfg.dirs.snapshots)) return null;
  const dates = fs
    .readdirSync(cfg.dirs.snapshots)
    .filter((f) => f.endsWith('-qualifying-holders.csv'))
    .map((f) => f.replace('-qualifying-holders.csv', ''))
    .filter((d) => d <= onOrBefore)
    .sort();
  if (dates.length === 0) return null;
  return path.join(cfg.dirs.snapshots, `${dates[dates.length - 1]}-qualifying-holders.csv`);
}

function wasQualifyingOnOrBefore(cfg: AppConfig, wallet: string, dateStr: string): boolean {
  const file = latestQualifyingFile(cfg, dateStr);
  if (!file) return false;
  return readCsv(file).some((r) => r.wallet === wallet);
}

// Strictly before `date` -- used for baseline seeding, so the snapshot the
// feature launches on is treated as "new" activity to track, not baseline.
function latestQualifyingFileBefore(cfg: AppConfig, date: string): string | null {
  if (!fs.existsSync(cfg.dirs.snapshots)) return null;
  const dates = fs
    .readdirSync(cfg.dirs.snapshots)
    .filter((f) => f.endsWith('-qualifying-holders.csv'))
    .map((f) => f.replace('-qualifying-holders.csv', ''))
    .filter((d) => d < date)
    .sort();
  if (dates.length === 0) return null;
  return path.join(cfg.dirs.snapshots, `${dates[dates.length - 1]}-qualifying-holders.csv`);
}

// The fee payer of a fresh wallet's oldest transaction is, in practice, who
// created it -- a wallet with 0 SOL cannot submit its own first transaction.
//
// Bounded to a few thousand signatures: not every new *holder* is a new
// *wallet* -- plenty will be pre-existing, active Solana wallets that just
// newly bought enough $pigeon to qualify. Their transaction history can run
// into the tens of thousands and predates any relationship to this token by
// months or years, so crawling all the way to their absolute first-ever
// transaction is both slow and not a meaningful "who recruited them" signal
// anyway. Past the cap, this returns "no funder found" rather than paying an
// unbounded cost for a signal that wouldn't mean anything if we found it.
const MAX_FUNDER_SEARCH_PAGES = 3;

async function findFirstFunder(
  cfg: AppConfig,
  wallet: PublicKey
): Promise<{ funder: string; signature: string } | null> {
  let before: string | undefined;
  let lastBatch: Awaited<ReturnType<typeof cfg.connection.getSignaturesForAddress>> = [];
  let pages = 0;
  for (;;) {
    const batch = await withRetry(
      () => cfg.connection.getSignaturesForAddress(wallet, { before, limit: 1000 }, 'confirmed'),
      'getSignaturesForAddress(wallet)'
    );
    pages++;
    if (batch.length === 0) break;
    lastBatch = batch;
    if (batch.length < 1000) break;
    if (pages >= MAX_FUNDER_SEARCH_PAGES) {
      console.log(`  wallet has ${pages * 1000}+ signatures, not a fresh wallet -- skipping funder search.`);
      return null;
    }
    before = batch[batch.length - 1]!.signature;
    await sleep(150);
  }
  if (lastBatch.length === 0) return null;
  const oldestSig = lastBatch[lastBatch.length - 1]!.signature;

  const tx = await withRetry(
    () => cfg.connection.getParsedTransaction(oldestSig, { maxSupportedTransactionVersion: 0 }),
    'getParsedTransaction(oldest)'
  );
  if (!tx || !tx.meta) return null;
  const keys = tx.transaction.message.accountKeys;
  const walletIdx = keys.findIndex((k) => k.pubkey.equals(wallet));
  if (walletIdx === -1 || walletIdx === 0) return null; // wallet was its own fee payer -> no external funder
  const pre = tx.meta.preBalances[walletIdx] ?? 0;
  const post = tx.meta.postBalances[walletIdx] ?? 0;
  if (post <= pre) return null; // this tx didn't fund the wallet
  const funder = keys[0]!.pubkey.toBase58(); // account index 0 is always the fee payer
  return { funder, signature: oldestSig };
}

// Did the funder's OWN pigeon balance ever decrease in the same transaction
// that credited the recruit's pigeon account? That is a direct transfer --
// the cheap sybil move (fund + hand over your own tokens) -- and disqualifies
// the recruit regardless of how the funder relationship otherwise looks.
async function fundedTokensDirectly(
  cfg: AppConfig,
  funderWallet: string,
  recipientWallet: string
): Promise<boolean> {
  const mint = cfg.mint;
  let funderAta: PublicKey;
  let recipientAta: PublicKey;
  try {
    funderAta = getAssociatedTokenAddressSync(mint, new PublicKey(funderWallet), true);
    recipientAta = getAssociatedTokenAddressSync(mint, new PublicKey(recipientWallet), true);
  } catch {
    return false;
  }
  const MAX_TOKEN_HISTORY_CHECK = 300;
  const allSigs = await withRetry(
    () => cfg.connection.getSignaturesForAddress(recipientAta, { limit: 1000 }, 'confirmed'),
    'getSignaturesForAddress(recipientAta)'
  );
  // Oldest first: a direct hand-off from the funder, if it happened, is most
  // likely near account creation, not buried in months of later trading.
  const sigs = allSigs.slice().reverse().slice(0, MAX_TOKEN_HISTORY_CHECK);
  const funderAtaStr = funderAta.toBase58();
  for (const s of sigs) {
    const tx = await withRetry(
      () => cfg.connection.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }),
      'getParsedTransaction(recipientAta history)'
    );
    if (!tx || !tx.meta) continue;
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const funderIdx = keys.indexOf(funderAtaStr);
    if (funderIdx === -1) continue;
    const pre = tx.meta.preTokenBalances?.find((b) => b.accountIndex === funderIdx);
    const post = tx.meta.postTokenBalances?.find((b) => b.accountIndex === funderIdx);
    if (pre && post && BigInt(post.uiTokenAmount.amount) < BigInt(pre.uiTokenAmount.amount)) {
      return true;
    }
    await sleep(100);
  }
  return false;
}

interface BaselineFile {
  seededDate: string; // local calendar date (matches todayStr() elsewhere), not UTC
  wallets: string[];
}

function loadBaseline(cfg: AppConfig): BaselineFile | null {
  const f = baselinePath(cfg);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')) as BaselineFile;
}

// Establishes "tracking starts here": every wallet already qualifying at
// first run is baseline, never eligible to be treated as a "new" recruit.
// Written once; never overwritten by later runs. seededDate is stored
// explicitly (local date, same convention as todayStr()) rather than read
// from file birthtime, which is UTC and drifts a calendar day off local
// evenings -- exactly the kind of boundary mismatch this project's other
// date handling already avoids.
function ensureBaseline(cfg: AppConfig, date: string): Set<string> {
  const existing = loadBaseline(cfg);
  if (existing) return new Set(existing.wallets);
  const file = latestQualifyingFileBefore(cfg, date);
  const wallets = file ? readCsv(file).map((r) => r.wallet as string) : [];
  const data: BaselineFile = { seededDate: date, wallets };
  fs.writeFileSync(baselinePath(cfg), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Flock baseline seeded: ${wallets.length} existing holders excluded from recruit tracking from here forward.`);
  return new Set(wallets);
}

// Incremental: crawl only wallets not yet in state. Re-check streak for
// wallets still pending confirmation. Safe to run daily; cheap once caught up.
export async function runFlockScan(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const qualFile = latestQualifyingFile(cfg, date);
  if (!qualFile) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  const baseline = ensureBaseline(cfg, date);
  const rows = readCsv(qualFile).filter((r) => r.wallet);
  const state = loadState(cfg);

  let newlyTracked = 0;
  let crawled = 0;
  for (const row of rows) {
    const wallet = row.wallet as string;
    if (baseline.has(wallet)) continue;
    if (!state[wallet]) {
      state[wallet] = {
        wallet,
        firstQualifiedDate: date,
        funderWallet: null,
        funderTxSignature: null,
        funderWasQualifying: false,
        tokensFromFunderDirectly: false,
        crawlComplete: false,
        crawlError: null,
      };
      newlyTracked++;
    }
  }

  const pendingWallets = Object.keys(state).filter((w) => !state[w]!.crawlComplete);
  let progress = 0;
  for (const wallet of pendingWallets) {
    progress++;
    const rec = state[wallet]!;
    console.log(`Flock crawl [${progress}/${pendingWallets.length}] ${wallet.slice(0, 8)}...`);
    try {
      const found = await findFirstFunder(cfg, new PublicKey(wallet));
      if (!found) {
        rec.crawlComplete = true; // no external funder found (self-funded, or unreadable) -- no recruiter to credit
        console.log(`  no external funder found.`);
      } else {
        rec.funderWallet = found.funder;
        rec.funderTxSignature = found.signature;
        rec.funderWasQualifying = wasQualifyingOnOrBefore(cfg, found.funder, rec.firstQualifiedDate);
        rec.tokensFromFunderDirectly = await fundedTokensDirectly(cfg, found.funder, wallet);
        rec.crawlComplete = true;
        rec.crawlError = null;
        crawled++;
        console.log(
          `  funder ${found.funder.slice(0, 8)}... wasQualifying=${rec.funderWasQualifying} directTokens=${rec.tokensFromFunderDirectly}`
        );
      }
    } catch (e) {
      rec.crawlError = e instanceof Error ? e.message.slice(0, 200) : String(e);
      console.log(`  crawl failed: ${rec.crawlError}`);
    }
    // Save after every wallet, not just at the end -- a crawl that gets
    // interrupted (network stall, ctrl-c) resumes instead of redoing work.
    saveState(cfg, state);
    await sleep(150);
  }

  const streakConfirmedNow = rows.filter((r) => {
    const rec = state[r.wallet as string];
    if (!rec || baseline.has(r.wallet as string)) return false;
    const streak = Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1);
    return streak >= STREAK_THRESHOLD;
  }).length;

  console.log(`Flock scan: ${newlyTracked} newly tracked, ${crawled} crawled this run, ${streakConfirmedNow} currently past the ${STREAK_THRESHOLD}-day streak threshold.`);
}

export interface FlockRecruit {
  wallet: string;
  firstQualifiedDate: string;
  fundingTxSolscanUrl: string;
  underReview: boolean;
}
export interface FlockEntry {
  rank: number;
  recruiter: string;
  recruitCount: number;
  recruits: FlockRecruit[];
}
export interface FlockData {
  generatedAt: string;
  trackingSince: string;
  totals: {
    totalConfirmedRecruits: number;
    totalRecruiters: number;
    pendingEvaluation: number;
  };
  entries: FlockEntry[];
}

function truncateWallet(w: string): string {
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

export async function runPublishFlock(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const qualFile = latestQualifyingFile(cfg, date);
  if (!qualFile) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  const streakByWallet = new Map(
    readCsv(qualFile).map((r) => [r.wallet as string, Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1)])
  );
  const state = loadState(cfg);
  const baseline = loadBaseline(cfg);

  let pending = 0;
  const byFunder = new Map<string, { wallet: string; firstQualifiedDate: string; tx: string }[]>();

  for (const rec of Object.values(state)) {
    if (!rec.crawlComplete) {
      pending++;
      continue;
    }
    const streak = streakByWallet.get(rec.wallet);
    const streakOk = streak != null && streak >= STREAK_THRESHOLD;
    if (!streakOk) {
      pending++;
      continue;
    }
    const confirmed =
      rec.funderWallet !== null && rec.funderWasQualifying && !rec.tokensFromFunderDirectly;
    if (!confirmed) continue;
    const list = byFunder.get(rec.funderWallet!) ?? [];
    list.push({ wallet: rec.wallet, firstQualifiedDate: rec.firstQualifiedDate, tx: rec.funderTxSignature! });
    byFunder.set(rec.funderWallet!, list);
  }

  const ranked = Array.from(byFunder.entries())
    .map(([funder, recruits]) => {
      // Burst detection: 3+ confirmed recruits sharing the same funding
      // date get flagged, visibly, rather than silently trusted or hidden.
      const dateCounts = new Map<string, number>();
      for (const r of recruits) dateCounts.set(r.firstQualifiedDate, (dateCounts.get(r.firstQualifiedDate) ?? 0) + 1);
      const recruitOut: FlockRecruit[] = recruits
        .sort((a, b) => (a.firstQualifiedDate < b.firstQualifiedDate ? 1 : -1))
        .map((r) => ({
          wallet: truncateWallet(r.wallet),
          firstQualifiedDate: r.firstQualifiedDate,
          fundingTxSolscanUrl: `https://solscan.io/tx/${r.tx}`,
          underReview: (dateCounts.get(r.firstQualifiedDate) ?? 0) >= BURST_THRESHOLD,
        }));
      return { funder, recruitCount: recruits.length, recruits: recruitOut };
    })
    .sort((a, b) => {
      if (a.recruitCount !== b.recruitCount) return b.recruitCount - a.recruitCount;
      return a.funder < b.funder ? -1 : 1;
    });

  const entries: FlockEntry[] = ranked.map((r, i) => ({
    rank: i + 1,
    recruiter: truncateWallet(r.funder),
    recruitCount: r.recruitCount,
    recruits: r.recruits,
  }));

  const trackingSince = baseline?.seededDate ?? date;

  const data: FlockData = {
    generatedAt: new Date().toISOString(),
    trackingSince,
    totals: {
      totalConfirmedRecruits: entries.reduce((a, e) => a + e.recruitCount, 0),
      totalRecruiters: entries.length,
      pendingEvaluation: pending,
    },
    entries,
  };

  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  fs.writeFileSync(path.join(docsDir, 'flock.json'), JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Flock board published: ${entries.length} recruiters, ${data.totals.totalConfirmedRecruits} confirmed recruits, ${pending} still pending evaluation.`);
}
