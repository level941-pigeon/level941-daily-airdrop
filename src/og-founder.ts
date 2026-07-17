// OG founder seed. Same mechanism as founder.ts: sendBatch, type 'founder'
// (excluded from curve accounting), idempotent by event id, hard-guarded
// against the cold floor. The only difference is the recipient source:
// instead of today's daily qualifying snapshot of the live mint, recipients
// come from data/og/og-live-holders.csv, the Helius DAS live-holder pull of
// the OLD mint. Run npm run og-holders first to (re)generate that file.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { AppConfig, todayStr } from './config.js';
import { readCsv, TokenContext } from './holders.js';
import { fmt, humanToRaw, rawToHuman } from './math.js';
import { founderPaidSet } from './founder.js';

interface OgRecipient {
  wallet: string;
  ogBalance: string;
}

function floorFromEnv(): number {
  const raw = (process.env.OG_FOUNDER_FLOOR ?? '10000').trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`OG_FOUNDER_FLOOR must be a non-negative number. Got: ${raw}`);
  }
  return n;
}

function ogRecipients(cfg: AppConfig, floorHuman: number): OgRecipient[] {
  const file = path.join(cfg.dirs.data, 'og', 'og-live-holders.csv');
  if (!fs.existsSync(file)) {
    throw new Error(`No OG holder pull found at ${file}. Run: npm run og-holders`);
  }
  const seen = new Set<string>();
  const out: OgRecipient[] = [];
  for (const r of readCsv(file)) {
    const wallet = r.wallet as string;
    if (!wallet || seen.has(wallet)) continue;
    if (r.on_curve !== '1') continue;
    if (cfg.excludedWallets.has(wallet)) continue;
    const balance = Number.parseFloat(r.balance ?? '0');
    if (!Number.isFinite(balance) || balance < floorHuman) continue;
    seen.add(wallet);
    out.push({ wallet, ogBalance: r.balance as string });
  }
  return out;
}

// Grounds the SOL estimate in reality instead of guessing at compute-unit
// defaults: samples one already-confirmed transfer's exact fee and one
// already-created ATA's exact rent from this wallet's own ledger, for this
// same mint. Token-2022 account size (and therefore rent) depends on the
// mint's extensions, so a measured sample beats a formula.
interface SampleLogEntry {
  status?: string;
  signature?: string;
  wallet?: string;
  mint?: string;
}

async function sampleFeeAndRent(
  cfg: AppConfig,
  ctx: TokenContext
): Promise<{ feeLamports: number; rentLamports: number } | null> {
  if (!fs.existsSync(cfg.dirs.logs)) return null;
  const mintStr = cfg.mint.toBase58();
  for (const f of fs.readdirSync(cfg.dirs.logs)) {
    if (!f.endsWith('-sent-log.json')) continue;
    for (const line of fs.readFileSync(path.join(cfg.dirs.logs, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let e: SampleLogEntry | null = null;
      try {
        e = JSON.parse(line) as SampleLogEntry;
      } catch {
        continue;
      }
      if (!e || e.status !== 'confirmed' || !e.signature || !e.wallet) continue;
      if ((e.mint ?? mintStr) !== mintStr) continue;
      const tx = await cfg.connection.getParsedTransaction(e.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const ata = getAssociatedTokenAddressSync(cfg.mint, new PublicKey(e.wallet), true, ctx.programId);
      const info = await cfg.connection.getAccountInfo(ata);
      if (!info) continue;
      const rentLamports = await cfg.connection.getMinimumBalanceForRentExemption(info.data.length);
      return { feeLamports: tx.meta.fee, rentLamports };
    }
  }
  return null;
}

interface SolEstimate {
  feeLamportsPerTx: number;
  rentLamportsPerNewAta: number;
  newAtaCount: number;
  existingAtaCount: number;
  totalLamports: bigint;
  senderSolLamports: number;
}

async function estimateSolCost(cfg: AppConfig, ctx: TokenContext, wallets: string[]): Promise<SolEstimate | null> {
  const sample = await sampleFeeAndRent(cfg, ctx);
  if (!sample) return null;

  const atas = wallets.map((w) => getAssociatedTokenAddressSync(cfg.mint, new PublicKey(w), true, ctx.programId));
  let existingAtaCount = 0;
  const chunkSize = 100;
  for (let i = 0; i < atas.length; i += chunkSize) {
    const chunk = atas.slice(i, i + chunkSize);
    const infos = await cfg.connection.getMultipleAccountsInfo(chunk);
    for (const info of infos) if (info) existingAtaCount++;
  }
  const newAtaCount = wallets.length - existingAtaCount;

  const totalLamports =
    BigInt(wallets.length) * BigInt(sample.feeLamports) + BigInt(newAtaCount) * BigInt(sample.rentLamports);
  const senderSolLamports = await cfg.connection.getBalance(cfg.keypair.publicKey);

  return {
    feeLamportsPerTx: sample.feeLamports,
    rentLamportsPerNewAta: sample.rentLamports,
    newAtaCount,
    existingAtaCount,
    totalLamports,
    senderSolLamports,
  };
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const sol = (lamports: bigint | number): string => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

export async function runOgFounderPreview(cfg: AppConfig): Promise<void> {
  const floor = floorFromEnv();
  const recipients = ogRecipients(cfg, floor);

  const { getTokenContext } = await import('./holders.js');
  const { getSenderBalanceRaw } = await import('./airdrop.js');

  const ctx = await getTokenContext(cfg);
  const perRaw = humanToRaw(String(cfg.founderDropTokens), ctx.decimals);
  const total = perRaw * BigInt(recipients.length);

  const senderRaw = await getSenderBalanceRaw(cfg, ctx);
  const coldFloorRaw = (ctx.supplyRaw * cfg.retainedSupplyPercent) / 100n;
  const spendableRaw = senderRaw > coldFloorRaw ? senderRaw - coldFloorRaw : 0n;

  console.log('');
  console.log('OG FOUNDER SEED preview');
  console.log('--------------------------------------------------');
  console.log('source                  data/og/og-live-holders.csv (Helius DAS live pull of the OLD mint)');
  console.log(`dust floor              >= ${fmt(String(floor))} old-token balance (OG_FOUNDER_FLOOR)`);
  console.log(`recipients              ${recipients.length} wallets`);
  console.log(`each receives           ${fmt(String(cfg.founderDropTokens))} $pigeon (new mint)`);
  console.log(`total to send           ${fmt(rawToHuman(total, ctx.decimals))}`);
  console.log(`sender holds            ${fmt(rawToHuman(senderRaw, ctx.decimals))}`);
  console.log(`cold floor (${cfg.retainedSupplyPercent}%)         ${fmt(rawToHuman(coldFloorRaw, ctx.decimals))} must remain`);
  console.log(`spendable above floor   ${fmt(rawToHuman(spendableRaw, ctx.decimals))}`);
  console.log('--------------------------------------------------');
  if (total > spendableRaw) {
    console.log('BLOCKED: this drop would cut into the cold floor. Raise OG_FOUNDER_FLOOR or lower FOUNDER_DROP_TOKENS.');
  } else {
    console.log('OK: fits above the cold floor. This is a founder distribution, not box emission.');
  }
  console.log('--------------------------------------------------');

  const solEstimate = await estimateSolCost(cfg, ctx, recipients.map((r) => r.wallet));
  if (solEstimate) {
    console.log('SOL cost estimate (measured from a real confirmed transfer on this mint):');
    console.log(`  wallets needing a new token account   ${solEstimate.newAtaCount}`);
    console.log(`  wallets with an existing token account ${solEstimate.existingAtaCount}`);
    console.log(`  tx fee per transfer                   ${solEstimate.feeLamportsPerTx} lamports`);
    console.log(`  rent per new token account             ${solEstimate.rentLamportsPerNewAta} lamports`);
    console.log(`  estimated total SOL cost               ${sol(solEstimate.totalLamports)} SOL`);
    console.log(`  sender SOL balance                     ${sol(solEstimate.senderSolLamports)} SOL`);
    if (BigInt(solEstimate.senderSolLamports) < solEstimate.totalLamports) {
      console.log('  BLOCKED: sender does not hold enough SOL to cover this batch.');
    } else {
      console.log('  OK: sender SOL balance covers the estimated cost.');
    }
  } else {
    console.log('SOL cost estimate: no prior confirmed transfer on this mint to sample fee/rent from.');
    console.log('Cannot ground an estimate. Run a small test send first, or estimate manually.');
  }
  console.log('--------------------------------------------------');
  console.log('');
  console.log('First 20 recipients:');
  for (const r of recipients.slice(0, 20)) {
    console.log(`  ${r.wallet}  (old balance ${fmt(r.ogBalance)})`);
  }
  if (recipients.length > 20) console.log(`  ... and ${recipients.length - 20} more`);

  const outFile = path.join(cfg.dirs.data, 'og', 'og-founder-recipients.csv');
  const lines = ['wallet,old_balance'];
  for (const r of recipients) lines.push(`${r.wallet},${r.ogBalance}`);
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');
  console.log('');
  console.log(`Full recipient list written: ${outFile}`);
  console.log('Nothing was sent. Review the list, then run og-founder-pay with an OG_FOUNDER_EVENT_ID to send.');
}

export async function runOgFounderPay(cfg: AppConfig): Promise<void> {
  const eventId = process.env.OG_FOUNDER_EVENT_ID?.trim();
  if (!eventId) {
    throw new Error(
      'Set OG_FOUNDER_EVENT_ID, e.g. OG_FOUNDER_EVENT_ID=2026-07-13-og-founder-seed npm run og-founder-pay'
    );
  }
  const floor = floorFromEnv();
  const recipients = ogRecipients(cfg, floor);
  if (recipients.length === 0) throw new Error('No eligible OG wallets at this floor.');

  const { getTokenContext } = await import('./holders.js');
  const { sendBatch, announce, notify, getSenderBalanceRaw } = await import('./airdrop.js');

  const ctx = await getTokenContext(cfg);
  const perRaw = humanToRaw(String(cfg.founderDropTokens), ctx.decimals);

  // Hard cold-floor guard at payment time, same as founder.ts.
  const senderRaw = await getSenderBalanceRaw(cfg, ctx);
  const coldFloorRaw = (ctx.supplyRaw * cfg.retainedSupplyPercent) / 100n;
  const spendableRaw = senderRaw > coldFloorRaw ? senderRaw - coldFloorRaw : 0n;
  const need = perRaw * BigInt(recipients.length);
  if (need > spendableRaw) {
    throw new Error(
      `OG FOUNDER SEED BLOCKED: sending ${rawToHuman(need, ctx.decimals)} would breach the ` +
        `${cfg.retainedSupplyPercent}% cold floor (${rawToHuman(coldFloorRaw, ctx.decimals)} must remain). ` +
        `Spendable above floor: ${rawToHuman(spendableRaw, ctx.decimals)}.`
    );
  }

  const paid = founderPaidSet(cfg, eventId);
  const toPay = recipients.filter((r) => !paid.has(r.wallet));
  if (toPay.length === 0) {
    console.log(`OG founder event ${eventId} already fully paid. Nothing to do.`);
    return;
  }

  const date = todayStr();
  const allocations = toPay.map((r) => ({ wallet: r.wallet, amountRaw: perRaw }));
  console.log(
    `OG FOUNDER SEED ${eventId}: paying ${toPay.length} of ${recipients.length} OG holders ${fmt(String(cfg.founderDropTokens))} each.`
  );
  const { sent, failed } = await sendBatch(cfg, ctx, date, allocations, 'founder', eventId);

  notify('OG founder seed', `${sent} OG holders seeded ${fmt(String(cfg.founderDropTokens))} each, ${failed} failed.`);
  await announce(
    'the OG seed.',
    `${sent} wallets that held the original token just received ${fmt(String(cfg.founderDropTokens))} $pigeon each. a founder distribution to the OG base, funded from founder supply, not the daily curve.`
  );
  console.log(`OG founder seed complete. Paid: ${sent}. Failed: ${failed}.`);
}
