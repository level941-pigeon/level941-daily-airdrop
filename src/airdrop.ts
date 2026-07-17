import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { AppConfig, sleep, todayStr } from './config.js';
import { TokenContext, getTokenContext, readCsv, runSnapshot, writeCsv } from './holders.js';
import {
  HolderWeight,
  computeAllocations,
  computeDailyAirdrop,
  fmt,
  humanToRaw,
  inSellerTimeout,
  rawToHuman,
} from './math.js';

export interface SentEntry {
  date: string;
  wallet: string;
  amount: string;
  amount_raw: string;
  signature: string;
  status: 'confirmed';
  type: 'test' | 'daily' | 'sweep' | 'bridge' | 'draw' | 'loyalty' | 'founder';
  event_id?: string;
  mint?: string; // absent on old entries, which are all the main token
  ts: string;
}

interface Allocation {
  wallet: string;
  amountRaw: bigint;
}

// ---------- logs ----------

function sentLogPath(cfg: AppConfig, date: string): string {
  return path.join(cfg.dirs.logs, `${date}-sent-log.json`);
}

function failedCsvPath(cfg: AppConfig, date: string): string {
  return path.join(cfg.dirs.logs, `${date}-failed.csv`);
}

// Sent logs are JSON lines: one JSON object per line, appended after every
// confirmed transfer. Append only, so a crash never loses a confirmed send
// and a rerun never double-sends.
function readSentEntries(cfg: AppConfig, date: string): SentEntry[] {
  const file = sentLogPath(cfg, date);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as SentEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is SentEntry => e !== null);
}

export function sentSetForMint(cfg: AppConfig, date: string, mint: string): Set<string> {
  const set = new Set<string>();
  const main = cfg.mint.toBase58();
  for (const e of readSentEntries(cfg, date)) {
    if ((e.mint ?? main) === mint) set.add(e.wallet);
  }
  return set;
}

function appendSentEntry(cfg: AppConfig, entry: SentEntry): void {
  fs.appendFileSync(sentLogPath(cfg, entry.date), JSON.stringify(entry) + '\n', 'utf8');
}

function appendFailed(cfg: AppConfig, date: string, wallet: string, amount: string, err: string): void {
  const file = failedCsvPath(cfg, date);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, 'wallet,amount,error\n', 'utf8');
  }
  const clean = err.replace(/[\r\n,]+/g, ' ').slice(0, 300);
  fs.appendFileSync(file, `${wallet},${amount},${clean}\n`, 'utf8');
}

// Total already distributed, derived from every sent log on disk.
// Test sends are real token movements and count.
export function sumDistributed(cfg: AppConfig): bigint {
  if (!fs.existsSync(cfg.dirs.logs)) return 0n;
  let total = 0n;
  for (const f of fs.readdirSync(cfg.dirs.logs)) {
    if (!f.endsWith('-sent-log.json')) continue;
    const date = f.replace('-sent-log.json', '');
    const mainMint = cfg.mint.toBase58();
    for (const e of readSentEntries(cfg, date)) {
      if (e.status !== 'confirmed') continue;
      if ((e.mint ?? mainMint) !== mainMint) continue; // sweeps of other tokens never count against the pool
      if (e.type === 'draw') continue; // draws pay from buyback float, not the curve
      if (e.type === 'founder') continue; // founder distributions are not box emission
      total += BigInt(e.amount_raw);
    }
  }
  return total;
}

function updateSummary(cfg: AppConfig, decimals: number): void {
  const dates: string[] = [];
  if (fs.existsSync(cfg.dirs.logs)) {
    for (const f of fs.readdirSync(cfg.dirs.logs)) {
      if (f.endsWith('-sent-log.json')) dates.push(f.replace('-sent-log.json', ''));
    }
  }
  dates.sort();
  const totalRaw = sumDistributed(cfg);
  const summary = {
    token_mint: cfg.mint.toBase58(),
    total_distributed_tokens: rawToHuman(totalRaw, decimals),
    total_distributed_raw: totalRaw.toString(),
    dates_run: dates,
    last_run_date: dates.length > 0 ? dates[dates.length - 1] : null,
    notes: 'Totals are derived from per-date sent logs. Test sends are included.',
  };
  fs.writeFileSync(
    path.join(cfg.dirs.logs, 'distribution-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
    'utf8'
  );
}

// ---------- allocations ----------

function allocationsPath(cfg: AppConfig, date: string): string {
  return path.join(cfg.dirs.allocations, `${date}-allocations.csv`);
}

function loadAllocations(cfg: AppConfig, date: string): Allocation[] {
  const file = allocationsPath(cfg, date);
  if (!fs.existsSync(file)) {
    throw new Error(`No allocations for ${date}. Run: npm run preview`);
  }
  return readCsv(file)
    .filter((r) => r.wallet && r.amount_raw)
    .map((r) => ({ wallet: r.wallet as string, amountRaw: BigInt(r.amount_raw as string) }));
}

export async function getSenderBalanceRaw(cfg: AppConfig, ctx: TokenContext): Promise<bigint> {
  const senderAta = getAssociatedTokenAddressSync(
    cfg.mint,
    cfg.keypair.publicKey,
    false,
    ctx.programId
  );
  try {
    const acct = await getAccount(cfg.connection, senderAta, 'confirmed', ctx.programId);
    return acct.amount;
  } catch {
    return 0n;
  }
}

// ---------- preview ----------

export async function runPreview(cfg: AppConfig): Promise<void> {
  const date = todayStr();

  // One allocation set per date, frozen at the first send. Regenerating
  // after a send would add intra-day buyers to a day that already paid.
  const sentToday = readSentEntries(cfg, date);
  if (sentToday.length > 0) {
    console.log(`Allocations for ${date} are frozen: ${sentToday.length} transfers already sent today.`);
    console.log(`Existing file: ${allocationsPath(cfg, date)}`);
    console.log('Wallets that qualified after the freeze enter at the next daily run.');
    return;
  }

  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying holder snapshot for ${date}. Run: npm run snapshot`);
  }
  const allQualifying = readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .map((r) => ({
      wallet: r.wallet as string,
      balanceRaw: BigInt(r.balance_raw as string),
      streak: Math.max(1, Number.parseInt(r.streak ?? '1', 10) || 1),
      lastReduced: (r.last_reduced ?? '') as string,
    }));
  // Sellers in timeout still count toward the curve, they hold. They just
  // receive nothing, and their share pays the wallets that did not flinch.
  const holders: HolderWeight[] = allQualifying
    .filter((h) => !inSellerTimeout(h.lastReduced || undefined, date, cfg.sellerTimeoutDays))
    .map(({ wallet, balanceRaw, streak }) => ({ wallet, balanceRaw, streak }));
  const timedOut = allQualifying.length - holders.length;

  if (cfg.scheduledDripHuman === '') {
    throw new Error('SCHEDULED_DAILY_DRIP_AMOUNT is not set in .env');
  }

  const ctx = await getTokenContext(cfg);
  const senderBalanceRaw = await getSenderBalanceRaw(cfg, ctx);
  const totalDistributedRaw = sumDistributed(cfg);
  const scheduledDripRaw = humanToRaw(cfg.scheduledDripHuman, ctx.decimals);

  // Pending OG converts' unlocks are spoken for. The drip must not spend
  // what the bridge owes, so the reserve counts as already distributed.
  const { bridgeReserveRaw } = await import('./bridge.js');
  const reserveRaw = bridgeReserveRaw(cfg, date, ctx.decimals);

  const r = computeDailyAirdrop({
    totalSupplyRaw: ctx.supplyRaw,
    qualifyingHolderCount: allQualifying.length,
    holderGoal: cfg.holderGoal,
    totalDistributedRaw: totalDistributedRaw + reserveRaw,
    senderBalanceRaw,
    scheduledDailyDripRaw: scheduledDripRaw,
    retainedSupplyPercent: cfg.retainedSupplyPercent,
    maxAirdropPoolPercent: cfg.maxAirdropPoolPercent,
  });

  const rawAllocations = computeAllocations(
    r.dailyAirdropRaw,
    holders,
    cfg.distributionMode,
    cfg.streakCap,
    cfg.streakExponent
  );

  // Dust floor. Below-floor allocations are dropped here, before the CSV is
  // written, so they are never sent and never logged. sumDistributed only
  // counts confirmed sends, so this dust is simply never subtracted from
  // the unlocked pool: it stays in headroom for a future day automatically,
  // no separate accounting needed.
  const d = ctx.decimals;
  const minSendRaw = humanToRaw(String(cfg.dailyMinSendTokens), d);
  const allocations = rawAllocations.filter((a) => a.amountRaw >= minSendRaw);
  const dustSkipped = rawAllocations.length - allocations.length;
  const dustSkippedRaw = rawAllocations
    .filter((a) => a.amountRaw < minSendRaw)
    .reduce((acc, a) => acc + a.amountRaw, 0n);
  const totalToSendRaw = allocations.reduce((acc, a) => acc + a.amountRaw, 0n);

  const h = (v: bigint) => fmt(rawToHuman(v, d));

  console.log('');
  console.log(`Preview for ${date}`);
  console.log('--------------------------------------------------');
  console.log(`token mint             ${cfg.mint.toBase58()}`);
  console.log(`token program          ${ctx.programName}`);
  console.log(`total supply           ${h(ctx.supplyRaw)}`);
  console.log(`decimals               ${d}`);
  console.log(`sender wallet          ${cfg.keypair.publicKey.toBase58()}`);
  console.log(`sender balance         ${h(senderBalanceRaw)}`);
  console.log('--------------------------------------------------');
  console.log(`qualifying holders     ${allQualifying.length}`);
  console.log(`sellers timed out      ${timedOut} (no bread for ${cfg.sellerTimeoutDays} days after a balance drop)`);
  console.log(`receiving today        ${holders.length}`);
  console.log(`holder goal            ${cfg.holderGoal}`);
  console.log(`max airdrop pool       ${h(r.maxAirdropPoolRaw)} (${cfg.maxAirdropPoolPercent}%)`);
  console.log(`retained floor         ${h(r.retainedFloorRaw)} (${cfg.retainedSupplyPercent}%)`);
  console.log(`unlocked pool          ${h(r.unlockedPoolRaw)}`);
  console.log(`already distributed    ${h(totalDistributedRaw)}`);
  if (reserveRaw > 0n) {
    console.log(`bridge reserve         ${h(reserveRaw)} (held for pending OG converts)`);
  }
  console.log(`available today        ${h(r.availableTodayRaw)}`);
  console.log(`scheduled daily drip   ${h(scheduledDripRaw)}`);
  console.log('--------------------------------------------------');
  console.log(
    `distribution mode      ${cfg.distributionMode}${cfg.distributionMode === 'streak' ? ` (cap ${cfg.streakCap}x, exponent ${cfg.streakExponent})` : ''}`
  );
  console.log(`daily airdrop amount   ${h(r.dailyAirdropRaw)}`);
  console.log(`wallets receiving      ${allocations.length}`);
  if (dustSkipped > 0) {
    console.log(`skipped below floor    ${dustSkipped} wallets, ${h(dustSkippedRaw)} (below ${fmt(String(cfg.dailyMinSendTokens))}, stays in the pool)`);
  }
  console.log(`total to send          ${h(totalToSendRaw)}`);
  if (allocations.length > 0) {
    const amounts = allocations.map((a) => a.amountRaw);
    const maxA = amounts.reduce((a, b) => (b > a ? b : a));
    const minA = amounts.reduce((a, b) => (b < a ? b : a));
    const topShare = totalToSendRaw > 0n ? Number((maxA * 10000n) / totalToSendRaw) / 100 : 0;
    console.log(`largest allocation     ${h(maxA)} (${topShare}% of today)`);
    console.log(`smallest allocation    ${h(minA)}`);
  }
  console.log('--------------------------------------------------');

  const file = allocationsPath(cfg, date);
  writeCsv(
    file,
    ['wallet', 'amount_raw', 'amount'],
    allocations.map((a) => [a.wallet, a.amountRaw.toString(), rawToHuman(a.amountRaw, d)])
  );
  console.log(`allocations file       ${file}`);

  const reason =
    r.reason ?? (allocations.length === 0 ? 'daily amount is too small to allocate' : null);
  if (reason) {
    console.log('');
    console.log(`Nothing to send: ${reason}.`);
    return;
  }

  console.log('');
  console.log('Nothing was sent. This is a preview.');
  console.log('Next: npm run test-send');
}

// ---------- send engine ----------

export async function sendBatch(
  cfg: AppConfig,
  ctx: TokenContext,
  date: string,
  recipients: Allocation[],
  type: 'test' | 'daily' | 'sweep' | 'bridge' | 'draw' | 'loyalty' | 'founder',
  eventId?: string,
  mintOverride?: PublicKey
): Promise<{ sent: number; failed: number }> {
  const mint = mintOverride ?? cfg.mint;
  const senderAta = getAssociatedTokenAddressSync(
    mint,
    cfg.keypair.publicKey,
    false,
    ctx.programId
  );

  let sent = 0;
  let failed = 0;
  const maxAttempts = 3;

  for (let i = 0; i < recipients.length; i++) {
    const { wallet, amountRaw } = recipients[i]!;
    const owner = new PublicKey(wallet);
    const recipientAta = getAssociatedTokenAddressSync(mint, owner, true, ctx.programId);
    const amountHuman = rawToHuman(amountRaw, ctx.decimals);

    let confirmed = false;
    let lastError = '';

    for (let attempt = 1; attempt <= maxAttempts && !confirmed; attempt++) {
      try {
        const tx = new Transaction();
        if (cfg.priorityFeeMicroLamports > 0) {
          tx.add(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: cfg.priorityFeeMicroLamports,
            })
          );
        }
        tx.add(
          createAssociatedTokenAccountIdempotentInstruction(
            cfg.keypair.publicKey,
            recipientAta,
            owner,
            mint,
            ctx.programId
          )
        );
        tx.add(
          createTransferCheckedInstruction(
            senderAta,
            mint,
            recipientAta,
            cfg.keypair.publicKey,
            amountRaw,
            ctx.decimals,
            [],
            ctx.programId
          )
        );

        const signature = await sendAndConfirmTransaction(cfg.connection, tx, [cfg.keypair], {
          commitment: 'confirmed',
        });

        appendSentEntry(cfg, {
          date,
          wallet,
          amount: amountHuman,
          amount_raw: amountRaw.toString(),
          signature,
          status: 'confirmed',
          type,
          event_id: eventId,
          mint: mint.toBase58(),
          ts: new Date().toISOString(),
        });

        confirmed = true;
        sent++;
        console.log(`[${i + 1}/${recipients.length}] sent ${amountHuman} to ${wallet} sig ${signature}`);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        if (attempt < maxAttempts) {
          console.log(
            `[${i + 1}/${recipients.length}] attempt ${attempt} failed for ${wallet}, retrying`
          );
          await sleep(1000 * attempt);
        }
      }
    }

    if (!confirmed) {
      failed++;
      appendFailed(cfg, date, wallet, amountHuman, lastError);
      console.log(`[${i + 1}/${recipients.length}] FAILED ${wallet}: ${lastError.slice(0, 120)}`);
    }

    if (cfg.sendDelayMs > 0 && i < recipients.length - 1) {
      await sleep(cfg.sendDelayMs);
    }
  }

  updateSummary(cfg, ctx.decimals);
  return { sent, failed };
}

// ---------- test-send ----------

export async function runTestSend(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const allocations = loadAllocations(cfg, date);
  if (allocations.length === 0) {
    throw new Error('Allocations file is empty. Run npm run preview and check the output.');
  }

  const alreadySent = sentSetForMint(cfg, date, cfg.mint.toBase58());
  const targets = allocations.filter((a) => !alreadySent.has(a.wallet)).slice(0, 3);

  if (targets.length === 0) {
    console.log(`The first wallets for ${date} were already sent. Nothing to test.`);
    return;
  }

  const ctx = await getTokenContext(cfg);
  console.log('');
  console.log('TEST SEND. Real transfers to the first 3 qualifying wallets only.');
  console.log(`token mint     ${cfg.mint.toBase58()}`);
  console.log(`token program  ${ctx.programName}`);
  console.log(`sender wallet  ${cfg.keypair.publicKey.toBase58()}`);
  for (const t of targets) {
    console.log(`  ${t.wallet}  ${fmt(rawToHuman(t.amountRaw, ctx.decimals))}`);
  }
  console.log('');

  const { sent, failed } = await sendBatch(cfg, ctx, date, targets, 'test');

  console.log('');
  console.log(`Test complete. Sent: ${sent}. Failed: ${failed}.`);
  console.log(`Signatures logged in ${sentLogPath(cfg, date)}`);
  console.log('Verify the transfers on a Solana explorer before running send-daily.');
}

// ---------- send-daily ----------

function askConfirm(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question('Type CONFIRM to send, anything else aborts: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

export async function runSendDaily(cfg: AppConfig, skipConfirm = false): Promise<void> {
  const date = todayStr();
  const allocations = loadAllocations(cfg, date);
  if (allocations.length === 0) {
    throw new Error('Allocations file is empty. Run npm run preview and check the output.');
  }

  const alreadySent = sentSetForMint(cfg, date, cfg.mint.toBase58());
  const remaining = allocations.filter((a) => !alreadySent.has(a.wallet));

  if (remaining.length === 0) {
    console.log(`Every allocated wallet for ${date} has already been sent. Nothing to do.`);
    return;
  }

  const ctx = await getTokenContext(cfg);
  const senderBalanceRaw = await getSenderBalanceRaw(cfg, ctx);
  const retainedFloorRaw = (ctx.supplyRaw * cfg.retainedSupplyPercent) / 100n;
  const totalToSendRaw = remaining.reduce((acc, a) => acc + a.amountRaw, 0n);
  const balanceAfterRaw = senderBalanceRaw - totalToSendRaw;

  const h = (v: bigint) => fmt(rawToHuman(v, ctx.decimals));

  console.log('');
  console.log('FINAL WARNING. This sends real tokens.');
  console.log('--------------------------------------------------');
  console.log(`token mint          ${cfg.mint.toBase58()}`);
  console.log(`token program       ${ctx.programName}`);
  console.log(`sender wallet       ${cfg.keypair.publicKey.toBase58()}`);
  console.log(`recipients          ${remaining.length} (${alreadySent.size} already sent for ${date})`);
  console.log(`total to send       ${h(totalToSendRaw)}`);
  console.log(`sender balance      ${h(senderBalanceRaw)}`);
  console.log(`balance after send  ${h(balanceAfterRaw < 0n ? 0n : balanceAfterRaw)}`);
  console.log(`retained floor      ${h(retainedFloorRaw)}`);
  console.log('--------------------------------------------------');

  // Live floor check against the current on-chain balance, not the preview.
  if (balanceAfterRaw < retainedFloorRaw) {
    throw new Error(
      'Aborted. Sending this batch would take the sender balance below the retained supply floor. Rerun npm run preview.'
    );
  }
  console.log('floor check         OK');
  console.log('');

  if (skipConfirm) {
    console.log('AUTO MODE. Guards passed, confirmation skipped.');
  } else {
    const answer = await askConfirm();
    if (answer !== 'CONFIRM') {
      console.log('Aborted. Nothing was sent.');
      return;
    }
  }

  console.log('');
  const { sent, failed } = await sendBatch(cfg, ctx, date, remaining, 'daily');

  console.log('');
  console.log(`Daily send complete. Sent: ${sent}. Failed: ${failed}.`);
  console.log(`Sent log:    ${sentLogPath(cfg, date)}`);
  if (failed > 0) {
    console.log(`Failed CSV:  ${failedCsvPath(cfg, date)}`);
    console.log('Rerun npm run send-daily to retry failed wallets. Sent wallets are skipped.');
  }
  console.log(`Summary:     ${path.join(cfg.dirs.logs, 'distribution-summary.json')}`);
}

// ---------- send-auto ----------

// Desktop notification plus optional Discord webhook, so the machine
// reports to the phone. Both fire-and-forget, both silent on failure.
let webhookUrl = '';
let publicWebhookUrl = '';
export function setNotifyWebhook(url: string, publicUrl = ''): void {
  webhookUrl = url;
  publicWebhookUrl = publicUrl;
}

function postWebhook(url: string, title: string, message: string): Promise<number | null> {
  if (!url) return Promise.resolve(null);
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: `**${title}**\n${message}` }),
    signal: AbortSignal.timeout(10000),
  })
    .then((r) => r.status)
    .catch(() => null);
}

// Public announcements. Composed strings only, never error objects, never
// diagnostics. Await these: the process must not exit before Discord answers.
export function announce(title: string, message: string): Promise<number | null> {
  return postWebhook(publicWebhookUrl, title, message);
}
export function notify(title: string, message: string): void {
  try {
    execFileSync('osascript', [
      '-e',
      `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
    ]);
  } catch {
    // headless or not macOS
  }
  postWebhook(webhookUrl, title, message);
}

function qualifyingCount(cfg: AppConfig, date: string): number | null {
  const f = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(f)) return null;
  return readCsv(f).filter((r) => r.wallet).length;
}

function latestPreviousQualifyingCount(cfg: AppConfig, date: string): number | null {
  if (!fs.existsSync(cfg.dirs.snapshots)) return null;
  const dates = fs
    .readdirSync(cfg.dirs.snapshots)
    .filter((f) => f.endsWith('-qualifying-holders.csv'))
    .map((f) => f.replace('-qualifying-holders.csv', ''))
    .filter((d) => d < date)
    .sort();
  if (dates.length === 0) return null;
  return qualifyingCount(cfg, dates[dates.length - 1]!);
}

// Tripwires that replace the human reading the preview block.
// Any trip aborts the run before a single token moves.
function autoGuards(cfg: AppConfig, date: string): void {
  const allocations = loadAllocations(cfg, date);

  if (allocations.length === 0) {
    throw new Error('AUTO GUARD: allocations are empty. See the preview output above.');
  }

  if (allocations.length < cfg.autoMinHolders) {
    throw new Error(
      `AUTO GUARD: only ${allocations.length} wallets receiving, minimum is ${cfg.autoMinHolders}. Snapshot may be bad.`
    );
  }

  const prevCount = latestPreviousQualifyingCount(cfg, date);
  const todayCount = qualifyingCount(cfg, date);
  if (prevCount !== null && prevCount > 0 && todayCount !== null) {
    const dropPercent = ((prevCount - todayCount) * 100) / prevCount;
    if (dropPercent > cfg.autoMaxHolderDropPercent) {
      throw new Error(
        `AUTO GUARD: qualifying holders fell ${dropPercent.toFixed(1)}% (${prevCount} -> ${todayCount}). Snapshot may be partial. Run npm run preview and inspect.`
      );
    }
  }

  const total = allocations.reduce((acc, a) => acc + a.amountRaw, 0n);
  const max = allocations.reduce((m, a) => (a.amountRaw > m ? a.amountRaw : m), 0n);
  const topSharePercent = total > 0n ? Number((max * 10000n) / total) / 100 : 0;
  if (topSharePercent > cfg.autoMaxTopSharePercent) {
    throw new Error(
      `AUTO GUARD: top wallet takes ${topSharePercent}% of today, cap is ${cfg.autoMaxTopSharePercent}%. Inspect the allocations file, then raise AUTO_MAX_TOP_SHARE_PERCENT in .env if this is legitimate.`
    );
  }

  console.log(
    `Auto guards passed: ${allocations.length} wallets, top share ${topSharePercent}%, previous run ${prevCount ?? 'none'}.`
  );
}

// Composes and posts today's public summary from the ledger. Used by the
// auto run after a successful send, and manually via npm run announce-today
// to repost the day, e.g. after wiring the webhook late.
export async function runAnnounceToday(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  const mainMint = cfg.mint.toBase58();
  const todaySent = readSentEntries(cfg, date).filter(
    (e) => (e.mint ?? mainMint) === mainMint && e.status === 'confirmed'
  );
  if (todaySent.length === 0) {
    const st = await announce(
      '9:41. box checked.',
      'nothing due today. the curve waits on growth. every new pigeon unlocks 5,313. bring pigeons.'
    );
    console.log(`No sends in the ledger today. Posted the quiet-day message. discord says: ${st ?? 'no webhook or unreachable'}`);
    return;
  }
  const totalRaw = todaySent.reduce((acc, e) => acc + BigInt(e.amount_raw), 0n);
  const ctx = await getTokenContext(cfg);
  const line = `${fmt(rawToHuman(totalRaw, ctx.decimals))} $pigeon to ${todaySent.length} holders. every signature on chain.`;
  const status = await announce('9:41. bread went out.', line);
  console.log(`Posted: ${line}`);
  console.log(`discord says: ${status ?? 'no webhook or unreachable'}`);
}

// Unattended daily run: snapshot, preview, guards, send. Halts loudly on
// anything abnormal. Per-date sent logs make same-day reruns harmless.
export async function runSendAuto(cfg: AppConfig): Promise<void> {
  const date = todayStr();
  console.log('');
  console.log(`=== send-auto ${new Date().toISOString()} ===`);
  try {
    const already = readSentEntries(cfg, date);
    if (already.some((e) => e.type === 'daily')) {
      console.log(
        `Daily distribution for ${date} already ran (${already.length} transfers logged). Checking the drop pipeline.`
      );
      try {
        const { runAutoSweep } = await import('./sweep.js');
        await runAutoSweep(cfg);
        const { runBridgeAuto } = await import('./bridge.js');
        await runBridgeAuto(cfg);
      } catch (e) {
        notify('drop wallet: sweep skipped', e instanceof Error ? e.message.slice(0, 140) : String(e));
      }
      return;
    }
    if (already.length > 0) {
      console.log(`Test sends exist for ${date}. Allocations are frozen, sending the remainder.`);
    } else {
      await runSnapshot(cfg);
      try {
        const { runPublishBoard } = await import('./board.js');
        await runPublishBoard(cfg);
      } catch (e) {
        console.log(`Board publish skipped: ${e instanceof Error ? e.message : String(e)}`);
      }
      await runPreview(cfg);
    }
    // A zero day is the curve waiting on growth, not a failure.
    const planned = loadAllocations(cfg, date);
    if (planned.length === 0) {
      console.log('Nothing due today. The curve is waiting on holder growth.');
      notify(
        'level941 airdrop',
        `Nothing due for ${date}. Unlocked pool fully distributed at the current holder count. Not an error.`
      );
      await announce(
        '9:41. box checked.',
        'nothing due today. the curve waits on growth. every new pigeon unlocks 5,313. bring pigeons.'
      );
      try {
        const { runAutoSweep } = await import('./sweep.js');
        await runAutoSweep(cfg);
        const { runBridgeAuto } = await import('./bridge.js');
        await runBridgeAuto(cfg);
      } catch (e) {
        notify('drop wallet: sweep skipped', e instanceof Error ? e.message.slice(0, 140) : String(e));
      }
      return;
    }
    autoGuards(cfg, date);
    await runSendDaily(cfg, true);
    notify('level941 airdrop', `Auto send complete for ${date}.`);
    await runAnnounceToday(cfg);
    try {
      const { runAutoSweep } = await import('./sweep.js');
      await runAutoSweep(cfg);
      const { runBridgeAuto } = await import('./bridge.js');
      await runBridgeAuto(cfg);
    } catch (e) {
      notify('drop wallet: sweep skipped', e instanceof Error ? e.message.slice(0, 140) : String(e));
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    notify('level941 airdrop HALTED', msg.slice(0, 160));
    throw e;
  }
}
