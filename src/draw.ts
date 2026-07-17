// The 941 draw, commit-settle protocol. Two phases the operator cannot
// collapse. Addresses every P0 in the audit:
//  - fail closed without a committed round (no blockhash fallback)
//  - eligibility frozen to a hash at commit, before entropy is knowable
//  - no private winner preview: the public result artifact is written
//    before any token moves
//  - idempotent per-winner payment keyed by round:index, survives crash,
//    rerun, and concurrency via an exclusive lock; a settled round pays 0
//  - dedicated draw wallet, funded before commit, so the Box is untouched
//  - full public artifact: participants, weights, seed source, entropy,
//    winners, signatures, code recompute recipe

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keypair, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  getAccount,
} from '@solana/spl-token';
import { AppConfig, todayStr } from './config.js';
import { getTokenContext, readCsv } from './holders.js';
import bs58 from 'bs58';
import { fmt, humanToRaw, rawToHuman, inSellerTimeout, streakWeight } from './math.js';

export interface Ticketed {
  wallet: string;
  weight: bigint;
}

// Weighted, deterministic, recomputable. Domain-separated per index.
export function selectWeightedWinners(
  tickets: Ticketed[],
  seed: string,
  count: number
): string[] {
  const pool = tickets
    .filter((t) => t.weight > 0n)
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));
  const winners: string[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((s, t) => s + t.weight, 0n);
    const digest = crypto.createHash('sha256').update(`${seed}:${i}`).digest('hex');
    const r = BigInt('0x' + digest) % total;
    let acc = 0n;
    let idx = pool.length - 1;
    for (let j = 0; j < pool.length; j++) {
      acc += pool[j]!.weight;
      if (r < acc) {
        idx = j;
        break;
      }
    }
    winners.push(pool[idx]!.wallet);
    pool.splice(idx, 1);
  }
  return winners;
}

function drawDir(cfg: AppConfig): string {
  return path.join(cfg.dirs.data, 'draw');
}

function canonicalTickets(tickets: Ticketed[]): string {
  return [...tickets]
    .sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
    .map((t) => `${t.wallet},${t.weight.toString()}`)
    .join('\n');
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Build the ticket set from today's qualifying snapshot, weight = the
// squared-loyalty law (bag x streak^exponent), timeout wallets excluded.
function buildTickets(cfg: AppConfig, date: string): Ticketed[] {
  const qualFile = path.join(cfg.dirs.snapshots, `${date}-qualifying-holders.csv`);
  if (!fs.existsSync(qualFile)) {
    throw new Error(`No qualifying snapshot for ${date}. Run: npm run snapshot`);
  }
  return readCsv(qualFile)
    .filter((r) => r.wallet && r.balance_raw)
    .filter((r) => !inSellerTimeout((r.last_reduced ?? '') || undefined, date, cfg.sellerTimeoutDays))
    .map((r) => ({
      wallet: r.wallet as string,
      weight: streakWeight(
        BigInt(r.balance_raw as string),
        Number.parseInt(r.streak ?? '1', 10) || 1,
        cfg.streakCap,
        cfg.streakExponent
      ),
    }));
}

// PHASE 1: COMMIT. Freeze everything, publish, before entropy exists.
export async function runDrawCommit(cfg: AppConfig): Promise<void> {
  const roundId = process.env.DRAW_ROUND_ID?.trim();
  if (!roundId) throw new Error('Set DRAW_ROUND_ID, e.g. DRAW_ROUND_ID=2026-07-17-941 npm run draw-commit');
  const seedSource = process.env.DRAW_SEED_SOURCE?.trim();
  if (!seedSource) {
    throw new Error(
      'Set DRAW_SEED_SOURCE to a future, publicly-announced entropy source, ' +
        'e.g. "first finalized Solana blockhash on 2026-07-18T00:00Z". It must not exist yet.'
    );
  }
  const dir = drawDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const commitPath = path.join(dir, `${roundId}-commit.json`);
  if (fs.existsSync(commitPath)) throw new Error(`Round ${roundId} already committed. Commit is immutable.`);

  const date = todayStr();
  const tickets = buildTickets(cfg, date);
  if (tickets.length === 0) throw new Error('No ticket-holding wallets to commit.');

  const ctx = await getTokenContext(cfg);
  const prizeRaw = humanToRaw(String(cfg.drawPrizeTokens), ctx.decimals);

  // Escrow check: the dedicated draw wallet must already hold the full prize.
  const drawKp = loadDrawWallet(cfg);
  const drawAta = await getAssociatedTokenAddress(cfg.mint, drawKp.publicKey, false, ctx.programId);
  let escrowed = 0n;
  try {
    escrowed = (await getAccount(cfg.connection, drawAta, 'confirmed', ctx.programId)).amount;
  } catch {
    escrowed = 0n;
  }
  const needed = prizeRaw * BigInt(cfg.drawWinners);
  if (escrowed < needed) {
    throw new Error(
      `Prize not escrowed. Draw wallet ${drawKp.publicKey.toBase58()} holds ${rawToHuman(escrowed, ctx.decimals)}, ` +
        `needs ${rawToHuman(needed, ctx.decimals)}. Fund it from buyback, then commit.`
    );
  }

  const ticketsFile = path.join(dir, `${roundId}-participants.csv`);
  const canonical = canonicalTickets(tickets);
  fs.writeFileSync(ticketsFile, 'wallet,weight\n' + canonical + '\n', 'utf8');

  const commit = {
    roundId,
    committedAt: new Date().toISOString(),
    mode: 'holders-weighted',
    prizeTokens: cfg.drawPrizeTokens,
    winnerCount: cfg.drawWinners,
    snapshotDate: date,
    participantCount: tickets.length,
    participantsFile: path.basename(ticketsFile),
    eligibilityHash: sha256(canonical),
    algorithm: 'sha256(seed:index) mod total_weight, winner removed each index',
    seedSource,
    drawWallet: drawKp.publicKey.toBase58(),
    escrowedRaw: escrowed.toString(),
    codeHash: sha256(fs.readFileSync(new URL(import.meta.url), 'utf8')),
    settled: false,
  };
  fs.writeFileSync(commitPath, JSON.stringify(commit, null, 2) + '\n', 'utf8');

  console.log('');
  console.log('ROUND COMMITTED. Publish this before the entropy exists.');
  console.log('--------------------------------------------------');
  console.log(`round id          ${roundId}`);
  console.log(`participants      ${tickets.length}`);
  console.log(`eligibility hash  ${commit.eligibilityHash}`);
  console.log(`prize             ${fmt(String(cfg.drawPrizeTokens))} x ${cfg.drawWinners}`);
  console.log(`escrowed          ${rawToHuman(escrowed, ctx.decimals)} in ${commit.drawWallet}`);
  console.log(`seed source       ${seedSource}`);
  console.log(`code hash         ${commit.codeHash}`);
  console.log('--------------------------------------------------');
  console.log(`commit file       ${commitPath}`);
  console.log(`participants file ${ticketsFile}`);
  console.log('Post the round id, eligibility hash, prize, and seed source now.');
}

// PHASE 2: SETTLE. After the announced entropy exists, pass it in.
export async function runDrawSettle(cfg: AppConfig): Promise<void> {
  const roundId = process.env.DRAW_ROUND_ID?.trim();
  if (!roundId) throw new Error('Set DRAW_ROUND_ID to the committed round.');
  const entropy = process.env.DRAW_ENTROPY?.trim();
  if (!entropy) {
    throw new Error('Set DRAW_ENTROPY to the value from the announced seed source (e.g. the blockhash).');
  }
  const dir = drawDir(cfg);
  const commitPath = path.join(dir, `${roundId}-commit.json`);
  if (!fs.existsSync(commitPath)) throw new Error(`No commit for ${roundId}. Commit first.`);
  const commit = JSON.parse(fs.readFileSync(commitPath, 'utf8'));

  // Re-verify the frozen participant set. One byte changed = hard fail.
  const ticketsFile = path.join(dir, commit.participantsFile);
  const canonical = fs.readFileSync(ticketsFile, 'utf8').trim().split('\n').slice(1).join('\n');
  if (sha256(canonical) !== commit.eligibilityHash) {
    throw new Error('Eligibility hash mismatch. Participant file changed since commit. Settlement refused.');
  }

  const lockPath = path.join(dir, `${roundId}.lock`);
  let lockFd: number;
  try {
    lockFd = fs.openSync(lockPath, 'wx');
  } catch {
    throw new Error(`Round ${roundId} is locked by another process. Refusing concurrent settle.`);
  }

  try {
    const tickets: Ticketed[] = canonical
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [wallet, weight] = line.split(',');
        return { wallet: wallet!, weight: BigInt(weight!) };
      });

    // The seed binds round id, frozen eligibility, AND the entropy. Once
    // the operator has publicly committed the entropy source, the winners
    // are a pure function of published values. Recompute, never trust a
    // stored winner list, so an edited result file cannot redirect payment.
    const seed = sha256(`${commit.roundId}:${commit.eligibilityHash}:${entropy}`);
    const winners = selectWeightedWinners(tickets, seed, commit.winnerCount);

    const resultPath = path.join(dir, `${roundId}-result.json`);
    let result: { payments: Record<string, string>; [k: string]: unknown };
    if (fs.existsSync(resultPath)) {
      const loaded = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
      // Hard-verify the loaded artifact against a fresh recompute. Any
      // divergence means the file was edited or entropy changed: refuse.
      const mismatch =
        loaded.entropy !== entropy ||
        loaded.derivedSeed !== seed ||
        loaded.eligibilityHash !== commit.eligibilityHash ||
        JSON.stringify(loaded.winners) !== JSON.stringify(winners) ||
        loaded.prizeTokens !== commit.prizeTokens;
      if (mismatch) {
        throw new Error(
          'Result file does not match recomputation from the commit and entropy. ' +
            'Refusing to pay a tampered or divergent result.'
        );
      }
      result = loaded;
      console.log('Resuming a verified settlement. Winners recomputed and matched.');
    } else {
      result = {
        roundId,
        settledAt: new Date().toISOString(),
        entropy,
        derivedSeed: seed,
        eligibilityHash: commit.eligibilityHash,
        participantCount: tickets.length,
        winners,
        prizeTokens: commit.prizeTokens,
        payments: {},
      };
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      console.log(`Winners fixed and published: ${resultPath}`);
    }

    const ctx = await getTokenContext(cfg);
    const prizeRaw = humanToRaw(String(commit.prizeTokens), ctx.decimals);
    const drawKp = loadDrawWallet(cfg);
    const fromAta = await getAssociatedTokenAddress(cfg.mint, drawKp.publicKey, false, ctx.programId);
    const payments = result.payments as Record<string, string>;

    for (let i = 0; i < (result.winners as string[]).length; i++) {
      const key = `${roundId}:${i}`;
      if (payments[key]) {
        console.log(`[${i}] already paid, sig ${payments[key]}`);
        continue;
      }
      const winner = (result.winners as string[])[i]!;
      const toOwner = new PublicKey(winner);
      const toAta = await getAssociatedTokenAddress(cfg.mint, toOwner, false, ctx.programId);
      const tx = new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(drawKp.publicKey, toAta, toOwner, cfg.mint, ctx.programId),
        createTransferCheckedInstruction(fromAta, cfg.mint, toAta, drawKp.publicKey, prizeRaw, ctx.decimals, [], ctx.programId)
      );
      const sig = await sendAndConfirmTransaction(cfg.connection, tx, [drawKp], { commitment: 'confirmed' });
      payments[key] = sig;
      fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n', 'utf8');
      console.log(`[${i}] paid ${winner} sig ${sig}`);
    }

    // Settlement status lives in its own file. The commit is never rewritten.
    const settledPath = path.join(dir, `${roundId}-settled.json`);
    fs.writeFileSync(
      settledPath,
      JSON.stringify({ roundId, settledAt: new Date().toISOString(), fullyPaid: true }, null, 2) + '\n',
      'utf8'
    );

    const { announce } = await import('./airdrop.js');
    await announce(
      'the 941. somebody woke up heavy.',
      `round ${roundId}. ${(result.winners as string[]).length} pigeon(s), ${fmt(String(commit.prizeTokens))} $pigeon each, from ${tickets.length} ticket-holding wallets. ` +
        `tickets were bag x days held, nobody entered, everybody was in. seed committed before the draw, entropy ${entropy.slice(0, 12)}..., winners recomputable from the published participant file. funded from the draw wallet, the box never moved.`
    );
    console.log('Settled. Publish the result file for recomputation.');
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lockPath);
  }
}

// Dedicated draw wallet, kept separate from the drop wallet so prize
// funding physically cannot touch the Box. Key in DRAW_WALLET_KEY.
function loadDrawWallet(cfg: AppConfig): Keypair {
  const raw = process.env.DRAW_WALLET_KEY?.trim();
  if (!raw) {
    throw new Error(
      'Set DRAW_WALLET_KEY (JSON array or base58) to a dedicated draw wallet. ' +
        'Fund it from buyback proceeds. Never reuse the drop wallet.'
    );
  }
  let kp: Keypair;
  try {
    if (raw.startsWith('[')) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    else kp = Keypair.fromSecretKey(bs58.decode(raw));
  } catch (e) {
    throw new Error('DRAW_WALLET_KEY could not be parsed: ' + (e instanceof Error ? e.message : String(e)));
  }
  if (kp.publicKey.equals(cfg.keypair.publicKey)) {
    throw new Error('DRAW_WALLET_KEY is the drop wallet. The draw wallet MUST be separate. Aborting.');
  }
  if (!cfg.excludedWallets.has(kp.publicKey.toBase58())) {
    console.log('WARNING: the draw wallet is NOT in EXCLUDED_WALLETS. It can qualify, earn, and win its own prize. Add it now.');
  }
  return kp;
}

export async function runDrawStatus(cfg: AppConfig): Promise<void> {
  const dir = drawDir(cfg);
  if (!fs.existsSync(dir)) {
    console.log('No draw rounds yet.');
    return;
  }
  const commits = fs.readdirSync(dir).filter((f) => f.endsWith('-commit.json'));
  if (commits.length === 0) {
    console.log('No committed rounds yet.');
    return;
  }
  console.log('');
  console.log('Draw rounds');
  console.log('--------------------------------------------------');
  for (const f of commits.sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const resultPath = path.join(dir, `${c.roundId}-result.json`);
    const paid = fs.existsSync(resultPath)
      ? Object.keys((JSON.parse(fs.readFileSync(resultPath, 'utf8')).payments ?? {})).length
      : 0;
    console.log(`${c.roundId}  ${c.settled ? 'SETTLED' : 'committed'}  participants ${c.participantCount}  paid ${paid}/${c.winnerCount}`);
  }
  console.log('--------------------------------------------------');
}
