// Flock Signal: read-only, cost-bounded discovery + scoring pipeline for
// the weekly meme leaderboard. Entirely independent of the airdrop wallet
// and the poller -- its only credential is a read-only X API bearer token,
// its only shared file convention is writing into docs/ like board.ts does.
//
// Cost model (docs.x.com/x-api/getting-started/pricing, fetched 2026-07-20):
// posts $0.005/read, users $0.010/read, likes $0.001/read. The repost-read
// rate is NOT separately published for retweeted_by; it's inferred here as
// the $0.010 "users" rate since that endpoint returns full user objects.
// That one constant is a guess, not a confirmed number -- verify it against
// a real billing statement before trusting the cost ledger's precision.
//
// Two independent safety nets, both checked BEFORE spending/calling:
//   1. monthlyCapUsd -- a running dollar estimate, resets each billing month.
//   2. maxApiCallsPerRun -- a hard ceiling on raw HTTP calls in ONE run,
//      completely separate from the dollar math, so a pagination bug or
//      runaway loop hits a wall after N calls no matter how cheap each one
//      looks on paper. See MAX_DISCOVERY_PAGES below for the same idea
//      applied specifically to the one real loop in this file.

import 'dotenv/config';
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
  maxApiCallsPerRun: number;
  deepDiveEnabled: boolean;
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
    // Hard ceiling on raw API calls for a single run, independent of the
    // dollar cap above -- default covers full-scale normal use (a 30-post
    // shortlist costs ~70 calls: discovery pages + 2 calls/post deep-dive)
    // with real headroom, while still being a finite number a bug can't
    // loop past.
    maxApiCallsPerRun: Number(process.env.FLOCK_SIGNAL_MAX_API_CALLS_PER_RUN ?? '150'),
    // OFF by default. A live test run confirmed liking_users/retweeted_by
    // reject App-only bearer auth with a 403 ("Unsupported Authentication" --
    // they require OAuth 1.0a or OAuth 2.0 user context). That OAuth flow is
    // not being pursued right now, so deep-dive stays disabled and every
    // candidate gets triage-only (raw-reach) scoring for a human to judge by
    // hand. Flip to 'true' once user-context credentials exist.
    deepDiveEnabled: (process.env.FLOCK_SIGNAL_DEEP_DIVE_ENABLED ?? 'false') === 'true',
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

// Reserves the WORST-CASE cost of a call before it's made, and refuses to
// issue the call at all if that worst case would cross the cap -- checking
// after the response came back is too late, the real API charge already
// happened by then regardless of what our own ledger says. Call sites pass
// the max possible resource count for the request (e.g. max_results=100),
// then reconcileBudget() below true's it up to the actual count once the
// response is in hand.
function reserveBudget(ledger: UsageLedger, cfg: FlockSignalConfig, maxUsd: number, label: string): boolean {
  if (ledger.spentUsd + maxUsd > cfg.monthlyCapUsd) {
    console.log(
      `BUDGET GUARD: ${label} (up to $${maxUsd.toFixed(3)}) could cross the $${cfg.monthlyCapUsd} monthly cap ` +
        `(spent so far: $${ledger.spentUsd.toFixed(3)}). Skipping BEFORE calling -- no request sent.`
    );
    return false;
  }
  ledger.spentUsd += maxUsd;
  return true;
}

// Corrects the reservation down (or, if the API ever returned more than the
// requested max_results, up) to the actual resource count once known.
function reconcileBudget(ledger: UsageLedger, reservedUsd: number, actualUsd: number): void {
  ledger.spentUsd += actualUsd - reservedUsd;
}

// ---------- hard per-run call cap ----------
// Separate from the dollar ledger on purpose: a bug that loops without ever
// crossing the dollar cap (e.g. cheap calls in a tight loop) still gets
// stopped here after a fixed number of real HTTP requests.

export interface CallCounter {
  calls: number;
}

function noteApiCall(cfg: FlockSignalConfig, counter: CallCounter, label: string): void {
  counter.calls += 1;
  if (counter.calls > cfg.maxApiCallsPerRun) {
    throw new Error(
      `HARD STOP: exceeded maxApiCallsPerRun (${cfg.maxApiCallsPerRun}) at call #${counter.calls} (${label}). ` +
        `Aborting the run -- this is a safety ceiling independent of the dollar cap.`
    );
  }
}

// ---------- X API client ----------

async function xApiGet<T>(
  cfg: FlockSignalConfig,
  counter: CallCounter,
  urlPath: string,
  params: Record<string, string>
): Promise<T> {
  noteApiCall(cfg, counter, urlPath);
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

// Defense in depth alongside the global call counter: this is the one real
// loop in the file (X could in principle keep returning a next_token
// forever), so it gets its own explicit, small bound too.
const MAX_DISCOVERY_PAGES = 10;

// Stage 1: discovery. Cheap -- public_metrics ride along with the base
// post read, no extra cost beyond the $0.005/post charge.
export async function discoverCandidates(
  cfg: FlockSignalConfig,
  ledger: UsageLedger,
  counter: CallCounter
): Promise<CandidatePost[]> {
  const out: CandidatePost[] = [];
  let nextToken: string | undefined;
  let pageNum = 0;
  do {
    pageNum += 1;
    if (pageNum > MAX_DISCOVERY_PAGES) {
      console.log(`Discovery: hit MAX_DISCOVERY_PAGES (${MAX_DISCOVERY_PAGES}), stopping pagination early.`);
      break;
    }
    const params: Record<string, string> = {
      query: cfg.searchQuery,
      max_results: '100',
      'tweet.fields': 'created_at,public_metrics,author_id',
      expansions: 'author_id',
      'user.fields': 'verified,public_metrics',
    };
    if (nextToken) params.next_token = nextToken;

    const maxPageCostUsd = 100 * RATE_USD.postRead; // max_results is capped at 100
    if (!reserveBudget(ledger, cfg, maxPageCostUsd, `discovery page (up to 100 posts)`)) break;

    const page = await xApiGet<{
      data?: XPost[];
      includes?: { users?: XUser[] };
      meta?: { next_token?: string };
    }>(cfg, counter, '/tweets/search/recent', params);

    const pageCount = page.data?.length ?? 0;
    reconcileBudget(ledger, maxPageCostUsd, pageCount * RATE_USD.postRead);

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
  counter: CallCounter,
  postId: string,
  endpoint: 'liking_users' | 'retweeted_by',
  rate: number,
  engagedAtFallback: string
): Promise<EngagerSignal[]> {
  const label = `${endpoint} for ${postId}`;
  const maxCallCostUsd = 100 * rate; // max_results is capped at 100
  if (!reserveBudget(ledger, cfg, maxCallCostUsd, label)) return [];
  const page = await xApiGet<{ data?: XUser[] }>(cfg, counter, `/tweets/${postId}/${endpoint}`, {
    max_results: '100',
    'user.fields': 'verified,created_at,profile_image_url,public_metrics',
  });
  const users = page.data ?? [];
  reconcileBudget(ledger, maxCallCostUsd, users.length * rate);
  return users.map((u) => toEngagerSignal(u, engagedAtFallback));
}

// Stage 3: deep-dive for one shortlisted post. Every call here is the
// expensive part and is individually budget-gated -- a capped-out month
// stops mid-shortlist rather than blowing through the ceiling on the last
// few entries.
export async function deepDiveOne(
  cfg: FlockSignalConfig,
  ledger: UsageLedger,
  counter: CallCounter,
  post: CandidatePost
): Promise<ScoredEntry> {
  const likers = await fetchEngagers(cfg, ledger, counter, post.postId, 'liking_users', RATE_USD.likeRead, post.postedAt);
  const reposters = await fetchEngagers(
    cfg,
    ledger,
    counter,
    post.postId,
    'retweeted_by',
    RATE_USD.repostRead,
    post.postedAt
  );
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
  const counter: CallCounter = { calls: 0 };

  let candidates: CandidatePost[] = [];
  try {
    candidates = await discoverCandidates(cfg, ledger, counter);
  } catch (e) {
    console.log(`Discovery stopped: ${e instanceof Error ? e.message : String(e)}`);
  }
  const withReach = candidates.map((c) => ({ ...c, rawReach: rawReachScore(c.rawMetrics) }));
  withReach.sort((a, b) => b.rawReach - a.rawReach);

  const results: FlockSignalEntry[] = [];
  let deepDivedCount = 0;

  if (cfg.deepDiveEnabled) {
    const shortlist = withReach.slice(0, cfg.weeklyShortlistSize);
    const restOfField = withReach.slice(cfg.weeklyShortlistSize);
    deepDivedCount = shortlist.length;
    for (const post of shortlist) {
      try {
        const score = await deepDiveOne(cfg, ledger, counter, post);
        results.push({ ...post, score });
      } catch (e) {
        console.log(`Deep-dive failed/stopped for ${post.postId}: ${e instanceof Error ? e.message : String(e)}`);
        results.push({ ...post, score: scoreTriageOnly(post.rawMetrics) });
      }
      saveLedger(cfg, ledger); // persist after every entry, not just at the end
    }
    for (const post of restOfField) {
      results.push({ ...post, score: scoreTriageOnly(post.rawMetrics) });
    }
  } else {
    // Triage-only mode: no liking_users/retweeted_by calls at all, so no
    // budget is spent past discovery. Every candidate is ranked by real raw
    // reach for a human to judge by hand -- see deepDiveEnabled's comment.
    for (const post of withReach) {
      results.push({ ...post, score: scoreTriageOnly(post.rawMetrics) });
    }
  }

  saveLedger(cfg, ledger);
  console.log(
    `Flock Signal crawl: ${candidates.length} candidates, ` +
      `${cfg.deepDiveEnabled ? `${deepDivedCount} deep-dived` : 'triage-only (deep-dive disabled)'}, ` +
      `${counter.calls} of ${cfg.maxApiCallsPerRun} API calls used, ` +
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

// Triage-only mode (deep-dive disabled): ranking is honestly raw-reach, not
// verified, so it gets its own labels rather than borrowing the verified
// ones above -- "This Week's Leader" or "High Signal" would imply a
// verification pass that never happened.
function statusLabelsForTriage(rank: number, shortlistSize: number, rawReachPercentile: number): string[] {
  const labels: string[] = [];
  if (rank === 1) labels.push('Top Raw Reach');
  if (rank <= shortlistSize) labels.push('Human Review Finalist');
  else if (rawReachPercentile >= 0.9) labels.push('Flagged Viral');
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
  triageOnly.forEach((r, i) => {
    const percentile = reachRank.get(r.postId) ?? 0;
    // When nothing was verified-ranked this run (deep-dive disabled, the
    // current default), triage IS the board -- rank all of it by raw reach
    // so there's an honest order for a human to review. If deep-dive output
    // exists alongside it, triage entries stay unranked (null) so a
    // farmable raw-reach number never outranks a verified one.
    const rank = deepDived.length === 0 ? i + 1 : null;
    const statusLabels =
      rank !== null
        ? statusLabelsForTriage(rank, cfg.weeklyShortlistSize, percentile)
        : statusLabelsFor(r, null, deepDived.length, percentile, false);
    entries.push({
      rank,
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
      statusLabels,
    });
  });

  saveWeekHistory(cfg, history);

  // Hall of Fame is human-picks-only, on purpose -- it is NEVER auto-populated
  // from rank #1 here. In triage-only mode rank #1 is just the highest raw
  // reach, unverified and farmable; auto-inducting it would be exactly the
  // kind of unearned status this site's anti-farm design exists to prevent.
  // This just carries the prior file's Hall of Fame forward untouched; the
  // only way an entry joins it is you hand-editing docs/flock-signal.json
  // with your picked winner.
  const outFile = path.join(cfg.docsDir, 'flock-signal.json');
  let hallOfFame: HallOfFameEntry[] = [];
  if (fs.existsSync(outFile)) {
    try {
      const prior = JSON.parse(fs.readFileSync(outFile, 'utf8')) as FlockSignalData;
      hallOfFame = prior.hallOfFame ?? [];
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
