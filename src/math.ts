// All amount math is done in raw base units as bigint. No floats anywhere near tokens.

export interface PoolInputs {
  totalSupplyRaw: bigint;
  qualifyingHolderCount: number;
  holderGoal: number;
  totalDistributedRaw: bigint;
  senderBalanceRaw: bigint;
  scheduledDailyDripRaw: bigint;
  retainedSupplyPercent: bigint; // e.g. 15n
  maxAirdropPoolPercent: bigint; // e.g. 50n
}

export interface PoolResult {
  maxAirdropPoolRaw: bigint;
  retainedFloorRaw: bigint;
  unlockedPoolRaw: bigint;
  availableTodayRaw: bigint;
  senderHeadroomRaw: bigint;
  dailyAirdropRaw: bigint;
  perWalletRaw: bigint;
  totalToSendRaw: bigint;
  reason: string | null; // set when nothing will be sent
}

function clampZero(v: bigint): bigint {
  return v < 0n ? 0n : v;
}

function minBig(...vals: bigint[]): bigint {
  return vals.reduce((a, b) => (b < a ? b : a));
}

// Implements:
// max_airdrop_pool = total_supply * MAX_AIRDROP_POOL_PERCENT
// retained_supply_floor = total_supply * RETAINED_SUPPLY_PERCENT
// unlocked_pool_today = min(max_pool, max_pool * holders / holder_goal)
// available_today = unlocked_pool_today - total_already_distributed
// daily = min(scheduled_drip, available_today, sender_balance - retained_floor)
export function computeDailyAirdrop(i: PoolInputs): PoolResult {
  const maxAirdropPoolRaw = (i.totalSupplyRaw * i.maxAirdropPoolPercent) / 100n;
  const retainedFloorRaw = (i.totalSupplyRaw * i.retainedSupplyPercent) / 100n;

  const holders = BigInt(i.qualifyingHolderCount);
  const goal = BigInt(i.holderGoal);

  let unlockedPoolRaw = goal > 0n ? (maxAirdropPoolRaw * holders) / goal : 0n;
  if (unlockedPoolRaw > maxAirdropPoolRaw) unlockedPoolRaw = maxAirdropPoolRaw;

  const availableTodayRaw = clampZero(unlockedPoolRaw - i.totalDistributedRaw);
  const senderHeadroomRaw = clampZero(i.senderBalanceRaw - retainedFloorRaw);

  const dailyAirdropRaw = clampZero(
    minBig(i.scheduledDailyDripRaw, availableTodayRaw, senderHeadroomRaw)
  );

  const perWalletRaw = holders > 0n ? dailyAirdropRaw / holders : 0n;
  const totalToSendRaw = perWalletRaw * holders;

  let reason: string | null = null;
  if (totalToSendRaw <= 0n) {
    if (i.qualifyingHolderCount === 0) {
      reason = 'no qualifying holders';
    } else if (senderHeadroomRaw === 0n) {
      reason = 'sender balance is at or below the retained supply floor';
    } else if (availableTodayRaw === 0n) {
      reason = 'unlocked pool is fully distributed at the current holder count';
    } else if (i.scheduledDailyDripRaw <= 0n) {
      reason = 'scheduled daily drip amount is zero';
    } else {
      reason = 'daily amount is too small to split across holders';
    }
  }

  return {
    maxAirdropPoolRaw,
    retainedFloorRaw,
    unlockedPoolRaw,
    availableTodayRaw,
    senderHeadroomRaw,
    dailyAirdropRaw,
    perWalletRaw,
    totalToSendRaw,
    reason,
  };
}

export type DistributionMode = 'equal' | 'prorata' | 'streak';

export interface HolderWeight {
  wallet: string;
  balanceRaw: bigint;
  streak: number; // consecutive snapshot days without a balance decrease
}

// The squared-loyalty law. weight = balance * min(max(streak,1),cap)^exponent.
// exponent 1 is the original linear-streak law (default, unchanged). Higher
// exponents make loyalty compound: a streak-94 wallet at exponent 2 carries
// 94x the streak weight of a streak-1 wallet at the SAME balance, not 94x
// the balance. Balance itself stays linear at every exponent, so splitting
// a bag across wallets is still never a win (see splitting-invariance test).
export function streakWeight(balanceRaw: bigint, streak: number, cap: number, exponent: number): bigint {
  const s = BigInt(Math.min(Math.max(streak, 1), cap));
  return balanceRaw * s ** BigInt(exponent);
}

// Splits the daily amount across holders.
//
// equal:   daily / holder_count for everyone. Sybil food. Kept for reference.
// prorata: weight = balance. Linear, so splitting a bag across wallets
//          changes nothing. The unique split-invariant balance weighting.
// streak:  weight = streakWeight(balance, streak, cap, exponent). Selling
//          resets streak to 1 and fresh wallets start at 1, so splitting
//          strictly loses at every exponent.
export function computeAllocations(
  dailyRaw: bigint,
  holders: HolderWeight[],
  mode: DistributionMode,
  streakCap: number,
  streakExponent = 1
): { wallet: string; amountRaw: bigint }[] {
  if (dailyRaw <= 0n || holders.length === 0) return [];

  if (mode === 'equal') {
    const per = dailyRaw / BigInt(holders.length);
    if (per <= 0n) return [];
    return holders.map((h) => ({ wallet: h.wallet, amountRaw: per }));
  }

  const weights = holders.map((h) => {
    if (mode === 'prorata') return h.balanceRaw;
    return streakWeight(h.balanceRaw, h.streak, streakCap, streakExponent);
  });

  const totalWeight = weights.reduce((a, b) => a + b, 0n);
  if (totalWeight <= 0n) return [];

  const out: { wallet: string; amountRaw: bigint }[] = [];
  for (let i = 0; i < holders.length; i++) {
    const amountRaw = (dailyRaw * weights[i]!) / totalWeight;
    if (amountRaw > 0n) out.push({ wallet: holders[i]!.wallet, amountRaw });
  }
  return out;
}

// "1234.5" with 6 decimals -> 1234500000n. Exact string parsing, no floats.
export function humanToRaw(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid token amount: "${s}". Use plain numbers like 1000 or 1000.5`);
  }
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${s}" has ${frac.length} decimal places but the token has ${decimals} decimals.`
    );
  }
  const fracPadded = frac.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded === '' ? '0' : fracPadded);
}

// 1234500000n with 6 decimals -> "1234.5"
export function rawToHuman(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const s = raw.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

// Adds thousands separators to a human amount string for display only.
export function fmt(human: string): string {
  const [whole, frac] = human.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

// Days between two YYYY-MM-DD strings. Positive when b is after a.
export function daysBetween(a: string, b: string): number {
  const pa = Date.UTC(
    Number(a.slice(0, 4)), Number(a.slice(5, 7)) - 1, Number(a.slice(8, 10))
  );
  const pb = Date.UTC(
    Number(b.slice(0, 4)), Number(b.slice(5, 7)) - 1, Number(b.slice(8, 10))
  );
  return Math.round((pb - pa) / 86400000);
}

// The next occurrence of 9:41 local time, the daily run's public clock.
// Shared by the public board and the live poller so both agree on one clock.
export function nextNineFortyOne(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setHours(9, 41, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

// Seller timeout: a wallet whose balance dropped within the last
// timeoutDays snapshots receives nothing. Still counts toward the curve.
export function inSellerTimeout(
  lastReducedDate: string | undefined,
  today: string,
  timeoutDays: number
): boolean {
  if (!lastReducedDate || timeoutDays <= 0) return false;
  const d = daysBetween(lastReducedDate, today);
  return d >= 0 && d < timeoutDays;
}
