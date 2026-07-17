// Founder distribution. A deliberate, operator-triggered seeding of the
// community from the founder's own supply. NOT box emission: typed
// 'founder', excluded from curve accounting, never counts against U(H).
// This is "the founder distributed his own bag to the base that stayed,"
// stated plainly. Idempotent by event id so a rerun never double-pays.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AppConfig, todayStr } from './config.js';
import { readCsv } from './holders.js';
import { fmt, humanToRaw, rawToHuman } from './math.js';

// Every wallet already paid under this founder event, from the ledger.
// Exported so other founder-style drops (e.g. og-founder.ts) share the same
// idempotency check instead of reimplementing ledger scanning.
export function founderPaidSet(cfg: AppConfig, eventId: string): Set<string> {
  const paid = new Set<string>();
  if (!fs.existsSync(cfg.dirs.logs)) return paid;
  for (const f of fs.readdirSync(cfg.dirs.logs)) {
    if (!f.endsWith('-sent-log.json')) continue;
    for (const line of fs.readFileSync(path.join(cfg.dirs.logs, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as { type?: string; wallet?: string; status?: string; event_id?: string };
        if (e.type === 'founder' && e.status === 'confirmed' && e.event_id === eventId && e.wallet) {
          paid.add(e.wallet);
        }
      } catch {
        /* skip */
      }
    }
  }
  return paid;
}

function recipients(cfg: AppConfig, date: string): string[] {
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  return readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .map((r) => r.wallet as string);
}

export async function runFounderPreview(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const wallets = recipients(cfg, date);
  const ctx = await (await import('./holders.js')).getTokenContext(cfg);
  const perRaw = humanToRaw(String(cfg.founderDropTokens), ctx.decimals);
  const total = perRaw * BigInt(wallets.length);

  // How much the founder (sender) actually holds, and the 15% floor check.
  const { getSenderBalanceRaw } = await import('./airdrop.js');
  const senderRaw = await getSenderBalanceRaw(cfg, ctx);
  const coldFloorRaw = (ctx.supplyRaw * BigInt(cfg.retainedSupplyPercent)) / 100n;
  const spendableRaw = senderRaw > coldFloorRaw ? senderRaw - coldFloorRaw : 0n;

  console.log('');
  console.log('FOUNDER DROP preview');
  console.log('--------------------------------------------------');
  console.log(`recipients             ${wallets.length} wallets at the ${fmt(String(cfg.qualifyFloorTokens))} floor`);
  console.log(`each receives          ${fmt(String(cfg.founderDropTokens))}`);
  console.log(`total to send          ${fmt(rawToHuman(total, ctx.decimals))}`);
  console.log(`sender holds           ${fmt(rawToHuman(senderRaw, ctx.decimals))}`);
  console.log(`cold floor (${cfg.retainedSupplyPercent}%)        ${fmt(rawToHuman(coldFloorRaw, ctx.decimals))} must remain`);
  console.log(`spendable above floor  ${fmt(rawToHuman(spendableRaw, ctx.decimals))}`);
  console.log('--------------------------------------------------');
  if (total > spendableRaw) {
    console.log('BLOCKED: this drop would cut into the cold floor. Lower the per-wallet amount.');
  } else {
    console.log('OK: fits above the cold floor. This is a founder distribution, not box emission.');
  }
}

export async function runFounderPay(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const eventId = process.env.FOUNDER_EVENT_ID?.trim();
  if (!eventId) {
    throw new Error('Set FOUNDER_EVENT_ID, e.g. FOUNDER_EVENT_ID=2026-07-15-founder-seed npm run founder-pay');
  }

  const wallets = recipients(cfg, date);
  if (wallets.length === 0) throw new Error('No eligible wallets in the snapshot.');

  const { getTokenContext } = await import('./holders.js');
  const { sendBatch, announce, notify, getSenderBalanceRaw } = await import('./airdrop.js');

  const ctx = await getTokenContext(cfg);
  const perRaw = humanToRaw(String(cfg.founderDropTokens), ctx.decimals);

  // Hard cold-floor guard at payment time. The 15% pledge is machine-checked.
  const senderRaw = await getSenderBalanceRaw(cfg, ctx);
  const coldFloorRaw = (ctx.supplyRaw * BigInt(cfg.retainedSupplyPercent)) / 100n;
  const spendableRaw = senderRaw > coldFloorRaw ? senderRaw - coldFloorRaw : 0n;
  const need = perRaw * BigInt(wallets.length);
  if (need > spendableRaw) {
    throw new Error(
      `FOUNDER DROP BLOCKED: sending ${rawToHuman(need, ctx.decimals)} would breach the ` +
        `${cfg.retainedSupplyPercent}% cold floor (${rawToHuman(coldFloorRaw, ctx.decimals)} must remain). ` +
        `Spendable above floor: ${rawToHuman(spendableRaw, ctx.decimals)}. Lower the amount.`
    );
  }

  const paid = founderPaidSet(cfg, eventId);
  const toPay = wallets.filter((w) => !paid.has(w));
  if (toPay.length === 0) {
    console.log(`Founder event ${eventId} already fully paid. Nothing to do.`);
    return;
  }

  const allocations = toPay.map((wallet) => ({ wallet, amountRaw: perRaw }));
  console.log(`FOUNDER DROP ${eventId}: paying ${toPay.length} of ${wallets.length} holders ${fmt(String(cfg.founderDropTokens))} each.`);
  const { sent, failed } = await sendBatch(cfg, ctx, date, allocations, 'founder', eventId);

  notify('founder drop', `${sent} holders seeded ${fmt(String(cfg.founderDropTokens))} each, ${failed} failed.`);
  await announce(
    'the founder seed. the base that stayed.',
    `${sent} holders just received ${fmt(String(cfg.founderDropTokens))} $pigeon each. this is a founder distribution from the community wallet, triggered by hand, funded from founder supply, not from the daily curve. the 15% cold reserve is untouched. ${sent} wallets stayed when others sold. this is for them.`
  );
  console.log(`Founder drop complete. Paid: ${sent}. Failed: ${failed}.`);
}
