// Holders-at-death engine for DEAD DROP eligibility. Input: a mint.
// Output: the deterministic list of every wallet holding it as of the
// death block, with balances, plus a checksum so the same input always
// reproduces the same answer and anyone can audit that.
//
// METHODOLOGY (read this before trusting the output):
//
// Death block = the slot of the mint's most recent on-chain transaction,
// as returned by getSignaturesForAddress(mint, limit=1). Not a swap, not
// an LP-pull event specifically -- literally "the last thing that ever
// touched this mint." That is a deliberate simplification, not laziness:
// by definition nothing has happened to the mint after its own most
// recent transaction, which means CURRENT on-chain token-account balances
// are identical to balances-at-that-slot. There is no historical-state
// query involved and no transaction-replay ledger to get wrong -- one
// signature lookup, one current-state snapshot, done. Anyone can
// reproduce this exact number by running the same two calls.
//
// This methodology is only sound for a token that is actually dead --
// "most recent transaction" is a meaningless marker for a live token
// (it'd just mean "five minutes ago"). This engine does not itself decide
// deadness; it trusts the caller to have already confirmed zero liquidity
// and zero trading volume (e.g. via DexScreener, as the candidate
// verification pipeline already does) before ever calling this. Feeding
// it a live token will not error -- it will just return a "death block"
// that's really "block as of whenever you happened to run this," which
// is not what the registry wants. Known edge case, not fixed tonight: a
// single straggler transaction long after real abandonment (someone
// finally moving a dead bag) would shift the computed death block forward
// to that point. The fix is re-running this engine to refresh the
// snapshot, not treating any single computed block as permanent truth --
// it's recomputable, not a one-way trapdoor.
//
// Balance derivation: getParsedProgramAccounts on the token program,
// filtered to this mint, grouped by owner. Same call the existing holder
// snapshot (holders.ts) makes for the pigeon mint, generalized to an
// arbitrary mint here since candidates aren't cfg.mint.
//
// Cost: GRAVEYARD_API_CAP_USD (default 25) reserved-before-call, same
// pattern as flock-signal.ts's budget ledger. The per-call cost figure
// below is a labeled ESTIMATE, not a verified number from a real Helius
// invoice -- I don't have visibility into this account's actual billing
// plan. Treat the dollar figure in the output as directional until it's
// checked against a real statement; the call COUNT is exact regardless.

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection, PublicKey, GetProgramAccountsFilter, ParsedAccountData } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = path.join(ROOT, 'data', 'graveyard-state', 'graveyard-usage.json');
const CAP_USD = Number(process.env.GRAVEYARD_API_CAP_USD ?? '25');
// LABELED ESTIMATE -- see file header. Solana RPC providers are typically
// request-rate-limited rather than metered like this, so this number is a
// conservative placeholder for tracking purposes, not a billed rate.
const ESTIMATED_COST_PER_CALL_USD = 0.0002;

interface Ledger {
  month: string;
  spentUsd: number;
  callsMade: number;
}

function thisMonth(): string {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
}

function loadLedger(): Ledger {
  if (!fs.existsSync(LEDGER_PATH)) return { month: thisMonth(), spentUsd: 0, callsMade: 0 };
  try {
    const l = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')) as Ledger;
    if (l.month !== thisMonth()) return { month: thisMonth(), spentUsd: 0, callsMade: 0 };
    return l;
  } catch {
    return { month: thisMonth(), spentUsd: 0, callsMade: 0 };
  }
}

function saveLedger(l: Ledger): void {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2) + '\n');
}

// Reserve BEFORE calling, same pattern as flock-signal.ts: if this call
// could cross the cap, refuse before spending anything, not after.
function reserveCall(ledger: Ledger, label: string): boolean {
  if (ledger.spentUsd + ESTIMATED_COST_PER_CALL_USD > CAP_USD) {
    console.log(`BUDGET GUARD: ${label} could cross the $${CAP_USD} monthly cap (spent so far: $${ledger.spentUsd.toFixed(4)}). Skipping BEFORE calling.`);
    return false;
  }
  ledger.spentUsd += ESTIMATED_COST_PER_CALL_USD;
  ledger.callsMade += 1;
  return true;
}

interface HoldersAtDeathResult {
  mint: string;
  deathBlock: number;
  deathBlockTime: string | null;
  deathSignature: string;
  holderCount: number;
  totalBalance: string;
  holders: { owner: string; balanceRaw: string }[];
  checksumSha256: string;
  computedAt: string;
  callsUsed: number;
  estimatedCostUsd: number;
}

async function rpc(connection: Connection, method: string, params: unknown): Promise<any> {
  const res = await fetch(connection.rpcEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${method}: ${json.error.message}`);
  return json.result;
}

export async function computeHoldersAtDeath(connection: Connection, mintStr: string): Promise<HoldersAtDeathResult> {
  const ledger = loadLedger();
  const mint = new PublicKey(mintStr);

  if (!reserveCall(ledger, `getSignaturesForAddress(${mintStr})`)) {
    throw new Error('budget cap reached before death-block lookup');
  }
  const sigs = await rpc(connection, 'getSignaturesForAddress', [mintStr, { limit: 1 }]);
  saveLedger(ledger);
  if (!sigs || sigs.length === 0) {
    throw new Error(`no on-chain activity found for ${mintStr} -- cannot determine a death block`);
  }
  const deathBlock: number = sigs[0].slot;
  const deathBlockTime: string | null = sigs[0].blockTime ? new Date(sigs[0].blockTime * 1000).toISOString() : null;
  const deathSignature: string = sigs[0].signature;

  // Determine token program for this mint (classic SPL vs Token-2022).
  if (!reserveCall(ledger, `getAccountInfo(${mintStr})`)) {
    throw new Error('budget cap reached before program-id lookup');
  }
  const acctInfo = await connection.getAccountInfo(mint);
  saveLedger(ledger);
  if (!acctInfo) throw new Error(`mint account ${mintStr} not found`);
  const programId = acctInfo.owner;
  const isClassic = programId.equals(TOKEN_PROGRAM_ID);
  if (!isClassic && !programId.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(`${mintStr} is not owned by a known token program`);
  }

  if (!reserveCall(ledger, `getParsedProgramAccounts holders(${mintStr})`)) {
    throw new Error('budget cap reached before holder snapshot');
  }
  const filters: GetProgramAccountsFilter[] = [{ memcmp: { offset: 0, bytes: mintStr } }];
  if (isClassic) filters.unshift({ dataSize: 165 });
  const accounts = await connection.getParsedProgramAccounts(programId, { filters, commitment: 'confirmed' });
  saveLedger(ledger);

  const balances = new Map<string, bigint>();
  for (const { account } of accounts) {
    const data = account.data;
    if (!('parsed' in data)) continue;
    const parsed = (data as ParsedAccountData).parsed as {
      info?: { mint?: string; owner?: string; tokenAmount?: { amount?: string } };
    };
    const info = parsed?.info;
    if (!info || info.mint !== mintStr || !info.owner) continue;
    const amount = BigInt(info.tokenAmount?.amount ?? '0');
    if (amount === 0n) continue;
    balances.set(info.owner, (balances.get(info.owner) ?? 0n) + amount);
  }

  const holders = [...balances.entries()]
    .map(([owner, balanceRaw]) => ({ owner, balanceRaw: balanceRaw.toString() }))
    .sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const totalBalance = holders.reduce((s, h) => s + BigInt(h.balanceRaw), 0n).toString();

  const checksumInput = JSON.stringify({ mint: mintStr, deathBlock, holders });
  const checksumSha256 = crypto.createHash('sha256').update(checksumInput).digest('hex');

  return {
    mint: mintStr,
    deathBlock,
    deathBlockTime,
    deathSignature,
    holderCount: holders.length,
    totalBalance,
    holders,
    checksumSha256,
    computedAt: new Date().toISOString(),
    callsUsed: ledger.callsMade,
    estimatedCostUsd: ledger.spentUsd,
  };
}

const isDirectRun = process.argv[1]?.endsWith('graveyard-holders.ts');
if (isDirectRun) {
  const mintArg = process.argv[2];
  if (!mintArg) {
    console.error('usage: tsx src/graveyard-holders.ts <mint>');
    process.exit(1);
  }
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error('RPC_URL not set');
  const connection = new Connection(rpcUrl, 'confirmed');
  computeHoldersAtDeath(connection, mintArg)
    .then((result) => {
      const outPath = path.join(ROOT, 'data', 'graveyard-state', `holders-at-death-${mintArg}.json`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
      console.log(`wrote ${outPath}`);
      console.log(`death block: ${result.deathBlock} (${result.deathBlockTime})`);
      console.log(`holders: ${result.holderCount}, total balance: ${result.totalBalance}`);
      console.log(`checksum: ${result.checksumSha256}`);
      console.log(`calls used this run: RPC calls counted in ledger, cumulative month total: ${result.callsUsed}, estimated cumulative cost: $${result.estimatedCostUsd.toFixed(4)}`);
    })
    .catch((e) => {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
