import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

export type DistributionMode = 'equal' | 'prorata' | 'streak';

export interface AppConfig {
  connection: Connection;
  mint: PublicKey;
  keypair: Keypair;
  scheduledDripHuman: string;
  minHolderBalanceHuman: string;
  excludedWallets: Set<string>;
  distributionMode: DistributionMode;
  streakCap: number;
  streakExponent: number;
  dailyMinSendTokens: number;
  dividendMinRaw: bigint;
  autoMinHolders: number;
  autoMaxHolderDropPercent: number;
  autoMaxTopSharePercent: number;
  allowedDropMints: Set<string>;
  sweepTopN: number;
  sellerTimeoutDays: number;
  snapshotMaxDropPercent: number;
  bridgeMinOgDays: number;
  bridgeBonusTokens: number;
  bridgeOpenDate: string;
  bridgeCloseDate: string;
  drawPrizeTokens: number;
  drawWinners: number;
  loyaltyWinners: number;
  loyaltyBonusTokens: number;
  founderDropTokens: number;
  drawMode: 'holders' | 'entries';
  sweepMinUsd: number;
  sweepDelayHours: number;
  solReserve: number;
  jupQuoteUrl: string;
  discordWebhookUrl: string;
  discordPublicWebhookUrl: string;
  holderGoal: number;          // legacy curve denominator; now = lifetime unlock events (Emax)
  qualifyFloorTokens: number;  // v1 = 10000, may only decrease in a later ruleset
  rulesetId: string;           // pins the active economic ruleset
  retainedSupplyPercent: bigint;
  maxAirdropPoolPercent: bigint;
  sendDelayMs: number;
  priorityFeeMicroLamports: number;
  dashboardLocalPollMs: number;
  dashboardPublishIntervalMs: number;
  dirs: {
    data: string;
    snapshots: string;
    allocations: string;
    logs: string;
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v.trim();
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== '' ? v.trim() : fallback;
}

function parseIntEnv(name: string, fallback: number, min: number): number {
  const raw = optional(name, String(fallback));
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min) {
    throw new Error(`${name} must be an integer >= ${min}. Got: ${raw}`);
  }
  return n;
}

// Parses the airdrop wallet secret key.
// Supports a Solana JSON keypair array or a base58 secret key.
// Never logs or echoes the key material anywhere.
function parseKeypair(raw: string): Keypair {
  const t = raw.trim();
  try {
    if (t.startsWith('[')) {
      const arr = JSON.parse(t) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    const decoded = bs58.decode(t);
    if (decoded.length === 64) return Keypair.fromSecretKey(decoded);
    if (decoded.length === 32) return Keypair.fromSeed(decoded);
  } catch {
    throw new Error(
      'AIRDROP_PRIVATE_KEY could not be parsed. Use a Solana JSON keypair array or a base58 secret key.'
    );
  }
  throw new Error(
    'AIRDROP_PRIVATE_KEY has an unexpected length. Use a Solana JSON keypair array or a base58 secret key.'
  );
}

export function loadConfig(): AppConfig {
  const rpcUrl = required('RPC_URL');

  let mint: PublicKey;
  try {
    mint = new PublicKey(required('TOKEN_MINT'));
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Missing required')) throw e;
    throw new Error('TOKEN_MINT is not a valid public key.');
  }

  const keypair = parseKeypair(required('AIRDROP_PRIVATE_KEY'));

  const excludedWallets = new Set<string>();
  const rawExcluded = optional('EXCLUDED_WALLETS', '');
  if (rawExcluded) {
    for (const w of rawExcluded.split(/[\s,]+/).filter(Boolean)) {
      try {
        excludedWallets.add(new PublicKey(w).toBase58());
      } catch {
        throw new Error(`EXCLUDED_WALLETS contains an invalid public key: ${w}`);
      }
    }
  }
  // The airdrop wallet never pays itself.
  excludedWallets.add(keypair.publicKey.toBase58());

  const allowedDropMints = new Set<string>();
  const rawAllowed = optional('ALLOWED_DROP_MINTS', '');
  if (rawAllowed) {
    for (const m of rawAllowed.split(/[\s,]+/).filter(Boolean)) {
      try {
        allowedDropMints.add(new PublicKey(m).toBase58());
      } catch {
        throw new Error(`ALLOWED_DROP_MINTS contains an invalid mint: ${m}`);
      }
    }
  }

  const retained = parseIntEnv('RETAINED_SUPPLY_PERCENT', 15, 0);
  const maxPool = parseIntEnv('MAX_AIRDROP_POOL_PERCENT', 50, 0);
  if (retained > 100 || maxPool > 100) {
    throw new Error('RETAINED_SUPPLY_PERCENT and MAX_AIRDROP_POOL_PERCENT must be between 0 and 100.');
  }

  const modeRaw = optional('DISTRIBUTION_MODE', 'streak');
  if (modeRaw !== 'equal' && modeRaw !== 'prorata' && modeRaw !== 'streak') {
    throw new Error('DISTRIBUTION_MODE must be equal, prorata, or streak.');
  }

  // The squared-loyalty law's exponent. 1 is the original linear law and
  // the default: flipping this is a deliberate, announced change, never
  // silent. Bounded 1-3 so a typo cannot suddenly make streak 94 worth
  // 94^10 of a streak-1 wallet.
  const streakExponent = parseIntEnv('STREAK_EXPONENT', 1, 1);
  if (streakExponent > 3) {
    throw new Error(`STREAK_EXPONENT must be between 1 and 3. Got: ${streakExponent}`);
  }

  const root = process.cwd();
  const dirs = {
    data: path.join(root, 'data'),
    snapshots: path.join(root, 'data', 'snapshots'),
    allocations: path.join(root, 'data', 'allocations'),
    logs: path.join(root, 'data', 'logs'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });

  return {
    connection: new Connection(rpcUrl, 'confirmed'),
    mint,
    keypair,
    scheduledDripHuman: optional('SCHEDULED_DAILY_DRIP_AMOUNT', ''),
    minHolderBalanceHuman: optional('MINIMUM_HOLDER_BALANCE', String(parseIntEnv('QUALIFY_FLOOR_TOKENS', 10000, 1))),
    excludedWallets,
    distributionMode: modeRaw,
    streakCap: parseIntEnv('STREAK_CAP', 94, 1),
    streakExponent,
    dailyMinSendTokens: parseIntEnv('DAILY_MIN_SEND_TOKENS', 1, 0),
    dividendMinRaw: BigInt(parseIntEnv('DIVIDEND_MIN_RAW', 100000, 0)),
    autoMinHolders: parseIntEnv('AUTO_MIN_HOLDERS', 50, 1),
    autoMaxHolderDropPercent: parseIntEnv('AUTO_MAX_HOLDER_DROP_PERCENT', 25, 1),
    autoMaxTopSharePercent: parseIntEnv('AUTO_MAX_TOP_SHARE_PERCENT', 50, 1),
    allowedDropMints,
    sweepTopN: parseIntEnv('SWEEP_TOP_N', 100, 1),
    sellerTimeoutDays: parseIntEnv('SELLER_TIMEOUT_DAYS', 2, 0),
    snapshotMaxDropPercent: parseIntEnv('SNAPSHOT_MAX_DROP_PERCENT', 50, 1),
    bridgeMinOgDays: parseIntEnv('BRIDGE_MIN_OG_DAYS', 90, 0),
    bridgeBonusTokens: parseIntEnv('BRIDGE_BONUS_TOKENS', 5313, 0),
    bridgeOpenDate: optional('BRIDGE_OPEN_DATE', ''),
    bridgeCloseDate: optional('BRIDGE_CLOSE_DATE', ''),
    drawPrizeTokens: parseIntEnv('DRAW_PRIZE_TOKENS', 941000, 1),
    drawWinners: parseIntEnv('DRAW_WINNERS', 1, 1),
    loyaltyWinners: parseIntEnv('LOYALTY_WINNERS', 94, 1),
    loyaltyBonusTokens: parseIntEnv('LOYALTY_BONUS_TOKENS', 25000, 1),
    founderDropTokens: parseIntEnv('FOUNDER_DROP_TOKENS', 25000, 1),
    drawMode: optional('DRAW_MODE', 'holders') === 'entries' ? 'entries' : 'holders',
    sweepMinUsd: parseIntEnv('SWEEP_MIN_USD', 1, 0),
    sweepDelayHours: parseIntEnv('SWEEP_DELAY_HOURS', 48, 0),
    solReserve: Number.parseFloat(optional('SOL_RESERVE', '0.3')),
    jupQuoteUrl: optional('JUP_QUOTE_URL', 'https://lite-api.jup.ag/swap/v1/quote'),
    discordWebhookUrl: optional('DISCORD_WEBHOOK_URL', ''),
    discordPublicWebhookUrl: optional('DISCORD_PUBLIC_WEBHOOK_URL', ''),
    holderGoal: parseIntEnv('HOLDER_GOAL', 94100, 1),
    qualifyFloorTokens: parseIntEnv('QUALIFY_FLOOR_TOKENS', 10000, 1),
    rulesetId: optional('RULESET_ID', 'v1-2026-07'),
    retainedSupplyPercent: BigInt(retained),
    maxAirdropPoolPercent: BigInt(maxPool),
    sendDelayMs: parseIntEnv('SEND_DELAY_MS', 300, 0),
    priorityFeeMicroLamports: parseIntEnv('PRIORITY_FEE_MICROLAMPORTS', 0, 0),
    // Local write cadence for docs/live-state.json (fast, cheap, no publish
    // cost) vs. the throttled git commit+push cadence that actually reaches
    // the public page. Keeping these separate is the whole point: the poller
    // can feel snappy locally without bloating repo history.
    dashboardLocalPollMs: parseIntEnv('DASHBOARD_LOCAL_POLL_MS', 8000, 1000),
    dashboardPublishIntervalMs: parseIntEnv('DASHBOARD_PUBLISH_INTERVAL_MS', 75000, 30000),
    dirs,
  };
}

export function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
