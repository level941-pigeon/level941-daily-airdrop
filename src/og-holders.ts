// OG live holder pull. Fast alternative to og-replay: instead of crawling
// every signature and replaying balance history, this asks Helius's indexer
// directly (DAS getTokenAccounts) for every account that holds the OG mint
// right now, and aggregates by owner wallet.
//
// This does NOT reconstruct history. It reports who holds the token at the
// moment the script runs. For a dead token, that can be a small fraction of
// everyone who ever held it -- most historical holders sell to zero or
// abandon the bag once a token stops trading.
//
// Usage:
//   npm run og-holders
//   OG_MINT=<mint> npm run og-holders
//
// Read-only. Writes data/og/og-live-holders.csv. Sends nothing.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, getMint } from '@solana/spl-token';
import { AppConfig, loadConfig, sleep } from './config.js';
import { fmt, rawToHuman } from './math.js';

const DEFAULT_OG_MINT = '4fSWEw2wbYEUCcMtitzmeGUfqinoafXxkhqZrA9Gpump';

interface DasTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: string; // forced to a string before parse; see parseDasResponse
}

interface DasResult {
  token_accounts: DasTokenAccount[];
  cursor?: string;
}

interface DasResponse {
  result?: DasResult;
  error?: { message: string };
}

// Helius DAS returns `amount` as a bare JSON number, which silently loses
// precision above 2^53. Rewrite it to a JSON string before parsing so
// BigInt gets the exact raw on-chain value every time.
function parseDasResponse(text: string): DasResponse {
  const guarded = text.replace(/"amount":(\d+)/g, '"amount":"$1"');
  return JSON.parse(guarded) as DasResponse;
}

async function fetchPage(
  rpcUrl: string,
  mint: string,
  cursor: string | undefined,
  limit: number
): Promise<DasResult> {
  const body = {
    jsonrpc: '2.0',
    id: 'og-holders',
    method: 'getTokenAccounts',
    params: { mint, limit, ...(cursor ? { cursor } : {}) },
  };
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const text = await res.text();
      const json = parseDasResponse(text);
      if (json.error) throw new Error(json.error.message);
      if (!json.result) throw new Error('DAS response missing result');
      return json.result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === 6) throw new Error(`getTokenAccounts failed after 6 attempts: ${msg}`);
      process.stdout.write(`\n  page failed (attempt ${attempt}/6): ${msg.slice(0, 80)}. retrying...`);
      await sleep(1500 * attempt);
    }
  }
  throw new Error('unreachable');
}

async function fetchAllTokenAccounts(rpcUrl: string, mint: string): Promise<DasTokenAccount[]> {
  const limit = 1000;
  let cursor: string | undefined;
  const all: DasTokenAccount[] = [];
  for (;;) {
    const page = await fetchPage(rpcUrl, mint, cursor, limit);
    if (page.token_accounts.length === 0) break;
    all.push(...page.token_accounts);
    process.stdout.write(`\r  token accounts fetched: ${all.length}`);
    if (!page.cursor || page.token_accounts.length < limit) break;
    cursor = page.cursor;
    await sleep(150);
  }
  console.log('');
  return all;
}

async function detectDecimals(cfg: AppConfig, mint: PublicKey): Promise<number> {
  const info = await cfg.connection.getAccountInfo(mint);
  if (!info) throw new Error('OG mint not found on chain.');
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mintInfo = await getMint(cfg.connection, mint, 'confirmed', programId);
  return mintInfo.decimals;
}

async function main(): Promise<void> {
  const ogMintStr = (process.env.OG_MINT ?? DEFAULT_OG_MINT).trim();
  const cfg = loadConfig();
  const ogMint = new PublicKey(ogMintStr);
  const rpcUrl = cfg.connection.rpcEndpoint;

  console.log(`OG mint: ${ogMintStr}`);
  console.log('Pulling the CURRENT holder list from Helius DAS (getTokenAccounts).');
  console.log('This reports who holds the token RIGHT NOW, not everyone who ever held it.');
  console.log('');

  const decimals = await detectDecimals(cfg, ogMint);
  const accounts = await fetchAllTokenAccounts(rpcUrl, ogMintStr);

  const balances = new Map<string, bigint>();
  for (const a of accounts) {
    const amt = BigInt(a.amount);
    if (amt === 0n) continue;
    balances.set(a.owner, (balances.get(a.owner) ?? 0n) + amt);
  }

  const rows: { wallet: string; balanceRaw: bigint; onCurve: boolean }[] = [];
  for (const [wallet, balanceRaw] of balances) {
    let onCurve = false;
    try {
      onCurve = PublicKey.isOnCurve(wallet);
    } catch {
      onCurve = false;
    }
    rows.push({ wallet, balanceRaw, onCurve });
  }
  rows.sort((a, b) => (b.balanceRaw > a.balanceRaw ? 1 : b.balanceRaw < a.balanceRaw ? -1 : 0));

  const real = rows.filter((r) => r.onCurve);
  const pdas = rows.filter((r) => !r.onCurve);

  const dir = path.join(cfg.dirs.data, 'og');
  fs.mkdirSync(dir, { recursive: true });
  const outFile = path.join(dir, 'og-live-holders.csv');
  const lines = ['wallet,balance_raw,balance,on_curve'];
  for (const r of rows) {
    lines.push(`${r.wallet},${r.balanceRaw.toString()},${rawToHuman(r.balanceRaw, decimals)},${r.onCurve ? 1 : 0}`);
  }
  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8');

  const totalRaw = real.reduce((acc, r) => acc + r.balanceRaw, 0n);
  const bucket = (floorHuman: number) =>
    real.filter((r) => r.balanceRaw >= BigInt(floorHuman) * 10n ** BigInt(decimals)).length;

  console.log('');
  console.log('OG LIVE HOLDER PULL (Helius DAS)');
  console.log('--------------------------------------------------');
  console.log(`token accounts fetched     ${accounts.length}`);
  console.log(`unique owner wallets       ${rows.length}`);
  console.log(`  real wallets (on-curve)  ${real.length}`);
  console.log(`  PDAs/pools (off-curve)   ${pdas.length}  (LPs, vaults, program accounts -- not people)`);
  console.log(`total balance (real)       ${fmt(rawToHuman(totalRaw, decimals))}`);
  console.log('--------------------------------------------------');
  console.log('balance distribution (real wallets only):');
  console.log(`  >= 1               ${bucket(1)}`);
  console.log(`  >= 100             ${bucket(100)}`);
  console.log(`  >= 1,000           ${bucket(1000)}`);
  console.log(`  >= 10,000          ${bucket(10000)}`);
  console.log(`  >= 100,000         ${bucket(100000)}`);
  console.log(`  >= 1,000,000       ${bucket(1000000)}`);
  console.log('--------------------------------------------------');
  console.log('top 15 by balance:');
  for (const r of real.slice(0, 15)) {
    console.log(`  ${r.wallet}  ${fmt(rawToHuman(r.balanceRaw, decimals))}`);
  }
  console.log('--------------------------------------------------');
  console.log(`Full list written: ${outFile}`);
  console.log('');
  console.log('CAVEAT: this is who holds the OLD token right now, not the full historical');
  console.log('holder count. After a token dies most old holders sell to zero or abandon the');
  console.log('bag, so this is very likely a small fraction of everyone who ever held it.');
  console.log('');
  console.log('Read-only pull. Nothing was sent. Pick a dust floor next.');
}

const isDirectRun = process.argv[1]?.endsWith('og-holders.ts');
if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
