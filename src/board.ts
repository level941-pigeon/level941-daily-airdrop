// The public board. A static, recomputable snapshot of who is getting how
// much of today's pie and why. Multipliers only ever resize slices, they
// never grow the pool, so this file emits shares and streak facts, never
// a projected future token amount. docs/board.json is the data, docs/index.html
// is the static renderer. Both are meant to be published (e.g. GitHub Pages).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, todayStr } from './config.js';
import { getTokenContext, readCsv } from './holders.js';
import { sumDistributed } from './airdrop.js';
import { inSellerTimeout, nextNineFortyOne, rawToHuman, streakWeight } from './math.js';

export interface BoardEntry {
  rank: number;
  wallet: string; // truncated 4...4, the full address never leaves the CSV/ledger
  streak: number;
  multiplier: number; // min(streak,cap)^exponent at the LIVE STREAK_EXPONENT
  weightSharePercent: number; // this wallet's share of today's weighted pool
  yesterdayBreadTokens: string; // human amount actually confirmed-sent yesterday, "0" if none
}

export interface BoardData {
  generatedAt: string;
  date: string;
  rulesetId: string;
  streakCap: number;
  streakExponent: number;
  totals: {
    holderCount: number;
    allTimeDistributedTokens: string;
    maxStreak: number;
    next941: string;
  };
  entries: BoardEntry[];
}

function truncateWallet(w: string): string {
  return `${w.slice(0, 4)}...${w.slice(-4)}`;
}

// Calendar-day arithmetic on YYYY-MM-DD strings, UTC-based like daysBetween
// in math.ts, so it agrees with the rest of the date math in this codebase.
function addDaysStr(date: string, delta: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7)) - 1;
  const d = Number(date.slice(8, 10));
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

export async function runPublishBoard(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }

  const rows = readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .map((r) => ({
      wallet: r.wallet as string,
      balanceRaw: BigInt(r.balance_raw as string),
      streak: Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1),
      lastReduced: (r.last_reduced ?? '') as string,
    }));

  const cap = cfg.streakCap;
  const exponent = cfg.streakExponent;

  // Mirrors runPreview: sellers in timeout still hold and still count in the
  // list, but carry zero weight today. Their slice pays everyone who held.
  const weights = new Map<string, bigint>();
  let totalWeight = 0n;
  for (const r of rows) {
    const timedOut = inSellerTimeout(r.lastReduced || undefined, date, cfg.sellerTimeoutDays);
    const w = timedOut ? 0n : streakWeight(r.balanceRaw, r.streak, cap, exponent);
    weights.set(r.wallet, w);
    totalWeight += w;
  }

  // Yesterday's actual confirmed daily sends, joined by wallet.
  const yesterday = addDaysStr(date, -1);
  const yesterdayLog = path.join(cfg.dirs.logs, `${yesterday}-sent-log.json`);
  const bread = new Map<string, bigint>();
  if (fs.existsSync(yesterdayLog)) {
    for (const line of fs.readFileSync(yesterdayLog, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as {
          wallet?: string;
          type?: string;
          status?: string;
          amount_raw?: string;
        };
        if (e.type === 'daily' && e.status === 'confirmed' && e.wallet && e.amount_raw) {
          bread.set(e.wallet, (bread.get(e.wallet) ?? 0n) + BigInt(e.amount_raw));
        }
      } catch {
        /* skip malformed line */
      }
    }
  }

  const ctx = await getTokenContext(cfg);
  const d = ctx.decimals;

  const ranked = rows
    .map((r) => {
      const w = weights.get(r.wallet) ?? 0n;
      const cappedStreak = Math.min(Math.max(r.streak, 1), cap);
      return {
        wallet: r.wallet,
        streak: r.streak,
        multiplier: cappedStreak ** exponent,
        weightSharePercent: totalWeight > 0n ? Number((w * 1_000_000n) / totalWeight) / 10_000 : 0,
        yesterdayBreadTokens: rawToHuman(bread.get(r.wallet) ?? 0n, d),
      };
    })
    .sort((a, b) => {
      if (a.weightSharePercent !== b.weightSharePercent) return b.weightSharePercent - a.weightSharePercent;
      if (a.streak !== b.streak) return b.streak - a.streak;
      return a.wallet < b.wallet ? -1 : 1;
    });

  const entries: BoardEntry[] = ranked.map((r, i) => ({
    rank: i + 1,
    wallet: truncateWallet(r.wallet),
    streak: r.streak,
    multiplier: r.multiplier,
    weightSharePercent: r.weightSharePercent,
    yesterdayBreadTokens: r.yesterdayBreadTokens,
  }));

  const maxStreak = rows.reduce((m, r) => Math.max(m, r.streak), 0);
  const allTimeDistributedRaw = sumDistributed(cfg);

  const board: BoardData = {
    generatedAt: new Date().toISOString(),
    date,
    rulesetId: cfg.rulesetId,
    streakCap: cap,
    streakExponent: exponent,
    totals: {
      holderCount: rows.length,
      allTimeDistributedTokens: rawToHuman(allTimeDistributedRaw, d),
      maxStreak,
      next941: nextNineFortyOne().toISOString(),
    },
    entries,
  };

  const docsDir = path.join(process.cwd(), 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const outFile = path.join(docsDir, 'board.json');
  fs.writeFileSync(outFile, JSON.stringify(board, null, 2) + '\n', 'utf8');

  console.log(`Board published: ${outFile}`);
  console.log(`${entries.length} wallets, max streak ${maxStreak}, exponent ${exponent} (cap ${cap}).`);
}
