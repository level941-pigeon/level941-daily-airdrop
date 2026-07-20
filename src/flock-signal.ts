// Flock Signal: read-only, cost-bounded discovery + scoring pipeline for
// the weekly meme leaderboard. Entirely independent of the airdrop wallet
// and the poller -- its only credential is a read-only X API bearer token,
// its only shared file convention is writing into docs/ like board.ts does.
//
// HONESTY NOTE: the API client functions in this file are written against
// X API v2's documented endpoint shapes (search/recent, liking_users,
// retweeted_by, users lookup) but have NOT been exercised against a live
// X API account in this environment -- there is no X_API_BEARER_TOKEN
// configured here. The scoring math they feed (flock-signal-scoring.ts) is
// unit-tested and proven; the wire format below should be treated as
// "correct per the docs, unverified in practice" until run for real.
//
// Cost model (docs.x.com/x-api/getting-started/pricing, fetched 2026-07-20):
// posts $0.005/read, users $0.010/read, likes $0.001/read. The repost-read
// rate is NOT separately published for retweeted_by; it's inferred here as
// the $0.010 "users" rate since that endpoint returns full user objects.
// That one constant is a guess, not a confirmed number -- verify it against
// a real billing statement before trusting the cost ledger's precision.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EngagerSignal,
  RawCounts,
  ScoredEntry,
  scoreWithDeepDive,
  scoreTriageOnly,
  rawReachScore,
} from './flock-signal-scoring.js';

const RATE_USD = {
  postRead: 0.005,
  userRead: 0.010,
  likeRead: 0.001,
  repostRead: 0.010, // INFERRED -- see file header
};

const X_API_BASE = 'https://api.x.com/2';

interface FlockSignalConfig {
  bearerToken: string;
  monthlyCapUsd: number;
  weeklyShortlistSize: number;
  searchQuery: string;
  dataDir: string;
  docsDir: string;
}

function loadConfig(): FlockSignalConfig {
  const bearerToken = process.env.X_API_BEARER_TOKEN?.trim();
  if (!bearerToken) {
    throw new Error(
      'X_API_BEARER_TOKEN is not set. Flock Signal needs a read-only X API bearer token -- ' +
        'a separate credential from AIRDROP_PRIVATE_KEY/RPC_URL, never touching the wallet config.'
    );
  }
  return {
    bearerToken,
    monthlyCapUsd: Number(process.env.FLOCK_SIGNAL_MONTHLY_CAP_USD ?? '100'),
    weeklyShortlistSize: Number(process.env.FLOCK_SIGNAL_SHORTLIST_SIZE ?? '30'),
    searchQuery: process.env.FLOCK_SIGNAL_SEARCH_QUERY ?? '(@level941 OR #level941) -is:retweet',
    // Deliberately NOT data/ -- that directory is gitignored project-wide
    // ("never leaves this machine"). This state has to survive across
    // GitHub Actions runs, which get a fresh checkout every time with no
    // persistent disk, so it needs to actually be committed. It's also not
    // sensitive: a spend ledger and per-post scores that are already public
    // on X, so tracking it in git costs nothing and doubles as an audit
    // trail of the budget cap actually being enforced.
    dataDir: process.env.FLOCK_SIGNAL_DATA_DIR ?? path.join(process.cwd(), 'flock-signal-state'),
    docsDir: process.env.FLOCK_SIGNAL_DOCS_DIR ?? path.join(process.cwd(), 'docs'),
  };
}

// ---------- budget ledger ----------
// Self-tracked, not read back from X's own billing API (whose exact shape
// I could not confirm without a live account). This is a spending ESTIMATE
// used to enforce the hard cap -- cross-check against the real X billing
// dashboard periodically rather than trusting this number alone.

interface UsageLedger {
  month: string; // YYYY-MM
  spentUsd: number;
}

function ledgerPath(cfg: FlockSignalConfig): string {
  return path.join(cfg.dataDir, 'flock-signal-usage.json');
}

function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function loadLedger(cfg: FlockSignalConfig): UsageLedger {
  const f = ledgerPath(cfg);
  const month = currentMonth();
  if (!fs.existsSync(f)) return { month, spentUsd: 0 };
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as UsageLedger;
    if (parsed.month !== month) return { month, spentUsd: 0 }; // new billing month, reset
    return parsed;
  } catch {
    return { month, spentUsd: 0 };
  }
}

function saveLedger(cfg: FlockSignalConfig, ledger: UsageLedger): void {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(ledgerPath(cfg), JSON.stringify(ledger, null, 2) + '\n', 'utf8');
}

// Records spend AFTER a call succeeds and refuses to run anything that
// would cross the cap BEFORE it happens -- the ledger is checked, not just
// updated, so a capped-out month actually stops calling the API rather
// than noticing after the fact.
function chargeOrSkip(ledger: UsageLedger, cfg: FlockSignalConfig, estimateUsd: number, label: string): boolean {
  if (ledger.spentUsd + estimateUsd > cfg.monthlyCapUsd) {
    console.log(
      `BUDGET GUARD: ${label} (~$${estimateUsd.toFixed(3)}) would cross the $${cfg.monthlyCapUsd} monthly cap ` +
        `(spent so far: $${ledger.spentUsd.toFixed(3)}). Skipping.`
    );
    return false;
  }
  ledger.spentUsd += estimateUsd;
  return true;
}

// ---------- X API client (documented shape, untested live -- see header) ----------

async function xApiGet<T>(cfg: FlockSignalConfig, urlPath: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`${X_API_BASE}${urlPath}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${cfg.bearerToken}` },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`X API ${res.status} on ${urlPath}: ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface XUser {
  id: string;
  username: string;
  verified?: boolean;
  created_at?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
}

interface XPost {
  id: string;
  author_id: string;
  created_at: string;
  text: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    bookmark_count?: number;
    impression_count?: number;
  };
}

export interface CandidatePost {
  postId: string;
  postUrl: string;
  authorHandle: string;
  authorId: string;
  authorVerified: boolean;
  authorFollowerCount: number;
  postedAt: string;
  rawMetrics: RawCounts;
}

function toEngagerSignal(u: XUser, engagedAt: string): EngagerSignal {
  return {
    handle: u.username,
    verified: u.verified ?? false,
    followerCount: u.public_metrics?.followers_count ?? 0,
    followingCount: u.public_metrics?.following_count ?? 0,
    accountCreatedAt: u.created_at ?? new Date(0).toISOString(),
    hasProfileImage: Boolean(u.profile_image_url) && !u.profile_image_url?.includes('default_profile'),
    postCount: u.public_metrics?.tweet_count ?? 0,
    engagedAt,
  };
}

// Stage 1: discovery. Cheap -- public_metrics ride along with the base
// post read, no extra cost beyond the $0.005/post charge.
export async function discoverCandidates(cfg: FlockSignalConfig, ledger: UsageLedger): Promise<CandidatePost[]> {
  const out: CandidatePost[] = [];
  let nextToken: string | undefined;
  do {
    const params: Record<string, string> = {
      query: cfg.searchQuery,
      max_results: '100',
      'tweet.fields': 'created_at,public_metrics,author_id',
      expansions: 'author_id',
      'user.fields': 'verified,public_metrics',
    };
    if (nextToken) params.next_token = nextToken;

    const page = await xApiGet<{
      data?: XPost[];
      includes?: { users?: XUser[] };
      meta?: { next_token?: string };
    }>(cfg, '/tweets/search/recent', params);

    const pageCount = page.data?.length ?? 0;
    if (!chargeOrSkip(ledger, cfg, pageCount * RATE_USD.postRead, `discovery page (${pageCount} posts)`)) break;

    const usersById = new Map((page.includes?.users ?? []).map((u) => [u.id, u]));
    for (const post of page.data ?? []) {
      const author = usersById.get(post.author_id);
      out.push({
        postId: post.id,
        postUrl: `https://x.com/${author?.username ?? 'i'}/status/${post.id}`,
        authorHandle: author?.username ?? 'unknown',
        authorId: post.author_id,
        authorVerified: author?.verified ?? false,
        authorFollowerCount: author?.public_metrics?.followers_count ?? 0,
        postedAt: post.created_at,
        rawMetrics: {
          likes: post.public_metrics?.like_count ?? 0,
          reposts: post.public_metrics?.retweet_count ?? 0,
          replies: post.public_metrics?.reply_count ?? 0,
          quotes: post.public_metrics?.quote_count ?? 0,
          bookmarks: post.public_metrics?.bookmark_count ?? null,
          impressions: post.public_metrics?.impression_count ?? null,
        },
      });
    }
    nextToken = page.meta?.next_token;
  } while (nextToken);
  return out;
}

async function fetchEngagers(
  cfg: FlockSignalConfig,
  ledger: UsageLedger,
  postId: string,
  endpoint: 'liking_users' | 'retweeted_by',
  rate: number,
  engagedAtFallback: string
): Promise<EngagerSignal[]> {
  const label = `${endpoint} for ${postId}`;
  const page = await xApiGet<{ data?: XUser[] }>(cfg, `/tweets/${postId}/${endpoint}`, {
    max_results: '100',
    'user.fields': 'verified,created_at,profile_image_url,public_metrics',
  });
  const users = page.data ?? [];
  if (!chargeOrSkip(ledger, cfg, users.length * rate, label)) return [];
  return users.map((u) => toEngagerSignal(u, engagedAtFallback));
}

// Stage 3: deep-dive for one shortlisted post. Every call here is the
// expensive part and is individually budget-gated -- a capped-out month
// stops mid-shortlist rather than blowing through the ceiling on the last
// few entries.
export async function deepDiveOne(cfg: FlockSignalConfig, ledger: UsageLedger, post: CandidatePost): Promise<ScoredEntry> {
  const likers = await fetchEngagers(cfg, ledger, post.postId, 'liking_users', RATE_USD.likeRead, post.postedAt);
  const reposters = await fetchEngagers(cfg, ledger, post.postId, 'retweeted_by', RATE_USD.repostRead, post.postedAt);
  // Replies are posts (conversation_id search), scored as a Posts read;
  // resolving each replier's own verified status would add a Users read
  // per reply -- left out of v1 to keep the shortlist cost predictable.
  // Reply COUNT still comes from public_metrics at no extra cost.
  return scoreWithDeepDive(
    likers.filter((l) => l.verified),
    reposters.filter((r) => r.verified),
    [],
    post.rawMetrics,
    post.authorFollowerCount,
    post.postedAt,
    new Date()
  );
}

export interface FlockSignalEntry extends CandidatePost {
  score: ScoredEntry;
  rawReach: number;
}

export async function runFlockSignalCrawl(): Promise<FlockSignalEntry[]> {
  const cfg = loadConfig();
  const ledger = loadLedger(cfg);

  const candidates = await discoverCandidates(cfg, ledger);
  const withReach = candidates.map((c) => ({ ...c, rawReach: rawReachScore(c.rawMetrics) }));
  withReach.sort((a, b) => b.rawReach - a.rawReach);

  const shortlist = withReach.slice(0, cfg.weeklyShortlistSize);
  const restOfField = withReach.slice(cfg.weeklyShortlistSize);

  const results: FlockSignalEntry[] = [];
  for (const post of shortlist) {
    try {
      const score = await deepDiveOne(cfg, ledger, post);
      results.push({ ...post, score });
    } catch (e) {
      console.log(`Deep-dive failed for ${post.postId}: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ ...post, score: scoreTriageOnly(post.rawMetrics) });
    }
    saveLedger(cfg, ledger); // persist after every entry, not just at the end
  }
  for (const post of restOfField) {
    results.push({ ...post, score: scoreTriageOnly(post.rawMetrics) });
  }

  saveLedger(cfg, ledger);
  console.log(
    `Flock Signal crawl: ${candidates.length} candidates, ${shortlist.length} deep-dived, ` +
      `$${ledger.spentUsd.toFixed(3)} of $${cfg.monthlyCapUsd} monthly cap spent.`
  );
  return results;
}

// ---------- weekly reveal clock ----------
// Same ritual as 9:41, weekly: next Sunday at 9:41 local time.
export function nextWeeklyReveal(now: Date = new Date()): Date {
  const candidate = new Date(now);
  candidate.setHours(9, 41, 0, 0);
  const daysUntilSunday = (7 - candidate.getDay()) % 7;
  candidate.setDate(candidate.getDate() + daysUntilSunday);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate;
}

function currentWeekOf(now: Date = new Date()): string {
  const reveal = nextWeeklyReveal(now);
  const monday = new Date(reveal);
  monday.setDate(monday.getDate() - 6); // Sunday reveal - 6 days = the Monday that started this contest week
  return monday.toISOString().slice(0, 10);
}

// ---------- week-over-week momentum (within-week history, honest not fabricated) ----------

interface WeekHistory {
  weekOf: string;
  firstScoreSeen: Record<string, number>; // postId -> the score the first time it was scanned this week
}

function weekHistoryPath(cfg: FlockSignalConfig): string {
  return path.join(cfg.dataDir, 'flock-signal-week-history.json');
}

function loadWeekHistory(cfg: FlockSignalConfig, weekOf: string): WeekHistory {
  const f = weekHistoryPath(cfg);
  if (fs.existsSync(f)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(f, 'utf8')) as WeekHistory;
      if (parsed.weekOf === weekOf) return parsed;
    } catch {
      /* fall through to fresh */
    }
  }
  return { weekOf, firstScoreSeen: {} };
}

function saveWeekHistory(cfg: FlockSignalConfig, history: WeekHistory): void {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.writeFileSync(weekHistoryPath(cfg), JSON.stringify(history, null, 2) + '\n', 'utf8');
}

// ---------- publish ----------

export interface HallOfFameEntry {
  weekOf: string;
  postId: string;
  postUrl: string;
  authorHandle: string;
  verifiedWeightedScore: number;
}

export interface FlockSignalPublicEntry {
  rank: number | null; // null for triage-only entries (never given a fabricated verified rank)
  postId: string;
  postUrl: string;
  authorHandle: string;
  postedAt: string;
  verifiedWeightedScore: number;
  rawReach: number;
  verifiedBreakdown: { likes: number; reposts: number; replies: number };
  unverifiedBreakdown: { likes: number; reposts: number; replies: number };
  confidence: 'high' | 'medium' | 'low';
  flags: string[];
  deepDivePerformed: boolean;
  statusLabels: string[];
}

export interface FlockSignalData {
  generatedAt: string;
  weekOf: string;
  nextReveal: string;
  totals: {
    totalEntries: number;
    deepDivedCount: number;
    uniqueCreators: number;
  };
  entries: FlockSignalPublicEntry[];
  hallOfFame: HallOfFameEntry[];
}

function statusLabelsFor(
  entry: FlockSignalEntry,
  rank: number | null,
  deepDivedRankedCount: number,
  rawReachPercentile: number,
  momentum: boolean
): string[] {
  const labels: string[] = [];
  if (rank === 1) labels.push("This Week's Leader");
  if (entry.score.deepDivePerformed) {
    labels.push('Human Review Finalist');
    if (rank !== null && rank <= 3 && entry.score.confidence === 'high') labels.push('High Signal');
  } else if (rawReachPercentile >= 0.9) {
    labels.push('Flagged Viral');
  }
  if (momentum) labels.push('Verified Momentum');
  void deepDivedRankedCount;
  return labels;
}

export async function publishFlockSignal(results: FlockSignalEntry[]): Promise<void> {
  const cfg = loadConfig();
  const now = new Date();
  const weekOf = currentWeekOf(now);

  const history = loadWeekHistory(cfg, weekOf);
  const uniqueCreators = new Set(results.map((r) => r.authorHandle)).size;

  const deepDived = results
    .filter((r) => r.score.deepDivePerformed)
    .sort((a, b) => b.score.verifiedWeightedScore - a.score.verifiedWeightedScore);
  const triageOnly = results.filter((r) => !r.score.deepDivePerformed).sort((a, b) => b.rawReach - a.rawReach);

  const allByReach = [...results].sort((a, b) => a.rawReach - b.rawReach);
  const reachRank = new Map(allByReach.map((r, i) => [r.postId, i / Math.max(1, allByReach.length - 1)]));

  const entries: FlockSignalPublicEntry[] = [];
  deepDived.forEach((r, i) => {
    const rank = i + 1;
    const firstSeen = history.firstScoreSeen[r.postId];
    if (firstSeen === undefined) history.firstScoreSeen[r.postId] = r.score.verifiedWeightedScore;
    const momentum = firstSeen !== undefined && firstSeen > 0 && r.score.verifiedWeightedScore > firstSeen * 1.2;
    entries.push({
      rank,
      postId: r.postId,
      postUrl: r.postUrl,
      authorHandle: r.authorHandle,
      postedAt: r.postedAt,
      verifiedWeightedScore: r.score.verifiedWeightedScore,
      rawReach: r.rawReach,
      verifiedBreakdown: r.score.verifiedBreakdown,
      unverifiedBreakdown: r.score.unverifiedBreakdown,
      confidence: r.score.confidence,
      flags: r.score.flags,
      deepDivePerformed: true,
      statusLabels: statusLabelsFor(r, rank, deepDived.length, reachRank.get(r.postId) ?? 0, momentum),
    });
  });
  triageOnly.forEach((r) => {
    entries.push({
      rank: null,
      postId: r.postId,
      postUrl: r.postUrl,
      authorHandle: r.authorHandle,
      postedAt: r.postedAt,
      verifiedWeightedScore: 0,
      rawReach: r.rawReach,
      verifiedBreakdown: r.score.verifiedBreakdown,
      unverifiedBreakdown: r.score.unverifiedBreakdown,
      confidence: r.score.confidence,
      flags: r.score.flags,
      deepDivePerformed: false,
      statusLabels: statusLabelsFor(r, null, deepDived.length, reachRank.get(r.postId) ?? 0, false),
    });
  });

  saveWeekHistory(cfg, history);

  // Hall of Fame accumulates from the board's OWN prior published state --
  // no separate private archive, so the history is exactly as recomputable
  // and auditable as everything else on this site.
  const outFile = path.join(cfg.docsDir, 'flock-signal.json');
  let hallOfFame: HallOfFameEntry[] = [];
  if (fs.existsSync(outFile)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outFile, 'utf8')) as FlockSignalData;
      hallOfFame = prior.hallOfFame ?? [];
      if (prior.weekOf && prior.weekOf !== weekOf) {
        const priorLeader = prior.entries.find((e) => e.rank === 1);
        if (priorLeader && !hallOfFame.some((h) => h.postId === priorLeader.postId)) {
          hallOfFame.push({
            weekOf: prior.weekOf,
            postId: priorLeader.postId,
            postUrl: priorLeader.postUrl,
            authorHandle: priorLeader.authorHandle,
            verifiedWeightedScore: priorLeader.verifiedWeightedScore,
          });
        }
      }
    } catch {
      /* no valid prior file, start fresh */
    }
  }

  const data: FlockSignalData = {
    generatedAt: now.toISOString(),
    weekOf,
    nextReveal: nextWeeklyReveal(now).toISOString(),
    totals: {
      totalEntries: results.length,
      deepDivedCount: deepDived.length,
      uniqueCreators,
    },
    entries,
    hallOfFame,
  };

  fs.mkdirSync(cfg.docsDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`Flock Signal published: ${entries.length} entries (${deepDived.length} deep-dived), week of ${weekOf}.`);
}

// Standalone entry point, same pattern as og-holders.ts and poller.ts: run
// directly (`tsx src/flock-signal.ts`), never through index.ts's shared
// dispatcher, which loads the full Solana wallet config unconditionally.
// This script's only required credential is X_API_BEARER_TOKEN.
const isDirectRun = process.argv[1]?.endsWith('flock-signal.ts');
if (isDirectRun) {
  runFlockSignalCrawl()
    .then((results) => publishFlockSignal(results))
    .then(() => process.exit(0))
    .catch((e) => {
      console.error('Error:', e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
