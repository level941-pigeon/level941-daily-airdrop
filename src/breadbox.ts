// Bread Box workflow queue: dev-transparency posts to the existing public
// "the box" Discord webhook, separate from the unchanged heartbeat/event
// announcements already posted via announce() in airdrop.ts. Nothing here
// auto-publishes -- draft, then a human approves, and approval posts in
// the same step. Capped at 3 workflow posts/day; the linter in
// breadbox-lint.ts runs at draft time and again at approval time, and a
// failure at either point hard-fails (refuses to save / refuses to post),
// no soft-warn path.
//
// Usage:
//   npm run breadbox -- draft --status building. --title "..." --body "..." --evidence "..."
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
const DAILY_CAP = 3;
const VALID_STATUSES = ['shipped.', 'building.', 'testing.', 'planned.'];
// A distinct embed color (Discord decimal) is the "visually distinct from
// heartbeat" mechanism -- heartbeat keeps posting plain `content` strings
// via announce(), untouched; workflow posts render as a colored embed card.
const EMBED_COLOR = 0xf2a91c;

interface QueueEntry {
  id: string;
  status: string;
  title: string;
  body: string;
  evidenceLink: string;
  state: 'draft' | 'approved' | 'rejected' | 'posted';
  createdAt: string;
  decidedAt: string | null;
  postedAt: string | null;
  lintViolationsAtDraft: string[];
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
      const key = argv[i].slice(2);
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function cmdDraft(argv: string[]): void {
  const flags = parseFlags(argv);
  const { status, title, body, evidence } = flags;
  if (!status || !VALID_STATUSES.includes(status)) {
    throw new Error(`--status must be one of: ${VALID_STATUSES.join(' ')}`);
  }
  if (!title) throw new Error('--title is required');
  if (!body) throw new Error('--body is required');
  if (!evidence) throw new Error('--evidence is required (commit, tx, log line, screenshot reference)');
  if (sentenceCount(body) > 3) throw new Error(`--body must be 3 sentences or fewer, got ${sentenceCount(body)}`);

  const fullText = `${status} ${title}\n${body}\n${evidence}`;
  const violations = lintDraft(fullText);
  if (violations.length > 0) {
    console.log('DRAFT REJECTED by linter:');
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  const entry: QueueEntry = {
    id: `${Date.now()}`,
    status,
    title,
    body,
    evidenceLink: evidence,
    state: 'draft',
    createdAt: new Date().toISOString(),
    decidedAt: null,
    postedAt: null,
    lintViolationsAtDraft: [],
  };
  const q = loadQueue();
  q.push(entry);
  saveQueue(q);
  console.log(`drafted ${entry.id}: ${status} ${title}`);
}

function cmdList(): void {
  const q = loadQueue();
  if (q.length === 0) {
    console.log('queue is empty.');
    return;
  }
  for (const e of q) {
    console.log(`[${e.state.padEnd(8)}] ${e.id}  ${e.status} ${e.title}`);
    console.log(`           ${e.body}`);
    console.log(`           evidence: ${e.evidenceLink}`);
  }
}

function postedTodayCount(q: QueueEntry[]): number {
  return q.filter((e) => e.state === 'posted' && e.postedAt && e.postedAt.startsWith(todayLocal())).length;
}

async function postToDiscord(e: QueueEntry): Promise<void> {
  const url = process.env.DISCORD_PUBLIC_WEBHOOK_URL;
  if (!url) throw new Error('DISCORD_PUBLIC_WEBHOOK_URL not set, cannot post.');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [
        {
          title: `${e.status} ${e.title}`,
          description: `${e.body}\n\n${e.evidenceLink}`,
          color: EMBED_COLOR,
        },
      ],
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status} ${res.statusText}`);
}

async function cmdApprove(id: string): Promise<void> {
  const q = loadQueue();
  const entry = q.find((e) => e.id === id);
  if (!entry) throw new Error(`no queue entry ${id}`);
  if (entry.state !== 'draft') throw new Error(`entry ${id} is already ${entry.state}`);

  const fullText = `${entry.status} ${entry.title}\n${entry.body}\n${entry.evidenceLink}`;
  const violations = lintDraft(fullText);
  if (violations.length > 0) {
    console.log(`APPROVAL BLOCKED by linter for ${id}:`);
    for (const v of violations) console.log(`  - ${v}`);
    process.exitCode = 1;
    return;
  }

  const postedToday = postedTodayCount(q);
  if (postedToday >= DAILY_CAP) {
    console.log(`APPROVAL BLOCKED: daily cap of ${DAILY_CAP} workflow posts already reached (${postedToday} posted today).`);
    process.exitCode = 1;
    return;
  }

  await postToDiscord(entry);
  entry.state = 'posted';
  entry.decidedAt = new Date().toISOString();
  entry.postedAt = new Date().toISOString();
  saveQueue(q);
  console.log(`posted ${id}: ${entry.status} ${entry.title}`);
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
      console.log('usage: breadbox <draft|list|approve|reject> ...');
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('breadbox error:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
