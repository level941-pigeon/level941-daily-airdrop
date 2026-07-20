// Flock Signal's anti-farm scoring engine. Pure functions, no network calls
// -- this is the part that has to be provably correct, and the part that
// can actually BE proven correct without an X API token, unlike the crawler.
//
// Core principle: verified engagement counts toward the main score first,
// because X Premium/verification imposes a real recurring dollar cost on
// whoever controls the account. That alone raises the price of farming.
// Quality-weighting on top of that discounts verified engagement that still
// looks synthetic (fresh, history-free, no-pfp, mass-follow accounts), so
// a farm of PAID-but-fake accounts doesn't just walk through the front door.
//
// This ranks. It never decides a payout. There is no reward-execution code
// anywhere in this file or anywhere in Flock Signal.

export interface EngagerSignal {
  handle: string;
  verified: boolean;
  followerCount: number;
  followingCount: number;
  accountCreatedAt: string; // ISO
  hasProfileImage: boolean;
  postCount: number; // lifetime post count, a rough "is this a real account" signal
  engagedAt: string; // ISO, when this like/repost/reply happened
}

export interface QualityAssessment {
  weight: number; // 0..1 multiplier applied to this engager's contribution
  suspicious: boolean;
  reasons: string[];
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, (b.getTime() - a.getTime()) / 86_400_000);
}

// Each rule multiplies the running weight and records why, rather than an
// outright disqualify -- a fresh-but-real account and a burst-farmed one
// both look "new," so this discounts instead of zeroing, and lets multiple
// weak signals compound into a strong one instead of one signal deciding
// everything.
export function assessEngagerQuality(engager: EngagerSignal, now: Date): QualityAssessment {
  let weight = 1;
  const reasons: string[] = [];
  const accountAgeDays = daysBetween(new Date(engager.accountCreatedAt), now);

  if (accountAgeDays < 7) {
    weight *= 0.1;
    reasons.push('account created <7 days ago');
  } else if (accountAgeDays < 30) {
    weight *= 0.3;
    reasons.push('account created <30 days ago');
  }

  if (!engager.hasProfileImage) {
    weight *= 0.5;
    reasons.push('no profile image');
  }

  if (engager.postCount < 5) {
    weight *= 0.3;
    reasons.push('fewer than 5 posts ever');
  }

  if (engager.followerCount === 0) {
    weight *= 0.2;
    reasons.push('zero followers');
  } else if (engager.followingCount > 500 && engager.followerCount / engager.followingCount < 0.02) {
    weight *= 0.4;
    reasons.push('mass-follow pattern (follows 50x+ more than is followed back)');
  }

  weight = Math.max(0, Math.min(1, weight));
  return { weight, suspicious: weight < 0.5, reasons };
}

export interface VelocityAssessment {
  anomalous: boolean;
  reasons: string[];
}

// Clustering + reach-implausibility checks. Thresholds are deliberately
// conservative (few false positives on real virality) since a false flag
// on a genuine winner is worse than missing a subtle farm.
export function assessVelocity(
  engagementTimestamps: string[],
  authorFollowerCount: number,
  postCreatedAt: string
): VelocityAssessment {
  const reasons: string[] = [];
  if (engagementTimestamps.length === 0) return { anomalous: false, reasons };

  const times = engagementTimestamps.map((t) => new Date(t).getTime()).sort((a, b) => a - b);

  // Identical-timing clustering: >30% of engagement landing in the same
  // 60-second bucket is not how organic engagement arrives.
  const buckets = new Map<number, number>();
  for (const t of times) {
    const bucket = Math.floor(t / 60_000);
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  const maxBucket = Math.max(...buckets.values());
  if (maxBucket / times.length > 0.3 && times.length >= 10) {
    reasons.push(`${maxBucket} of ${times.length} engagements landed in the same 60s window`);
  }

  // Reach implausibility: organic engagement from more than ~40% of an
  // author's follower count within the first hour is extremely rare even
  // for a genuinely viral post -- it usually means bought/farmed reach.
  const postMs = new Date(postCreatedAt).getTime();
  const withinFirstHour = times.filter((t) => t - postMs <= 3_600_000).length;
  if (authorFollowerCount > 0 && withinFirstHour / authorFollowerCount > 0.4) {
    reasons.push(`${withinFirstHour} engagements within 1h vs ${authorFollowerCount} followers`);
  }

  return { anomalous: reasons.length > 0, reasons };
}

export interface RawCounts {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number | null;
  impressions: number | null;
}

export interface ScoredEntry {
  verifiedWeightedScore: number;
  verifiedBreakdown: { likes: number; reposts: number; replies: number };
  unverifiedBreakdown: { likes: number; reposts: number; replies: number };
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
  deepDivePerformed: boolean;
}

// Reposts amplify reach further than a like; replies show deeper
// engagement than either. These multipliers are a judgment call, made
// explicit here rather than buried, and easy to retune.
const TYPE_WEIGHT = { like: 1, repost: 3, reply: 2 };

function weightedSum(engagers: EngagerSignal[], typeWeight: number, now: Date): number {
  return engagers.reduce((sum, e) => sum + typeWeight * assessEngagerQuality(e, now).weight, 0);
}

// Deep-dive path: full engager-level data was pulled (the expensive X API
// calls), so verified status and quality weighting are real, not guessed.
export function scoreWithDeepDive(
  verifiedLikers: EngagerSignal[],
  verifiedReposters: EngagerSignal[],
  verifiedRepliers: EngagerSignal[],
  unverifiedCounts: RawCounts,
  authorFollowerCount: number,
  postCreatedAt: string,
  now: Date
): ScoredEntry {
  const verifiedWeightedScore =
    weightedSum(verifiedLikers, TYPE_WEIGHT.like, now) +
    weightedSum(verifiedReposters, TYPE_WEIGHT.repost, now) +
    weightedSum(verifiedRepliers, TYPE_WEIGHT.reply, now);

  const flags: string[] = [];
  const allEngagers = [...verifiedLikers, ...verifiedReposters, ...verifiedRepliers];
  const suspiciousCount = allEngagers.filter((e) => assessEngagerQuality(e, now).suspicious).length;
  if (allEngagers.length > 0 && suspiciousCount / allEngagers.length > 0.4) {
    flags.push(`${suspiciousCount} of ${allEngagers.length} verified engagers look low-quality (fresh/no-history/no-pfp)`);
  }

  const velocity = assessVelocity(
    allEngagers.map((e) => e.engagedAt),
    authorFollowerCount,
    postCreatedAt
  );
  if (velocity.anomalous) flags.push(...velocity.reasons);

  const verifiedCount = verifiedLikers.length + verifiedReposters.length + verifiedRepliers.length;
  let confidence: ScoredEntry['confidence'] = 'high';
  if (flags.length > 0 || verifiedCount < 5) confidence = 'medium';
  if (verifiedCount === 0 || suspiciousCount / Math.max(1, allEngagers.length) > 0.6) confidence = 'low';

  return {
    verifiedWeightedScore,
    verifiedBreakdown: {
      likes: verifiedLikers.length,
      reposts: verifiedReposters.length,
      replies: verifiedRepliers.length,
    },
    unverifiedBreakdown: {
      likes: Math.max(0, unverifiedCounts.likes - verifiedLikers.length),
      reposts: Math.max(0, unverifiedCounts.reposts - verifiedReposters.length),
      replies: Math.max(0, unverifiedCounts.replies - verifiedRepliers.length),
    },
    confidence,
    flags,
    deepDivePerformed: true,
  };
}

// Triage path: only raw counts are known (no per-engager resolution spent
// on this entry). This is intentionally NOT given a real verified-weighted
// score -- confidence stays "low" and it's ranked separately by raw reach,
// exactly so a huge-but-unverified post still surfaces without being
// mistaken for a verified winner it was never checked against.
export function scoreTriageOnly(raw: RawCounts): ScoredEntry {
  return {
    verifiedWeightedScore: 0,
    verifiedBreakdown: { likes: 0, reposts: 0, replies: 0 },
    unverifiedBreakdown: { likes: raw.likes, reposts: raw.reposts, replies: raw.replies },
    confidence: 'low',
    flags: ['not deep-dived this week (outside the budget-capped shortlist) -- ranked by raw reach only'],
    deepDivePerformed: false,
  };
}

export function rawReachScore(raw: RawCounts): number {
  return raw.likes * TYPE_WEIGHT.like + raw.reposts * TYPE_WEIGHT.repost + raw.replies * TYPE_WEIGHT.reply;
}
