// The loyalty capstone. The 94 longest-held wallets each receive a fixed
// bonus. Ranked by streak ALONE among wallets clearing the 10k floor, so
// size buys nothing: a 90-day holder of 15k outranks a 30-day holder of
// 2M. Paid from inside the Box, bound by the same curve as everything
// else. Public ranking, recomputable by anyone, no randomness.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { AppConfig, todayStr } from './config.js';
import { readCsv } from './holders.js';
import { fmt, humanToRaw, rawToHuman, inSellerTimeout } from './math.js';

export interface LoyaltyWinner {
  wallet: string;
  streak: number;
  balanceRaw: bigint;
  rank: number;
}

// Rank eligible wallets by streak desc. Ties broken by balance desc, then
// wallet asc, so the ordering is deterministic and publicly reproducible.
// Timeout wallets are excluded: you cannot be "most loyal" the same week
// you dumped. Sub-floor and PDA wallets never qualify.
export function rankLoyalty(cfg: AppConfig, date: string): LoyaltyWinner[] {
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  const rows = readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .filter((r) => !inSellerTimeout((r.last_reduced ?? '') || undefined, date, cfg.sellerTimeoutDays))
    .map((r) => ({
      wallet: r.wallet as string,
      streak: Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1),
      balanceRaw: BigInt(r.balance_raw as string),
    }));

  rows.sort((a, b) => {
    if (a.streak !== b.streak) return b.streak - a.streak; // loyalty first
    if (a.balanceRaw !== b.balanceRaw) return b.balanceRaw > a.balanceRaw ? 1 : -1; // then size, tiebreak only
    return a.wallet < b.wallet ? -1 : 1; // then deterministic
  });

  return rows.slice(0, cfg.loyaltyWinners).map((r, i) => ({ ...r, rank: i + 1 }));
}

// Idempotent, append-only ledger of paid capstone events, keyed by event id.
function capstonePaidSet(cfg: AppConfig, eventId: string): Set<string> {
  const paid = new Set<string>();
  if (!fs.existsSync(cfg.dirs.logs)) return paid;
  for (const f of fs.readdirSync(cfg.dirs.logs)) {
    if (!f.endsWith('-sent-log.json')) continue;
    for (const line of fs.readFileSync(path.join(cfg.dirs.logs, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; wallet?: string; status?: string; event_id?: string };
        if (e.type === 'loyalty' && e.status === 'confirmed' && e.event_id === eventId && e.wallet) {
          paid.add(e.wallet);
        }
      } catch {
        /* skip */
      }
    }
  }
  return paid;
}

export async function runLoyaltyPreview(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const winners = rankLoyalty(cfg, date);
  const ctx = await (await import('./holders.js')).getTokenContext(cfg);
  const bonusRaw = humanToRaw(String(cfg.loyaltyBonusTokens), ctx.decimals);
  const total = bonusRaw * BigInt(winners.length);

  console.log('');
  console.log('LOYALTY CAPSTONE preview');
  console.log('--------------------------------------------------');
  console.log(`gate                   ${fmt(String(cfg.qualifyFloorTokens))} floor`);
  console.log(`ranked by              streak (days held), size ignored`);
  console.log(`winners                ${winners.length} (target ${cfg.loyaltyWinners})`);
  console.log(`bonus each             ${fmt(String(cfg.loyaltyBonusTokens))}`);
  console.log(`total this event       ${fmt(rawToHuman(total, ctx.decimals))}`);
  console.log('--------------------------------------------------');
  console.log('rank  streak  balance      wallet');
  for (const w of winners.slice(0, 20)) {
    console.log(
      `${String(w.rank).padStart(4)}  ${String(w.streak).padStart(6)}  ${rawToHuman(w.balanceRaw, ctx.decimals).padStart(11)}  ${w.wallet}`
    );
  }
  if (winners.length > 20) console.log(`... and ${winners.length - 20} more`);
  console.log('');
  console.log('The full ranking is public and recomputable from the snapshot.');
}

export async function runLoyaltyPay(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const eventId = process.env.LOYALTY_EVENT_ID?.trim();
  if (!eventId) {
    throw new Error('Set LOYALTY_EVENT_ID, e.g. LOYALTY_EVENT_ID=2026-07-20-capstone npm run loyalty-pay');
  }

  const winners = rankLoyalty(cfg, date);
  if (winners.length === 0) throw new Error('No eligible wallets.');

  const { getTokenContext } = await import('./holders.js');
  const { sendBatch, announce, notify } = await import('./airdrop.js');
  const { sumDistributed } = await import('./airdrop.js');

  const ctx = await getTokenContext(cfg);
  const bonusRaw = humanToRaw(String(cfg.loyaltyBonusTokens), ctx.decimals);

  // Curve gate: this is Box-funded, so it must fit inside unlocked headroom
  // like every other Box payment. Never breaks the equation.
  const maxPool = (ctx.supplyRaw * BigInt(cfg.maxAirdropPoolPercent)) / 100n;
  const qualCount = readCsv(path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`)).filter(
    (r) => r.wallet
  ).length;
  const unlocked = (maxPool * BigInt(Math.min(qualCount, cfg.holderGoal))) / BigInt(cfg.holderGoal);
  const distributed = sumDistributed(cfg);
  const headroom = unlocked > distributed ? unlocked - distributed : 0n;
  const need = bonusRaw * BigInt(winners.length);
  if (need > headroom) {
    throw new Error(
      `Capstone needs ${rawToHuman(need, ctx.decimals)} but only ${rawToHuman(headroom, ctx.decimals)} of curve headroom exists. ` +
        `Wait for growth or lower the bonus. The equation is not overridden.`
    );
  }

  // Idempotent: skip anyone already paid under this event id.
  const alreadyPaid = capstonePaidSet(cfg, eventId);
  const toPay = winners.filter((w) => !alreadyPaid.has(w.wallet));
  if (toPay.length === 0) {
    console.log(`Event ${eventId} already fully paid. Nothing to do.`);
    return;
  }

  const allocations = toPay.map((w) => ({ wallet: w.wallet, amountRaw: bonusRaw }));
  console.log(`LOYALTY CAPSTONE ${eventId}: paying ${toPay.length} of ${winners.length} winners.`);
  const { sent, failed } = await sendBatch(cfg, ctx, date, allocations, 'loyalty', eventId);

  notify('loyalty capstone', `${sent} loyal wallets paid ${fmt(String(cfg.loyaltyBonusTokens))} each, ${failed} failed.`);
  await announce(
    'the loyal 94. patience paid.',
    `${sent} of the longest-held pigeons just received ${fmt(String(cfg.loyaltyBonusTokens))} each. ranked by days held, not size. a 90-day bag of any size beat every whale who showed up late. the full list is public, recompute it yourself. this is what the box rewards.`
  );
  console.log(`Capstone complete. Paid: ${sent}. Failed: ${failed}.`);
}
