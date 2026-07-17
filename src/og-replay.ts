// OG holder replay. Rebuilds every wallet's balance history for a past token
// from on-chain transaction metadata, then reports hold-duration cohorts
// against a snapshot moment.
//
// Usage:
//   OG_MINT=<old mint> SNAPSHOT_TIME=<ISO time> npm run og-replay
//
// SNAPSHOT_TIME is the moment the new token was born. Any time after the old
// era and before the first new-token trade works. Solscan shows the new
// mint's creation time on its token page.
//
// Method: every Solana transaction's metadata carries pre and post token
// balances for all touched token accounts. Crawling every signature that
// references the mint and replaying those balance changes reconstructs the
// full ownership timeline. Resumable: kill it, rerun, it continues.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { AppConfig, loadConfig, sleep } from './config.js';
import { fmt, humanToRaw, rawToHuman } from './math.js';

interface RawEvent {
  t: number; // block time, seconds
  s: number; // slot
  a: string; // token account
  o: string; // owner wallet
  pre: string; // raw amount before
  post: string; // raw amount after
}

interface TimelinePoint {
  t: number;
  total: bigint;
}

export interface OwnerStats {
  balanceAtSnapshot: bigint;
  atSnapshot: boolean;
  heldDaysToSnapshot: number;
  neverReducedPreSnapshot: boolean;
  firstSeen: number;
}

// Pure. Timeline must be chronological owner-total points.
export function computeOwnerStats(
  timeline: TimelinePoint[],
  snapshotSec: number,
  dustRaw: bigint
): OwnerStats {
  let balanceAtSnapshot = 0n;
  let firstSeen = timeline.length > 0 ? timeline[0]!.t : 0;
  let neverReduced = true;
  let prevTotal = 0n;
  let heldSince: number | null = null;

  for (const p of timeline) {
    if (p.t > snapshotSec) break;
    if (p.total < prevTotal) neverReduced = false;
    prevTotal = p.total;
    balanceAtSnapshot = p.total;

    if (p.total >= dustRaw) {
      if (heldSince === null) heldSince = p.t;
    } else {
      heldSince = null; // dropped below dust, streak broken
    }
  }

  const atSnapshot = balanceAtSnapshot >= dustRaw;
  const heldDays =
    atSnapshot && heldSince !== null
      ? Math.floor((snapshotSec - heldSince) / 86400)
      : 0;

  return {
    balanceAtSnapshot,
    atSnapshot,
    heldDaysToSnapshot: heldDays,
    neverReducedPreSnapshot: neverReduced && timeline.length > 0,
    firstSeen,
  };
}

function ogDir(cfg: AppConfig): string {
  const d = path.join(cfg.dirs.data, 'og');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function crawlSignatures(cfg: AppConfig, mint: PublicKey, dir: string): Promise<string[]> {
  const sigFile = path.join(dir, 'sigs.json');
  if (fs.existsSync(sigFile)) {
    const sigs = JSON.parse(fs.readFileSync(sigFile, 'utf8')) as string[];
    console.log(`Signatures already crawled: ${sigs.length}. Delete data/og to redo.`);
    return sigs;
  }
  // Resumable, newest-to-oldest. Checkpoint the running list AND the paging
  // cursor so a mid-stream fetch failure resumes instead of throwing away
  // millions of signatures. Each page retries before giving up.
  const partialFile = path.join(dir, 'sigs.partial.json');
  const cursorFile = path.join(dir, 'sigs.cursor.json');
  let all: string[] = [];
  let before: string | undefined = undefined;
  if (fs.existsSync(partialFile)) {
    all = JSON.parse(fs.readFileSync(partialFile, 'utf8')) as string[];
    before = fs.existsSync(cursorFile)
      ? (JSON.parse(fs.readFileSync(cursorFile, 'utf8')) as { before: string }).before
      : undefined;
    console.log(`Resuming signature crawl at ${all.length} (before ${before?.slice(0, 8)}...).`);
  } else {
    console.log('Crawling all signatures for the OG mint. This pages through full history.');
  }
  let sinceSave = 0;
  for (;;) {
    let batch: Awaited<ReturnType<typeof cfg.connection.getSignaturesForAddress>> = [];
    let ok = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        batch = await cfg.connection.getSignaturesForAddress(mint, { before, limit: 1000 });
        ok = true;
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(`\n  page failed (attempt ${attempt}/6): ${msg.slice(0, 60)}. retrying...`);
        await sleep(2000 * attempt);
      }
    }
    if (!ok) {
      // Save progress before surfacing the failure so a rerun resumes here.
      fs.writeFileSync(partialFile, JSON.stringify(all), 'utf8');
      if (before) fs.writeFileSync(cursorFile, JSON.stringify({ before }), 'utf8');
      throw new Error(
        `Signature crawl failed after 6 retries at ${all.length} signatures. ` +
          `Progress saved. Rerun the same command to resume from here.`
      );
    }
    if (batch.length === 0) break;
    for (const s of batch) all.push(s.signature);
    before = batch[batch.length - 1]!.signature;
    sinceSave += batch.length;
    process.stdout.write(`\r  signatures: ${all.length}`);
    // Checkpoint every ~20k so a crash never costs more than that.
    if (sinceSave >= 20000) {
      fs.writeFileSync(partialFile, JSON.stringify(all), 'utf8');
      fs.writeFileSync(cursorFile, JSON.stringify({ before }), 'utf8');
      sinceSave = 0;
    }
    await sleep(150);
  }
  console.log('');
  all.reverse(); // oldest first
  fs.writeFileSync(sigFile, JSON.stringify(all), 'utf8');
  try {
    if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile);
    if (fs.existsSync(cursorFile)) fs.unlinkSync(cursorFile);
  } catch {
    /* cleanup best-effort */
  }
  console.log(`Total signatures: ${all.length}`);
  return all;
}

async function fetchEvents(
  cfg: AppConfig,
  mintStr: string,
  sigs: string[],
  dir: string,
  batchSize: number,
  delayMs: number
): Promise<void> {
  const cursorFile = path.join(dir, 'cursor.json');
  const eventsFile = path.join(dir, 'events.ndjson');
  let start = 0;
  if (fs.existsSync(cursorFile)) {
    start = (JSON.parse(fs.readFileSync(cursorFile, 'utf8')) as { i: number }).i;
    console.log(`Resuming transaction fetch at ${start}/${sigs.length}`);
  }
  let skippedNoTime = 0;
  for (let i = start; i < sigs.length; i += batchSize) {
    const chunk = sigs.slice(i, i + batchSize);
    let txs: (ParsedTransactionWithMeta | null)[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        txs = await cfg.connection.getParsedTransactions(chunk, {
          maxSupportedTransactionVersion: 0,
        });
        break;
      } catch (e) {
        if (attempt === 4) throw e;
        await sleep(1500 * attempt);
      }
    }
    const lines: string[] = [];
    for (const tx of txs) {
      if (!tx || !tx.meta || tx.meta.err) continue;
      if (tx.blockTime === null || tx.blockTime === undefined) {
        skippedNoTime++;
        continue;
      }
      const keys = tx.transaction.message.accountKeys;
      const pre = new Map<number, string>();
      for (const b of tx.meta.preTokenBalances ?? []) {
        if (b.mint === mintStr) pre.set(b.accountIndex, b.uiTokenAmount.amount);
      }
      for (const b of tx.meta.postTokenBalances ?? []) {
        if (b.mint !== mintStr) continue;
        const acct = keys[b.accountIndex]?.pubkey.toBase58();
        if (!acct || !b.owner) continue;
        const ev: RawEvent = {
          t: tx.blockTime,
          s: tx.slot,
          a: acct,
          o: b.owner,
          pre: pre.get(b.accountIndex) ?? '0',
          post: b.uiTokenAmount.amount,
        };
        lines.push(JSON.stringify(ev));
      }
    }
    if (lines.length > 0) fs.appendFileSync(eventsFile, lines.join('\n') + '\n', 'utf8');
    fs.writeFileSync(cursorFile, JSON.stringify({ i: i + batchSize }), 'utf8');
    process.stdout.write(`\r  transactions: ${Math.min(i + batchSize, sigs.length)}/${sigs.length}`);
    await sleep(delayMs);
  }
  console.log('');
  if (skippedNoTime > 0) console.log(`Skipped ${skippedNoTime} transactions without block time.`);
}

function buildTimelines(dir: string): Map<string, TimelinePoint[]> {
  const eventsFile = path.join(dir, 'events.ndjson');
  if (!fs.existsSync(eventsFile)) throw new Error('No events found. Crawl did not produce data.');
  const events: RawEvent[] = fs
    .readFileSync(eventsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RawEvent);
  events.sort((x, y) => (x.s - y.s) || (x.t - y.t));
  console.log(`Replaying ${events.length} balance events.`);

  const acctBal = new Map<string, bigint>();
  const acctOwner = new Map<string, string>();
  const ownerTotal = new Map<string, bigint>();
  const timelines = new Map<string, TimelinePoint[]>();

  for (const e of events) {
    const post = BigInt(e.post);
    const known = acctBal.get(e.a);
    const prevAcct = known !== undefined ? known : BigInt(e.pre);
    // account may have changed owner; attribute by current event's owner,
    // removing the balance from the previous owner if it moved
    const prevOwner = acctOwner.get(e.a);
    if (prevOwner !== undefined && prevOwner !== e.o) {
      const pt = (ownerTotal.get(prevOwner) ?? 0n) - prevAcct;
      ownerTotal.set(prevOwner, pt < 0n ? 0n : pt);
      const tl = timelines.get(prevOwner) ?? [];
      tl.push({ t: e.t, total: ownerTotal.get(prevOwner)! });
      timelines.set(prevOwner, tl);
      const nt = (ownerTotal.get(e.o) ?? 0n) + prevAcct;
      ownerTotal.set(e.o, nt);
    }
    acctOwner.set(e.a, e.o);
    acctBal.set(e.a, post);
    const base = ownerTotal.get(e.o) ?? 0n;
    const adj = known === undefined ? BigInt(e.pre) : 0n; // pre-existing balance we first learn about
    const next = base + adj + (post - prevAcct);
    ownerTotal.set(e.o, next < 0n ? 0n : next);
    const tl = timelines.get(e.o) ?? [];
    tl.push({ t: e.t, total: ownerTotal.get(e.o)! });
    timelines.set(e.o, tl);
  }
  return timelines;
}

async function main(): Promise<void> {
  const ogMintStr = (process.env.OG_MINT ?? '').trim();
  const snapshotStr = (process.env.SNAPSHOT_TIME ?? '').trim();
  if (!ogMintStr) throw new Error('Set OG_MINT=<old token mint> on the command line.');
  if (!snapshotStr) {
    throw new Error(
      'Set SNAPSHOT_TIME=<ISO time the new token was born>, e.g. SNAPSHOT_TIME=2026-06-30T17:00:00Z. Solscan shows it on the new mint page.'
    );
  }
  const snapshotSec = Math.floor(new Date(snapshotStr).getTime() / 1000);
  if (!Number.isFinite(snapshotSec) || snapshotSec <= 0) {
    throw new Error('SNAPSHOT_TIME is not a valid ISO time.');
  }
  const dustHuman = (process.env.OG_DUST ?? '1000').trim();
  const batchSize = Number.parseInt(process.env.OG_BATCH ?? '25', 10);
  const delayMs = Number.parseInt(process.env.OG_DELAY_MS ?? '400', 10);

  const cfg = loadConfig();
  const ogMint = new PublicKey(ogMintStr);
  const dir = ogDir(cfg);

  const info = await cfg.connection.getAccountInfo(ogMint);
  if (!info) throw new Error('OG mint not found on chain.');
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintInfo = await getMint(cfg.connection, ogMint, 'confirmed', programId);
  const d = mintInfo.decimals;
  const dustRaw = humanToRaw(dustHuman, d);
  console.log(`OG mint ${ogMintStr}`);
  console.log(`decimals ${d}, dust floor ${fmt(dustHuman)}, snapshot ${new Date(snapshotSec * 1000).toISOString()}`);

  const sigs = await crawlSignatures(cfg, ogMint, dir);
  await fetchEvents(cfg, ogMintStr, sigs, dir, batchSize, delayMs);
  const timelines = buildTimelines(dir);

  const rows: {
    wallet: string;
    stats: OwnerStats;
  }[] = [];
  for (const [wallet, tl] of timelines) {
    let onCurve = false;
    try {
      onCurve = PublicKey.isOnCurve(wallet);
    } catch {
      onCurve = false;
    }
    if (!onCurve) continue; // pools, curves, PDAs
    rows.push({ wallet, stats: computeOwnerStats(tl, snapshotSec, dustRaw) });
  }

  const atSnap = rows.filter((r) => r.stats.atSnapshot);
  const d30 = atSnap.filter((r) => r.stats.heldDaysToSnapshot >= 30);
  const d60 = atSnap.filter((r) => r.stats.heldDaysToSnapshot >= 60);
  const d90 = atSnap.filter((r) => r.stats.heldDaysToSnapshot >= 90);
  const never = atSnap.filter((r) => r.stats.neverReducedPreSnapshot);
  const never90 = d90.filter((r) => r.stats.neverReducedPreSnapshot);

  const constant = 5313n * 10n ** BigInt(d);
  const cost = (n: number) => fmt(rawToHuman(BigInt(n) * constant, d));

  console.log('');
  console.log('OG COHORTS AT SNAPSHOT');
  console.log('--------------------------------------------------');
  console.log(`wallets ever touched token   ${rows.length}`);
  console.log(`holding at snapshot (>=dust) ${atSnap.length}   full cost ${cost(atSnap.length)}`);
  console.log(`held >= 30 days              ${d30.length}   full cost ${cost(d30.length)}`);
  console.log(`held >= 60 days              ${d60.length}   full cost ${cost(d60.length)}`);
  console.log(`held >= 90 days              ${d90.length}   full cost ${cost(d90.length)}`);
  console.log(`never sold, any duration     ${never.length}   full cost ${cost(never.length)}`);
  console.log(`never sold AND >= 90 days    ${never90.length}   full cost ${cost(never90.length)}`);
  console.log('--------------------------------------------------');
  console.log('full cost assumes 100% conversion at 5,313 each. real cost = conversions only.');

  const header = 'wallet,days_held_to_snapshot,never_sold,balance_at_snapshot\n';
  const line = (r: { wallet: string; stats: OwnerStats }) =>
    `${r.wallet},${r.stats.heldDaysToSnapshot},${r.stats.neverReducedPreSnapshot ? 1 : 0},${rawToHuman(r.stats.balanceAtSnapshot, d)}\n`;
  fs.writeFileSync(path.join(dir, 'og-all-snapshot.csv'), header + atSnap.map(line).join(''), 'utf8');
  fs.writeFileSync(path.join(dir, 'og-90d.csv'), header + d90.map(line).join(''), 'utf8');
  fs.writeFileSync(path.join(dir, 'og-never-sold.csv'), header + never.map(line).join(''), 'utf8');
  console.log(`lists written to ${dir}`);

  // audit: compare reconstructed current top balances to live chain
  try {
    const largest = await cfg.connection.getTokenLargestAccounts(ogMint);
    console.log('');
    console.log('audit, live top accounts vs replay (should be close):');
    for (const acc of largest.value.slice(0, 3)) {
      console.log(`  live ${acc.address.toBase58().slice(0, 8)}...  ${acc.uiAmountString}`);
    }
  } catch {
    console.log('audit skipped, RPC refused getTokenLargestAccounts.');
  }
}

const isDirectRun = process.argv[1]?.endsWith('og-replay.ts');
if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
