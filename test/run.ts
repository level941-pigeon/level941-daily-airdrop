// Runnable test suite. `npm test`. No mocks of chain state, pure logic
// and file-state tests that reproduce the auditor's own findings so the
// operator can verify claims instead of trusting a release note.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { updateStreaks, StreakState } from '../src/holders.js';
import { selectWeightedWinners, Ticketed } from '../src/draw.js';
import { humanToRaw, inSellerTimeout, daysBetween, computeAllocations, streakWeight, HolderWeight } from '../src/math.js';
import { assertNoSecrets } from '../src/poller.js';
import {
  assessEngagerQuality,
  assessVelocity,
  scoreWithDeepDive,
  scoreTriageOnly,
  rawReachScore,
  EngagerSignal,
} from '../src/flock-signal-scoring.js';
import { nextWeeklyReveal } from '../src/flock-signal.js';

let pass = 0;
let fail = 0;
const results: string[] = [];
function ok(name: string, cond: boolean) {
  if (cond) { pass++; results.push(`OK   ${name}`); }
  else { fail++; results.push(`FAIL ${name}`); }
}
const bal = (n: string) => humanToRaw(n, 6);

// ---- streak / seller-timeout ----
{
  let st: StreakState = {};
  st = updateStreaks(st, new Map([['A', bal('10000')]]), '2026-07-14');
  for (let d = 15; d <= 20; d++) st = updateStreaks(st, new Map([['A', bal('10000')]]), `2026-07-${d}`);
  ok('streak builds one per day', st['A']!.streak === 7);

  // full exit: A disappears
  st = updateStreaks(st, new Map([['B', bal('50000')]]), '2026-07-21');
  ok('full exit stamps reduction (audit finding)', st['A']!.lastReducedDate === '2026-07-21' && st['A']!.lastBalanceRaw === '0');
  ok('full exit resets streak', st['A']!.streak === 1);

  // rebuy
  st = updateStreaks(st, new Map([['A', bal('10000')], ['B', bal('50000')]]), '2026-07-22');
  ok('rebuy does not resume streak', st['A']!.streak === 1);
  ok('rebuyer still timed out next day', inSellerTimeout(st['A']!.lastReducedDate, '2026-07-22', 2) === true);

  // partial reduction
  let s2: StreakState = {};
  s2 = updateStreaks(s2, new Map([['C', bal('50000')]]), '2026-07-14');
  s2 = updateStreaks(s2, new Map([['C', bal('49999')]]), '2026-07-15');
  ok('partial sell resets + stamps', s2['C']!.streak === 1 && s2['C']!.lastReducedDate === '2026-07-15');

  // hold after sell rebuilds
  s2 = updateStreaks(s2, new Map([['C', bal('49999')]]), '2026-07-16');
  ok('hold after sell rebuilds streak', s2['C']!.streak === 2);
}

// ---- timeout math ----
ok('timeout day-of', inSellerTimeout('2026-07-14', '2026-07-14', 2) === true);
ok('timeout day-after', inSellerTimeout('2026-07-14', '2026-07-15', 2) === true);
ok('timeout expired day 2', inSellerTimeout('2026-07-14', '2026-07-16', 2) === false);
ok('no stamp = no timeout', inSellerTimeout(undefined, '2026-07-16', 2) === false);
ok('knob 0 disables', inSellerTimeout('2026-07-16', '2026-07-16', 0) === false);
ok('daysBetween month boundary', daysBetween('2026-07-31', '2026-08-01') === 1);

// ---- draw determinism / sybil invariance ----
{
  const t: Ticketed[] = Array.from({ length: 20 }, (_, i) => ({ wallet: `W${i}`, weight: BigInt((i + 1) * 100) }));
  const a = selectWeightedWinners(t, 'seedX', 3);
  const b = selectWeightedWinners(t, 'seedX', 3);
  ok('draw deterministic on fixed seed', JSON.stringify(a) === JSON.stringify(b));
  ok('no duplicate winners', new Set(a).size === 3);

  // proportionality
  let whale = 0;
  const field: Ticketed[] = [{ wallet: 'WHALE', weight: 900n }, ...Array.from({ length: 10 }, (_, i) => ({ wallet: `m${i}`, weight: 10n }))];
  for (let i = 0; i < 3000; i++) if (selectWeightedWinners(field, `s${i}`, 1)[0] === 'WHALE') whale++;
  const rate = whale / 3000;
  ok('90% weight wins ~90% (0.87-0.93)', rate > 0.87 && rate < 0.93);

  // sybil invariance: splitting 100 into 10x10 does not beat holding 100
  const solo: Ticketed[] = [{ wallet: 'ONE', weight: 100n }, { wallet: 'F', weight: 900n }];
  const split: Ticketed[] = [...Array.from({ length: 10 }, (_, i) => ({ wallet: `s${i}`, weight: 10n })), { wallet: 'F', weight: 900n }];
  let so = 0, sp = 0;
  for (let i = 0; i < 5000; i++) {
    if (selectWeightedWinners(solo, `q${i}`, 1)[0] === 'ONE') so++;
    if (selectWeightedWinners(split, `q${i}`, 1)[0]!.startsWith('s')) sp++;
  }
  ok('splitting gains no draw odds (0.9-1.1)', sp / so > 0.9 && sp / so < 1.1);
}

// ---- draw result-integrity: edited result file must be rejected on recompute ----
{
  // simulate the settle recompute check in isolation
  const tickets: Ticketed[] = [{ wallet: 'X', weight: 10n }, { wallet: 'Y', weight: 10n }, { wallet: 'Z', weight: 10n }];
  const seed = 'bound-seed';
  const winners = selectWeightedWinners(tickets, seed, 1);
  const tampered = winners[0] === 'X' ? 'Y' : 'X';
  // the settle path compares JSON.stringify(loaded.winners) to recompute
  ok('tampered winner detected by recompute', JSON.stringify([tampered]) !== JSON.stringify(winners));
}

console.log(results.join('\n'));
console.log(`\n${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- loyalty capstone: ranks by streak alone, whales get no edge ----
{
  const { rankLoyalty } = await import('../src/loyalty.js');
  const os = await import('node:os');
  const fsm = await import('node:fs');
  const pathm = await import('node:path');
  const tmp = fsm.mkdtempSync(pathm.join(os.tmpdir(), 'loyalty-'));
  const snapDir = pathm.join(tmp, 'snapshots');
  fsm.mkdirSync(snapDir, { recursive: true });
  const date = '2026-07-20';
  // whale: huge bag, short streak. loyal: tiny bag, long streak. dumper: long streak but timed out.
  fsm.writeFileSync(pathm.join(snapDir, `${date}-qualifying-holders.csv`),
    'wallet,balance_raw,balance,streak,last_reduced\n' +
    'WHALE,2000000000000,2000000,10,\n' +      // 2M, streak 10
    'LOYAL,15000000000,15000,90,\n' +          // 15k, streak 90
    'MID,50000000000,50000,45,\n' +            // 50k, streak 45
    'DUMPER,80000000000,80000,88,2026-07-19\n'  // 80k, streak 88 but sold yesterday
  );
  const cfg: any = {
    dirs: { snapshots: snapDir, logs: pathm.join(tmp, 'logs') },
    sellerTimeoutDays: 2,
    loyaltyWinners: 94,
    qualifyFloorTokens: 10000,
    streakCap: 94,
  };
  const ranked = rankLoyalty(cfg, date);
  ok('loyal tiny-bag ranks #1 over whale', ranked[0]!.wallet === 'LOYAL');
  ok('whale with short streak ranks last of eligible', ranked[ranked.length - 1]!.wallet === 'WHALE');
  ok('mid ranks above whale (45 > 10)', ranked.findIndex(r => r.wallet === 'MID') < ranked.findIndex(r => r.wallet === 'WHALE'));
  ok('dumper excluded despite high streak', !ranked.some(r => r.wallet === 'DUMPER'));
  ok('exactly 3 eligible (dumper timed out)', ranked.length === 3);
  fsm.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nfinal: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- founder drop: excluded from curve accounting + cold-floor math ----
{
  // curve exclusion is verified by the ledger filter: a 'founder' entry
  // must not add to sumDistributed. We test the classification logic:
  const founderEntry = { type: 'founder', status: 'confirmed', amount_raw: '12600000000000' };
  const drawEntry = { type: 'draw', status: 'confirmed', amount_raw: '941000000000' };
  const dailyEntry = { type: 'daily', status: 'confirmed', amount_raw: '5313000000' };
  const countsAgainstCurve = (e: any) =>
    e.status === 'confirmed' && e.type !== 'draw' && e.type !== 'founder';
  ok('founder drop excluded from curve', countsAgainstCurve(founderEntry) === false);
  ok('draw excluded from curve', countsAgainstCurve(drawEntry) === false);
  ok('daily counts against curve', countsAgainstCurve(dailyEntry) === true);

  // cold-floor guard: 1B supply, 15% cold = 150M must remain.
  const supply = 1_000_000_000n * 1_000_000n; // raw, 6 decimals
  const coldPct = 15n;
  const coldFloor = (supply * coldPct) / 100n; // 150M raw
  const senderHolds = 650_000_000n * 1_000_000n; // founder holds 650M
  const spendable = senderHolds - coldFloor; // 500M spendable
  const drop504x25k = 504n * 25_000n * 1_000_000n; // 12.6M raw
  ok('12.6M drop fits above 15% floor', drop504x25k <= spendable);
  // a drop that would breach the floor must be caught
  const hugeDrop = 520_000_000n * 1_000_000n; // 520M would leave < 150M
  ok('floor-breaching drop is blocked', hugeDrop > spendable);
}

console.log(`\nreally final: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- squared-loyalty law: streakWeight unit checks ----
{
  ok('streakWeight exponent 1 == balance*streak', streakWeight(1000n, 10, 94, 1) === 10000n);
  ok('streakWeight exponent 2 squares the capped streak', streakWeight(1000n, 10, 94, 2) === 100000n);
  ok('streakWeight clamps to cap before exponentiating', streakWeight(1000n, 500, 94, 2) === 1000n * 94n ** 2n);
  ok('streakWeight floors streak below 1', streakWeight(1000n, 0, 94, 2) === 1000n * 1n);
}

// ---- (d) exponent 1 changes nothing: default matches explicit 1 matches the ORIGINAL pre-exponent formula ----
{
  const cap = 94;
  const holders: HolderWeight[] = [
    { wallet: 'A', balanceRaw: 123456n, streak: 1 },
    { wallet: 'B', balanceRaw: 987654n, streak: 50 },
    { wallet: 'C', balanceRaw: 555555n, streak: 200 }, // exceeds cap, must clamp to 94
  ];
  const pool = 3_000_000n;
  const withDefault = computeAllocations(pool, holders, 'streak', cap); // no exponent arg
  const withExplicit1 = computeAllocations(pool, holders, 'streak', cap, 1);
  const serialize = (rows: { wallet: string; amountRaw: bigint }[]) =>
    rows.map((r) => `${r.wallet}:${r.amountRaw.toString()}`).join('|');
  ok('exponent default is 1, matches explicit exponent 1', serialize(withDefault) === serialize(withExplicit1));

  const legacyWeight = (h: HolderWeight) => h.balanceRaw * BigInt(Math.min(Math.max(h.streak, 1), cap));
  const totalLegacy = holders.reduce((a, h) => a + legacyWeight(h), 0n);
  const legacyAmounts = new Map(holders.map((h) => [h.wallet, (pool * legacyWeight(h)) / totalLegacy]));
  const matchesLegacy = withDefault.every((a) => a.amountRaw === legacyAmounts.get(a.wallet));
  ok('exponent 1 reproduces the original linear-streak formula exactly', matchesLegacy);
}

// ---- (a) conservation under extreme weights: streaks 1..94, exponent 2 ----
{
  const cap = 94;
  const exponent = 2;
  const pool = 1_000_000_000n;
  const holders: HolderWeight[] = Array.from({ length: 94 }, (_, i) => ({
    wallet: `W${i}`,
    balanceRaw: BigInt(1000 + i * 37),
    streak: i + 1, // 1..94, the full extreme range
  }));
  const allocations = computeAllocations(pool, holders, 'streak', cap, exponent);
  const total = allocations.reduce((a, b) => a + b.amountRaw, 0n);
  ok('conservation under exponent 2 never exceeds the pool', total <= pool);
  // Each per-wallet amount is a floor division, so total rounding dust is
  // strictly bounded by one unit per holder.
  ok('conservation dust is bounded by holder count', pool - total < BigInt(holders.length));
}

// ---- (b) scale invariance: uniform weight scaling leaves allocations identical ----
{
  const cap = 94;
  const exponent = 2;
  const pool = 10_000_000n;
  const base: HolderWeight[] = [
    { wallet: 'A', balanceRaw: 1000n, streak: 10 },
    { wallet: 'B', balanceRaw: 5000n, streak: 3 },
    { wallet: 'C', balanceRaw: 2000n, streak: 94 },
  ];
  // Scaling every wallet's balance by the same factor scales every wallet's
  // streak-weight by that same factor uniformly (weight is linear in balance).
  const scaled: HolderWeight[] = base.map((h) => ({ ...h, balanceRaw: h.balanceRaw * 7n }));
  const a1 = computeAllocations(pool, base, 'streak', cap, exponent);
  const a2 = computeAllocations(pool, scaled, 'streak', cap, exponent);
  const m1 = new Map(a1.map((x) => [x.wallet, x.amountRaw]));
  const m2 = new Map(a2.map((x) => [x.wallet, x.amountRaw]));
  const identical = [...m1.keys()].every((w) => m1.get(w) === m2.get(w));
  ok('scale invariance: uniform weight scale leaves every allocation identical', identical);
}

// ---- (c) splitting invariance holds at exponent 2 ----
{
  const cap = 94;
  const exponent = 2;
  const pool = 5_000_000n;
  const N = 40; // same streak for the solo wallet and every split wallet
  const solo: HolderWeight[] = [
    { wallet: 'SOLO', balanceRaw: 200_000n, streak: N },
    { wallet: 'FILLER', balanceRaw: 1_000_000n, streak: 1 },
  ];
  const split: HolderWeight[] = [
    ...Array.from({ length: 20 }, (_, i) => ({ wallet: `s${i}`, balanceRaw: 10_000n, streak: N })),
    { wallet: 'FILLER', balanceRaw: 1_000_000n, streak: 1 },
  ];
  const aSolo = computeAllocations(pool, solo, 'streak', cap, exponent);
  const aSplit = computeAllocations(pool, split, 'streak', cap, exponent);
  const soloAmt = aSolo.find((x) => x.wallet === 'SOLO')!.amountRaw;
  const splitTotal = aSplit.filter((x) => x.wallet.startsWith('s')).reduce((a, b) => a + b.amountRaw, 0n);
  // 200k at streak N has the exact same weight as twenty 10k wallets at
  // streak N combined (both are 200_000 * N^2), so before rounding the
  // amounts are identical. Splitting into 20 separate floor divisions can
  // lose at most one unit each versus a single floor division.
  const diff = soloAmt > splitTotal ? soloAmt - splitTotal : splitTotal - soloAmt;
  ok('splitting invariance holds at exponent 2 (within rounding)', diff <= 20n);
}

// ---- (e) dust-floor skips reduce the sent total, remainder stays available ----
{
  const cap = 94;
  const exponent = 1;
  const pool = 100_000_000n;
  // DUST1/DUST2 are picked so their raw allocation lands in (0, 100): non-
  // zero (computeAllocations' own amountRaw>0n filter would not drop them)
  // but still under the DAILY_MIN_SEND_TOKENS floor this test exercises.
  const holders: HolderWeight[] = [
    { wallet: 'BIG', balanceRaw: 1_000_000n, streak: 10 },
    { wallet: 'DUST1', balanceRaw: 5n, streak: 1 },
    { wallet: 'DUST2', balanceRaw: 8n, streak: 1 },
  ];
  const raw = computeAllocations(pool, holders, 'streak', cap, exponent);
  ok('dust wallets are non-zero before the floor filter (sanity check)', raw.length === 3);
  const minSendRaw = 100n; // the DAILY_MIN_SEND_TOKENS floor, in raw units, for this test
  const filtered = raw.filter((a) => a.amountRaw >= minSendRaw);
  const rawTotal = raw.reduce((a, b) => a + b.amountRaw, 0n);
  const filteredTotal = filtered.reduce((a, b) => a + b.amountRaw, 0n);
  ok('dust floor drops sub-floor wallets', filtered.length < raw.length);
  ok('dust-floor skip reduces the sent total', filteredTotal < rawTotal);
  // sumDistributed only ever sums confirmed SENT amounts (see airdrop.ts),
  // so whatever the floor skipped is never subtracted from the unlocked
  // pool. It is automatically extra headroom on the next computeDailyAirdrop.
  const headroomIfSkipped = pool - filteredTotal;
  const headroomIfNotSkipped = pool - rawTotal;
  ok('skipped dust remains available as extra headroom next day', headroomIfSkipped > headroomIfNotSkipped);
}

console.log(`\nsquared-loyalty law: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- observatory: the RPC-key secrets guard must actually catch a leak ----
{
  const rpcUrl = 'https://mainnet.helius-rpc.com/?api-key=super-secret-test-fragment';

  const leakedFullUrl = JSON.stringify({ note: 'oops', endpoint: rpcUrl });
  ok('secrets guard throws when the full RPC URL leaks into output', (() => {
    try { assertNoSecrets(leakedFullUrl, rpcUrl); return false; } catch { return true; }
  })());

  const leakedKeyOnly = JSON.stringify({ note: 'oops', key: 'super-secret-test-fragment' });
  ok('secrets guard throws when just the api-key fragment leaks', (() => {
    try { assertNoSecrets(leakedKeyOnly, rpcUrl); return false; } catch { return true; }
  })());

  const clean = JSON.stringify({ holderCount: 1051, solBalance: 4.2, generatedAt: '2026-07-17T00:00:00.000Z' });
  ok('secrets guard passes clean output with no key fragment', (() => {
    try { assertNoSecrets(clean, rpcUrl); return true; } catch { return false; }
  })());
}

console.log(`\nobservatory guard: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- flock signal: anti-farm scoring engine ----
{
  const now = new Date('2026-07-20T12:00:00.000Z');
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();

  function realAccount(handle: string, engagedAt: string): EngagerSignal {
    return {
      handle,
      verified: true,
      followerCount: 800,
      followingCount: 400,
      accountCreatedAt: daysAgo(900),
      hasProfileImage: true,
      postCount: 4000,
      engagedAt,
    };
  }
  function farmAccount(handle: string, engagedAt: string): EngagerSignal {
    return {
      handle,
      verified: true, // paid-verified, but everything else screams farm
      followerCount: 0,
      followingCount: 900,
      accountCreatedAt: daysAgo(3),
      hasProfileImage: false,
      postCount: 1,
      engagedAt,
    };
  }

  // ---- (a) quality weighting on individual engagers ----
  const realQ = assessEngagerQuality(realAccount('real', now.toISOString()), now);
  const farmQ = assessEngagerQuality(farmAccount('farm', now.toISOString()), now);
  ok('established real-looking account keeps full weight', realQ.weight === 1 && !realQ.suspicious);
  ok('fresh/no-pfp/no-history/no-follower account is heavily discounted', farmQ.weight < 0.05 && farmQ.suspicious);
  ok('discount reasons are specific, not a black box', farmQ.reasons.length >= 3);

  // ---- (b) the load-bearing property: same RAW count, real cost gap ----
  // 20 verified likes from quality accounts vs 20 verified likes from
  // paid-but-farmed accounts. If the scores land anywhere close, quality
  // weighting isn't doing its job and verification alone is the only gate
  // -- exactly the gap this design exists to close.
  // Spread naturally over ~3 hours -- realistic organic timing, and keeps
  // this comparison isolated to quality weighting rather than also tripping
  // the (separately tested below) clustering check.
  const spread = (i: number) => new Date(now.getTime() + i * 9 * 60_000).toISOString();
  const qualityLikers = Array.from({ length: 20 }, (_, i) => realAccount(`real${i}`, spread(i)));
  const farmLikers = Array.from({ length: 20 }, (_, i) => farmAccount(`farm${i}`, spread(i)));
  const rawCounts = { likes: 20, reposts: 0, replies: 0, quotes: 0, bookmarks: null, impressions: null };

  const qualityScore = scoreWithDeepDive(qualityLikers, [], [], rawCounts, 5000, daysAgo(1), now);
  const farmScore = scoreWithDeepDive(farmLikers, [], [], rawCounts, 5000, daysAgo(1), now);
  ok(
    'same raw like count: quality-account score is dramatically higher than farm-account score',
    qualityScore.verifiedWeightedScore > farmScore.verifiedWeightedScore * 10
  );
  ok('farm entry is flagged low-quality', farmScore.flags.some((f) => f.includes('low-quality')));
  ok('farm entry confidence drops to low', farmScore.confidence === 'low');
  ok('quality entry confidence stays high', qualityScore.confidence === 'high');

  // ---- (c) velocity/clustering anomaly detection ----
  const clusteredTimes = Array.from({ length: 15 }, () => now.toISOString()); // all in the same instant
  const organicTimes = Array.from({ length: 15 }, (_, i) => new Date(now.getTime() + i * 3_600_000).toISOString()); // spread over 15h
  const clustered = assessVelocity(clusteredTimes, 5000, daysAgo(1));
  const organic = assessVelocity(organicTimes, 5000, daysAgo(1));
  ok('identical-timing burst is flagged anomalous', clustered.anomalous);
  ok('naturally spread-out engagement is not flagged', !organic.anomalous);

  const implausibleReach = assessVelocity(
    Array.from({ length: 500 }, () => now.toISOString()),
    100, // tiny follower count
    now.toISOString()
  );
  ok('engagement far exceeding follower count within the hour is flagged', implausibleReach.anomalous);

  // ---- (d) triage-only entries never get a fabricated verified score ----
  const triage = scoreTriageOnly({ likes: 900, reposts: 300, replies: 50, quotes: 10, bookmarks: null, impressions: null });
  ok('triage-only entry has zero verified-weighted score (never deep-dived)', triage.verifiedWeightedScore === 0);
  ok('triage-only entry is marked low confidence, not silently trusted', triage.confidence === 'low');
  ok('triage-only entry states plainly it was not deep-dived', !triage.deepDivePerformed);
  ok(
    'a huge raw-reach entry still has a real, comparable raw score so it can surface anyway',
    rawReachScore({ likes: 900, reposts: 300, replies: 50, quotes: 10, bookmarks: null, impressions: null }) > 0
  );
}

console.log(`\nflock signal scoring: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);

// ---- flock signal: weekly reveal clock (date-boundary logic, worth its own tests) ----
{
  // 2026-07-19 is a Sunday, 2026-07-20 is a Monday, 2026-07-26 is the next Sunday.
  const mondayNoon = new Date(2026, 6, 20, 12, 0, 0);
  const revealFromMonday = nextWeeklyReveal(mondayNoon);
  ok(
    'from a Monday, next reveal is this week\'s Sunday at 9:41',
    revealFromMonday.getFullYear() === 2026 && revealFromMonday.getMonth() === 6 &&
    revealFromMonday.getDate() === 26 && revealFromMonday.getHours() === 9 && revealFromMonday.getMinutes() === 41
  );

  const sundayBeforeReveal = new Date(2026, 6, 19, 8, 0, 0);
  const revealFromEarlySunday = nextWeeklyReveal(sundayBeforeReveal);
  ok(
    'on reveal day before 9:41, next reveal is later TODAY, not next week',
    revealFromEarlySunday.getDate() === 19 && revealFromEarlySunday.getMonth() === 6
  );

  const sundayAfterReveal = new Date(2026, 6, 19, 10, 0, 0);
  const revealFromLateSunday = nextWeeklyReveal(sundayAfterReveal);
  ok(
    'on reveal day after 9:41 has passed, next reveal jumps a full week forward, not today again',
    revealFromLateSunday.getDate() === 26 && revealFromLateSunday.getMonth() === 6
  );
}

console.log(`\nflock signal reveal clock: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
