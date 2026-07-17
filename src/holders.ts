import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  GetProgramAccountsFilter,
  ParsedAccountData,
  PublicKey,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { parse } from 'csv-parse/sync';
import { AppConfig, todayStr } from './config.js';
import { fmt, humanToRaw, rawToHuman } from './math.js';

export interface TokenContext {
  programId: PublicKey;
  programName: string;
  supplyRaw: bigint;
  decimals: number;
}

// Detects whether the mint is classic SPL or Token-2022 and reads supply and decimals.
export async function getTokenContext(cfg: AppConfig): Promise<TokenContext> {
  const info = await cfg.connection.getAccountInfo(cfg.mint);
  if (!info) {
    throw new Error('Token mint not found on chain. Check TOKEN_MINT and RPC_URL.');
  }

  let programId: PublicKey;
  let programName: string;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) {
    programId = TOKEN_PROGRAM_ID;
    programName = 'SPL Token';
  } else if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    programId = TOKEN_2022_PROGRAM_ID;
    programName = 'Token-2022';
  } else {
    throw new Error('TOKEN_MINT is not owned by a known token program.');
  }

  const mintInfo = await getMint(cfg.connection, cfg.mint, 'confirmed', programId);
  return { programId, programName, supplyRaw: mintInfo.supply, decimals: mintInfo.decimals };
}

// Fetches every token account for the mint and groups balances by owner wallet.
// Unique owner wallets are holders. Token accounts are not.
export async function fetchHolderBalances(
  cfg: AppConfig,
  ctx: TokenContext
): Promise<Map<string, bigint>> {
  const filters: GetProgramAccountsFilter[] = [
    { memcmp: { offset: 0, bytes: cfg.mint.toBase58() } },
  ];
  // Token-2022 accounts have variable size because of extensions, so only
  // apply the fixed size filter for classic SPL.
  if (ctx.programId.equals(TOKEN_PROGRAM_ID)) {
    filters.unshift({ dataSize: 165 });
  }

  const accounts = await cfg.connection.getParsedProgramAccounts(ctx.programId, {
    filters,
    commitment: 'confirmed',
  });

  const mintStr = cfg.mint.toBase58();
  const balances = new Map<string, bigint>();

  for (const { account } of accounts) {
    const data = account.data;
    if (!('parsed' in data)) continue;
    const parsed = (data as ParsedAccountData).parsed as {
      info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } };
    };
    const acctInfo = parsed?.info;
    if (!acctInfo || acctInfo.mint !== mintStr || !acctInfo.owner) continue;

    const amount = BigInt(acctInfo.tokenAmount?.amount ?? '0');
    if (amount === 0n) continue;

    balances.set(acctInfo.owner, (balances.get(acctInfo.owner) ?? 0n) + amount);
  }

  return balances;
}

export function writeCsv(file: string, header: string[], rows: string[][]): void {
  const lines = [header.join(','), ...rows.map((r) => r.join(','))];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

export function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8');
  return parse(text, { columns: true, skip_empty_lines: true }) as Record<string, string>[];
}

// ---------- streaks ----------

export interface StreakRecord {
  streak: number;
  lastBalanceRaw: string;
  lastDate: string;
  lastReducedDate?: string; // last snapshot date the balance went down
}

export type StreakState = Record<string, StreakRecord>;

function streaksPath(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'streaks.json');
}

export function loadStreaks(cfg: AppConfig): StreakState {
  const file = streaksPath(cfg);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StreakState;
  } catch {
    return {};
  }
}

export function saveStreaks(cfg: AppConfig, state: StreakState): void {
  fs.writeFileSync(streaksPath(cfg), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

// Streak = consecutive snapshot days a wallet has not decreased its balance.
// Any decrease resets to 1. New wallets start at 1. Rerunning the snapshot
// on the same date updates the balance and applies resets but never
// increments, so a same-day rerun cannot inflate streaks.
// Tracked across ALL raw holders, so dipping below the qualifying minimum
// and buying back still counts as the sell it was.
export function updateStreaks(
  prev: StreakState,
  balances: Map<string, bigint>,
  date: string
): StreakState {
  const next: StreakState = { ...prev };
  // A wallet that vanished from the balance map sold to zero. Record the
  // reduction, or a full exit and rebuy keeps its streak and skips the
  // timeout entirely. Audit finding, closed here.
  for (const [wallet, rec] of Object.entries(prev)) {
    if (!balances.has(wallet) && rec.lastBalanceRaw !== '0') {
      next[wallet] = { streak: 1, lastBalanceRaw: '0', lastDate: date, lastReducedDate: date };
    }
  }
  for (const [wallet, balance] of balances) {
    const rec = prev[wallet];
    if (!rec) {
      next[wallet] = { streak: 1, lastBalanceRaw: balance.toString(), lastDate: date };
      continue;
    }
    if (balance < BigInt(rec.lastBalanceRaw)) {
      next[wallet] = { streak: 1, lastBalanceRaw: balance.toString(), lastDate: date, lastReducedDate: date };
    } else if (BigInt(rec.lastBalanceRaw) === 0n && balance > 0n) {
      // Returning from a full exit starts over. The old timeout stamp stays.
      next[wallet] = { streak: 1, lastBalanceRaw: balance.toString(), lastDate: date, lastReducedDate: rec.lastReducedDate };
    } else if (rec.lastDate === date) {
      next[wallet] = { streak: rec.streak, lastBalanceRaw: balance.toString(), lastDate: date, lastReducedDate: rec.lastReducedDate };
    } else {
      next[wallet] = { streak: rec.streak + 1, lastBalanceRaw: balance.toString(), lastDate: date, lastReducedDate: rec.lastReducedDate };
    }
  }
  return next;
}

export async function runSnapshot(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  console.log(`Snapshot for ${date}`);
  console.log(`Token mint: ${cfg.mint.toBase58()}`);

  const ctx = await getTokenContext(cfg);
  console.log(`Token program: ${ctx.programName}`);
  console.log(`Decimals: ${ctx.decimals}`);
  console.log('Fetching all token accounts. This can take a while on large mints.');

  const balances = await fetchHolderBalances(cfg, ctx);

  // Completeness guard. The full-exit fix stamps any previously-positive
  // wallet missing from this map as a seller. A truncated RPC response
  // would therefore mass-reset legitimate streaks and apply timeouts,
  // irreversibly. So before touching streak state, sanity-check that the
  // positive-holder count did not implausibly collapse versus last run.
  const priorStreaks = loadStreaks(cfg);
  const priorPositive = Object.values(priorStreaks).filter((r) => r.lastBalanceRaw !== '0').length;
  const nowPositive = balances.size;
  const floorPct = cfg.snapshotMaxDropPercent;
  if (priorPositive > 20 && nowPositive < priorPositive * (1 - floorPct / 100)) {
    throw new Error(
      `SNAPSHOT GUARD: positive holders fell ${priorPositive} -> ${nowPositive} ` +
        `(> ${floorPct}%). Likely a partial RPC response. Streak state left untouched. ` +
        `Re-run; if this is real, raise SNAPSHOT_MAX_DROP_PERCENT deliberately.`
    );
  }

  const sorted = Array.from(balances.entries()).sort((a, b) =>
    b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0
  );

  // Temp-write then atomic rename, so a crash mid-write never leaves a
  // half snapshot that later reads as truth.
  const rawFile = path.join(cfg.dirs.snapshots, `${date}-holders.csv`);
  const rawTmp = rawFile + '.tmp';
  writeCsv(
    rawTmp,
    ['wallet', 'balance_raw', 'balance'],
    sorted.map(([w, b]) => [w, b.toString(), rawToHuman(b, ctx.decimals)])
  );
  fs.renameSync(rawTmp, rawFile);

  // Back up prior streak state before committing the new one.
  const streaks = updateStreaks(priorStreaks, balances, date);
  try {
    const live = path.join(cfg.dirs.data, 'streaks.json');
    if (fs.existsSync(live)) fs.copyFileSync(live, path.join(cfg.dirs.data, `streaks.backup-${date}.json`));
  } catch {
    /* backup best-effort */
  }
  saveStreaks(cfg, streaks);

  const minRaw = humanToRaw(cfg.minHolderBalanceHuman, ctx.decimals);

  const qualifying: [string, bigint][] = [];
  for (const [wallet, balance] of sorted) {
    if (cfg.excludedWallets.has(wallet)) continue;
    if (balance < minRaw) continue;
    // Off-curve owners are PDAs: LP vaults, pools, program accounts. Never people.
    if (!PublicKey.isOnCurve(wallet)) continue;
    qualifying.push([wallet, balance]);
  }

  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  writeCsv(
    qualFile,
    ['wallet', 'balance_raw', 'balance', 'streak', 'last_reduced'],
    qualifying.map(([w, b]) => [
      w,
      b.toString(),
      rawToHuman(b, ctx.decimals),
      String(streaks[w]?.streak ?? 1),
      streaks[w]?.lastReducedDate ?? '',
    ])
  );

  const totalQualifying = qualifying.reduce((acc, [, b]) => acc + b, 0n);

  console.log('');
  console.log(`Raw holder count:        ${sorted.length}`);
  console.log(`Qualifying holder count: ${qualifying.length}`);
  console.log(`Excluded count:          ${sorted.length - qualifying.length}`);
  console.log(`Qualifying balance:      ${fmt(rawToHuman(totalQualifying, ctx.decimals))}`);
  const maxStreak = qualifying.reduce((m, [w]) => Math.max(m, streaks[w]?.streak ?? 1), 0);
  console.log(`Max streak:              ${maxStreak} day${maxStreak === 1 ? '' : 's'}`);
  console.log('');
  console.log(`Raw snapshot:        ${rawFile}`);
  console.log(`Qualifying holders:  ${qualFile}`);
  console.log('');
  console.log('Next: npm run preview');
}
