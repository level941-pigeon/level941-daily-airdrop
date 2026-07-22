// Bread Box: two post types to the existing public "the box" Discord
// webhook, both separate from the unchanged heartbeat/event announcements
// already posted via announce() in airdrop.ts.
//
//   workflow      -- dev-transparency status posts. Cap 3/day.
//   flight-orders -- fact + angle posts on real events. Cap 1/day.
//                    "Angles only, forever": lintFlightOrders() hard-fails
//                    on price/prediction language and on any instruction
//                    to post text verbatim, on top of the base linter.
//
// Nothing auto-publishes. Draft, then a human approves, and approval
// posts in the same step. The linter runs at draft time and again at
// approval time -- a failure at either point hard-fails, no soft-warn.
//
// Usage:
//   npm run breadbox -- draft workflow --status building. --title "..." --body "..." --evidence "..."
//   npm run breadbox -- draft flight-orders --fact "..." --angle "..." --make "..." --clock "..."
//   npm run breadbox -- list
//   npm run breadbox -- approve <id>
//   npm run breadbox -- reject <id>

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintDraft, lintFlightOrders } from './breadbox-lint.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUEUE_PATH = path.join(ROOT, 'data', 'breadbox-queue.json');
const VALID_STATUSES = ['shipped.', 'building.', 'testing.', 'planned.'];
// Distinct embed colors per type are the "visually distinct" mechanism --
// heartbeat keeps posting plain `content` strings via announce(), untouched.
const EMBED_COLOR = { workflow: 0xf2a91c, 'flight-orders': 0x2ba8e0 };
const DAILY_CAP = { workflow: 3, 'flight-orders': 1 };

type PostType = 'workflow' | 'flight-orders';

interface QueueEntry {
  id: string;
  postType: PostType;
  // workflow fields
  status?: string;
  title?: string;
  body?: string;
  evidenceLink?: string;
  // flight-orders fields
  fact?: string;
  angle?: string;
  make?: string;
  clock?: string;
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

function sentenceCount(s: string): number {
  return (s.match(/[.!?]+(\s|$)/g) ?? []).length;
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
  if (e.postType === 'workflow') return `${e.status} ${e.title}\n${e.body}\n${e.evidenceLink}`;
  return `${e.fact}\n${e.angle}\n${e.make}\n${e.clock}`;
}

function lintFor(e: QueueEntry): string[] {
  const text = renderText(e);
  return e.postType === 'flight-orders' ? lintFlightOrders(text) : lintDraft(text);
}

// Reusable entry point for auto-draft triggers elsewhere in the codebase
// (e.g. scheduler-guard.ts after a send-auto run). Draft-only, by
// construction -- this never calls postToDiscord, only saveQueue.
// Returns null (and logs) instead of throwing on a lint failure, so a
// caller like the scheduler guard never lets a bad auto-draft take down
// the actual send-auto run it's reporting on.
export function autoDraftWorkflow(status: string, title: string, body: string, evidence: string): string | null {
  if (!VALID_STATUSES.includes(status)) {
    console.log(`breadbox auto-draft skipped: invalid status "${status}"`);
    return null;
  }
  const entry: QueueEntry = {
    id: `${Date.now()}`, postType: 'workflow', status, title, body, evidenceLink: evidence,
    state: 'draft', createdAt: new Date().toISOString(), decidedAt: null, postedAt: null,
  };
  const violations = lintFor(entry);
  if (violations.length > 0) {
    console.log(`breadbox auto-draft skipped, linter rejected it: ${violations.join('; ')}`);
    return null;
  }
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

  if (postType === 'workflow') {
    const { status, title, body, evidence } = flags;
    if (!status || !VALID_STATUSES.includes(status)) throw new Error(`--status must be one of: ${VALID_STATUSES.join(' ')}`);
    if (!title) throw new Error('--title is required');
    if (!body) throw new Error('--body is required');
    if (!evidence) throw new Error('--evidence is required');
    if (sentenceCount(body) > 3) throw new Error(`--body must be 3 sentences or fewer, got ${sentenceCount(body)}`);
    entry = {
      id: `${Date.now()}`, postType, status, title, body, evidenceLink: evidence,
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
    throw new Error('draft <workflow|flight-orders> ...');
  }

  const violations = lintFor(entry);
  if (violations.length > 0) {
    console.log('DRAFT REJECTED by linter:');
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }
  const q = loadQueue();
  q.push(entry);
  saveQueue(q);
  console.log(`drafted ${entry.id} [${postType}]`);
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
  }
}

function postedTodayCountFor(q: QueueEntry[], postType: PostType): number {
  return q.filter((e) => e.postType === postType && e.state === 'posted' && e.postedAt && e.postedAt.startsWith(todayLocal())).length;
}

async function postToDiscord(e: QueueEntry): Promise<void> {
  const url = process.env.DISCORD_PUBLIC_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_PUBLIC_WEBHOOK_URL not set, cannot post.');
  const embed =
    e.postType === 'workflow'
      ? { title: `${e.status} ${e.title}`, description: `${e.body}\n\n${e.evidenceLink}`, color: EMBED_COLOR.workflow }
      : { title: e.angle, description: `${e.fact}\n\n${e.make}\n\n${e.clock}`, color: EMBED_COLOR['flight-orders'] };
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

  const violations = lintFor(entry);
  if (violations.length > 0) {
    console.log(`APPROVAL BLOCKED by linter for ${id}:`);
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  const postedToday = postedTodayCountFor(q, entry.postType);
  const cap = DAILY_CAP[entry.postType];
  if (postedToday >= cap) {
    console.log(`APPROVAL BLOCKED: daily cap of ${cap} ${entry.postType} post(s) already reached (${postedToday} posted today).`);
    process.exitCode = 1;
    return;
  }

  await postToDiscord(entry);
  entry.state = 'posted';
  entry.decidedAt = new Date().toISOString();
  entry.postedAt = new Date().toISOString();
  saveQueue(q);
  publishPublicMirror(q);
  console.log(`posted ${id} [${entry.postType}]`);
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
      console.log('usage: breadbox <draft <workflow|flight-orders>|list|approve|reject> ...');
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
