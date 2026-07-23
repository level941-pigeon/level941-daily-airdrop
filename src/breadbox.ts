// Bread Box: the editorial system for everything level941 says publicly,
// codified so it survives every session rather than living in chat memory.
//
// DOCTRINE -- four voices, and only four:
//
//   1. heartbeat        -- every confirmed send, as it lands. 9:41 daily.
//                           Exempt from caps. Lives entirely in announce()/
//                           notify() in airdrop.ts, outside this module --
//                           not a Bread Box post type, listed here because
//                           it's still one of the four voices.
//   2. workflow          -- "shipped entries": announce + explain, evidence
//                           link mandatory. Status word first (shipped. /
//                           building. / testing. / planned.), title, <=3
//                           sentences, one link the chain or the board
//                           backs. Cap 3/day.
//   3. flight-orders     -- fact (linked) + angle + make + clock. "Angles
//                           only, forever": no price/prediction language,
//                           no instruction to post anything verbatim. Cap
//                           1/day.
//   4. weekly-winner      -- Tuesdays 9:41 PM reveal. STUB ONLY: the type
//                           exists and is capped (1/week), but nothing
//                           drafts it automatically yet -- there is no
//                           winner-selection source wired in. Flagging
//                           this honestly rather than faking a trigger
//                           that doesn't exist.
//
// Every post in every voice carries at least one link the chain or the
// board backs -- enforced at draft time, not just requested in prose.
//
// Nothing auto-publishes. Draft, then a human approves, and approval
// posts in the same step. The linter runs at draft time and again at
// approval time -- a failure at either point hard-fails, no soft-warn.
// Ops-class alerts (deadman, toggle, fuel, errors) never reach any of
// this -- see deadman-check.ts, which logs to data/logs/ops-alerts.log
// and only additionally posts if OPS_WEBHOOK_URL is ever set.
//
// Every approved workflow/flight-orders entry also generates a
// 280-character X-ready mirror in the same voice, queued alongside the
// original for hand-copying to @level941 -- see xMirrorFor().
//
// Usage:
//   npm run breadbox -- draft workflow --status building. --title "..." --body "..." --evidence "<url>"
//   npm run breadbox -- draft flight-orders --fact "..." --angle "..." --make "..." --clock "..."
//   npm run breadbox -- draft weekly-winner --title "..." --body "..." --evidence "<url>"
//   npm run breadbox -- list
//   npm run breadbox -- approve <id>
//   npm run breadbox -- reject <id>

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintDraft } from './breadbox-lint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_PATH = path.join(ROOT, 'data', 'breadbox-queue.json');
const VALID_STATUSES = ['shipped.', 'building.', 'testing.', 'planned.'];
// Distinct embed colors per voice are the "visually distinct" mechanism --
// heartbeat keeps posting plain `content` strings via announce(), untouched.
const EMBED_COLOR = { workflow: 0xf2a91c, 'flight-orders': 0x2ba8e0, 'weekly-winner': 0x00d9a3 };
const DAILY_CAP: Record<'workflow' | 'flight-orders', number> = { workflow: 3, 'flight-orders': 1 };
const WEEKLY_WINNER_CAP_PER_WEEK = 1;

type PostType = 'workflow' | 'flight-orders' | 'weekly-winner';

interface QueueEntry {
  id: string;
  postType: PostType;
  // workflow / weekly-winner fields
  status?: string;
  title?: string;
  body?: string;
  evidenceLink?: string;
  // flight-orders fields
  fact?: string;
  angle?: string;
  make?: string;
  clock?: string;
  xMirror?: string;
  state: 'draft' | 'rejected' | 'posted';
  createdAt: string;
  decidedAt: string | null;
  postedAt: string | null;
}

function loadQueue(): QueueEntry[] {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  return JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf8'));
}

function saveQueue(q: QueueEntry[]): void {
  fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + '\n');
}

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function weekKeyLocal(d: Date = new Date()): string {
  // ISO-ish week bucket, good enough for a 1/week cap -- ties the cap to
  // calendar week, not "7 days since last post" which would drift.
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - onejan.getTime()) / 86400000 + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

function sentenceCount(s: string): number {
  return (s.match(/[.!?]+(\s|$)/g) ?? []).length;
}

function hasLink(s: string | undefined): boolean {
  return !!s && /https?:\/\/\S+/.test(s);
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function renderText(e: QueueEntry): string {
  if (e.postType === 'flight-orders') return `${e.fact}\n${e.angle}\n${e.make}\n${e.clock}`;
  return `${e.status} ${e.title}\n${e.body}\n${e.evidenceLink}`;
}

function lintFor(e: QueueEntry): string[] {
  return lintDraft(renderText(e));
}

// One link the chain or the board backs, on every post, enforced here --
// not left as a doctrine line nobody checks. flight-orders carries its
// link in `fact`; everything else carries it in `evidenceLink`.
function linkViolations(e: QueueEntry): string[] {
  const field = e.postType === 'flight-orders' ? e.fact : e.evidenceLink;
  const fieldName = e.postType === 'flight-orders' ? '--fact' : '--evidence';
  return hasLink(field) ? [] : [`${fieldName} must contain a real http(s) link -- doctrine requires the chain or the board backs every post`];
}

// Best-effort 280-char mirror for hand-copying to @level941. Not a
// paraphrase engine -- straightforward truncation-to-fit in the same
// voice, not a rewrite. A human reviews before it ever leaves the queue.
//
// The link is load-bearing (doctrine requires one on every post) and
// must never be the part that gets cut -- truncating the prose and
// leaving the URL intact beats a shorter caption with a dead link.
function xMirrorFor(e: QueueEntry): string {
  const link = e.postType === 'flight-orders' ? (e.fact!.match(/https?:\/\/\S+/) ?? [''])[0] : (e.evidenceLink ?? '');
  const prose =
    e.postType === 'flight-orders'
      ? `${e.angle} ${e.fact!.replace(link, '').trim()}`
      : `${e.status} ${e.title} -- ${e.body}`;
  const collapsedProse = prose.replace(/\s+/g, ' ').trim();
  const budget = 280 - link.length - 1; // 1 for the separating space
  const truncatedProse = collapsedProse.length <= budget ? collapsedProse : collapsedProse.slice(0, Math.max(0, budget - 3)) + '...';
  return `${truncatedProse} ${link}`.trim();
}

// Reusable entry point for auto-draft triggers elsewhere in the codebase
// (e.g. scheduler-guard.ts after a send-auto run, or the post-commit hook
// for completed-work markers). Draft-only, by construction -- this never
// calls postToDiscord, only saveQueue. Returns null (and logs) instead of
// throwing on a lint/link failure, so a caller never lets a bad auto-draft
// take down the real work it's reporting on.
export function autoDraftWorkflow(status: string, title: string, body: string, evidence: string): string | null {
  if (!VALID_STATUSES.includes(status)) {
    console.log(`breadbox auto-draft skipped: invalid status "${status}"`);
    return null;
  }
  const entry: QueueEntry = {
    id: `${Date.now()}`, postType: 'workflow', status, title, body, evidenceLink: evidence,
    xMirror: undefined,
    state: 'draft', createdAt: new Date().toISOString(), decidedAt: null, postedAt: null,
  };
  const violations = [...lintFor(entry), ...linkViolations(entry)];
  if (violations.length > 0) {
    console.log(`breadbox auto-draft skipped, rejected: ${violations.join('; ')}`);
    return null;
  }
  entry.xMirror = xMirrorFor(entry);
  const q = loadQueue();
  q.push(entry);
  saveQueue(q);
  console.log(`breadbox: auto-drafted ${entry.id} [workflow] ${status} ${title}`);
  return entry.id;
}

function cmdDraft(argv: string[]): void {
  const postType = argv[0] as PostType;
  const flags = parseFlags(argv.slice(1));
  let entry: QueueEntry;

  if (postType === 'workflow' || postType === 'weekly-winner') {
    const { status, title, body, evidence } = flags;
    const effectiveStatus = postType === 'weekly-winner' ? (status ?? 'shipped.') : status;
    if (!effectiveStatus || !VALID_STATUSES.includes(effectiveStatus)) throw new Error(`--status must be one of: ${VALID_STATUSES.join(' ')}`);
    if (!title) throw new Error('--title is required');
    if (!body) throw new Error('--body is required');
    if (!evidence) throw new Error('--evidence is required (must be a real link)');
    if (sentenceCount(body) > 3) throw new Error(`--body must be 3 sentences or fewer, got ${sentenceCount(body)}`);
    entry = {
      id: `${Date.now()}`, postType, status: effectiveStatus, title, body, evidenceLink: evidence,
      state: 'draft', createdAt: new Date().toISOString(), decidedAt: null, postedAt: null,
    };
  } else if (postType === 'flight-orders') {
    const { fact, angle, make, clock } = flags;
    if (!fact) throw new Error('--fact is required (linked)');
    if (!angle) throw new Error('--angle is required');
    if (!make) throw new Error('--make is required');
    if (!clock) throw new Error('--clock is required');
    entry = {
      id: `${Date.now()}`, postType, fact, angle, make, clock,
      state: 'draft', createdAt: new Date().toISOString(), decidedAt: null, postedAt: null,
    };
  } else {
    throw new Error('draft <workflow|flight-orders|weekly-winner> ...');
  }

  const violations = [...lintFor(entry), ...linkViolations(entry)];
  if (violations.length > 0) {
    console.log('DRAFT REJECTED:');
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  entry.xMirror = xMirrorFor(entry);
  const q = loadQueue();
  q.push(entry);
  saveQueue(q);
  console.log(`drafted ${entry.id} [${postType}]`);
  console.log(`x mirror (${entry.xMirror.length} chars): ${entry.xMirror}`);
}

function cmdList(): void {
  const q = loadQueue();
  if (q.length === 0) {
    console.log('queue is empty.');
    return;
  }
  for (const e of q) {
    console.log(`[${e.state.padEnd(8)}] ${e.id}  (${e.postType})`);
    console.log(`           ${renderText(e).split('\n').join('\n           ')}`);
    if (e.xMirror) console.log(`           x mirror: ${e.xMirror}`);
  }
}

function postedTodayCountFor(q: QueueEntry[], postType: 'workflow' | 'flight-orders'): number {
  return q.filter((e) => e.postType === postType && e.state === 'posted' && e.postedAt && e.postedAt.startsWith(todayLocal())).length;
}

function postedThisWeekCount(q: QueueEntry[]): number {
  const wk = weekKeyLocal();
  return q.filter((e) => e.postType === 'weekly-winner' && e.state === 'posted' && e.postedAt && weekKeyLocal(new Date(e.postedAt)) === wk).length;
}

async function postToDiscord(e: QueueEntry): Promise<void> {
  const url = process.env.DISCORD_PUBLIC_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_PUBLIC_WEBHOOK_URL not set, cannot post.');
  const embed =
    e.postType === 'flight-orders'
      ? { title: e.angle, description: `${e.fact}\n\n${e.make}\n\n${e.clock}`, color: EMBED_COLOR['flight-orders'] }
      : { title: `${e.status} ${e.title}`, description: `${e.body}\n\n${e.evidenceLink}`, color: EMBED_COLOR[e.postType] };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status} ${res.statusText}`);
}

// Public mirror of the channel: posted entries only, never drafts or
// rejected -- the queue itself (data/breadbox-queue.json) stays private
// operational state, this is what docs/breadbox.html actually reads.
export function publishPublicMirror(q: QueueEntry[]): void {
  const posted = q
    .filter((e) => e.state === 'posted')
    .sort((a, b) => (a.postedAt! < b.postedAt! ? 1 : -1))
    .map((e) => ({
      id: e.id,
      postType: e.postType,
      status: e.status ?? null,
      title: e.title ?? null,
      body: e.body ?? null,
      evidenceLink: e.evidenceLink ?? null,
      fact: e.fact ?? null,
      angle: e.angle ?? null,
      make: e.make ?? null,
      clock: e.clock ?? null,
      postedAt: e.postedAt,
    }));
  const outPath = path.join(ROOT, 'docs', 'breadbox.json');
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), entries: posted }, null, 2) + '\n');
}

async function cmdApprove(id: string): Promise<void> {
  const q = loadQueue();
  const entry = q.find((e) => e.id === id);
  if (!entry) throw new Error(`no queue entry ${id}`);
  if (entry.state !== 'draft') throw new Error(`entry ${id} is already ${entry.state}`);

  const violations = [...lintFor(entry), ...linkViolations(entry)];
  if (violations.length > 0) {
    console.log(`APPROVAL BLOCKED for ${id}:`);
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  if (entry.postType === 'weekly-winner') {
    const postedThisWeek = postedThisWeekCount(q);
    if (postedThisWeek >= WEEKLY_WINNER_CAP_PER_WEEK) {
      console.log(`APPROVAL BLOCKED: weekly-winner cap of ${WEEKLY_WINNER_CAP_PER_WEEK}/week already reached.`);
      process.exitCode = 1;
      return;
    }
  } else {
    const postedToday = postedTodayCountFor(q, entry.postType);
    const cap = DAILY_CAP[entry.postType];
    if (postedToday >= cap) {
      console.log(`APPROVAL BLOCKED: daily cap of ${cap} ${entry.postType} post(s) already reached (${postedToday} posted today).`);
      process.exitCode = 1;
      return;
    }
  }

  await postToDiscord(entry);
  entry.state = 'posted';
  entry.decidedAt = new Date().toISOString();
  entry.postedAt = new Date().toISOString();
  if (!entry.xMirror) entry.xMirror = xMirrorFor(entry);
  saveQueue(q);
  publishPublicMirror(q);
  console.log(`posted ${id} [${entry.postType}]`);
  console.log(`x mirror ready to hand-copy: ${entry.xMirror}`);
}

function cmdReject(id: string): void {
  const q = loadQueue();
  const entry = q.find((e) => e.id === id);
  if (!entry) throw new Error(`no queue entry ${id}`);
  entry.state = 'rejected';
  entry.decidedAt = new Date().toISOString();
  saveQueue(q);
  console.log(`rejected ${id}`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'draft':
      cmdDraft(rest);
      break;
    case 'list':
      cmdList();
      break;
    case 'approve':
      await cmdApprove(rest[0]);
      break;
    case 'reject':
      cmdReject(rest[0]);
      break;
    default:
      console.log('usage: breadbox <draft <workflow|flight-orders|weekly-winner>|list|approve|reject> ...');
      process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1]?.endsWith('breadbox.ts');
if (isDirectRun) {
  main().catch((e) => {
    console.error('breadbox error:', e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
