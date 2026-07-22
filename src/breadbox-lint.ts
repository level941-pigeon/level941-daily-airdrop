// Hard-fail content linter for anything headed to the public Discord
// channel through the Bread Box workflow queue. Runs twice by design: once
// at draft time (catch it early) and again immediately before posting
// (catch anything that snuck into an edited draft, or a secret that
// rotated between draft and approval). A failure here blocks the post
// entirely -- there is no soft-warn path.
//
// This is a pattern/secret-value scanner, not a full identity-detection
// system -- the "real-world identity reference" check is a blunt @-mention
// flag, not a claim that every reference to a real person is caught.
// Human review at approval time is still the actual backstop for that one.

import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Copy law: "backed by / controlled by / run by [an AI]" overclaims agency
// this project doesn't have and isn't true -- a human approves every
// public post through this exact queue. "Built with [an AI]" is true and
// explicitly exempt. Proximity-based (same sentence-ish window), not a
// whole-document scan, so an unrelated use of "run by" elsewhere in a
// draft doesn't false-positive.
const AI_NAMES = ['claude', 'gpt', 'chatgpt', 'anthropic', 'openai'];
const BANNED_AGENCY_PHRASES = ['backed by', 'controlled by', 'run by'];
const EXEMPT_PHRASE = 'built with';

function checkCopyLaw(text: string): string[] {
  const lower = text.toLowerCase();
  if (!AI_NAMES.some((n) => lower.includes(n))) return [];
  const violations: string[] = [];
  for (const phrase of BANNED_AGENCY_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      const windowStart = Math.max(0, idx - 40);
      const windowEnd = Math.min(lower.length, idx + phrase.length + 40);
      const window = lower.slice(windowStart, windowEnd);
      if (AI_NAMES.some((n) => window.includes(n)) && !window.includes(EXEMPT_PHRASE)) {
        violations.push(`copy law: "${phrase}" adjacent to an AI name -- use "built with" instead`);
      }
      idx = lower.indexOf(phrase, idx + 1);
    }
  }
  return violations;
}

const PROFIT_GUARANTEE_PATTERNS = [
  'guaranteed',
  'guarantee',
  'risk-free',
  'risk free',
  'financial advice',
  'investment advice',
  '100x',
  '1000x',
  'moon',
  'to the moon',
  'not financial advice',
  'profit',
];
// Short abbreviations that collide with ordinary words as a substring --
// "nfa" sits inside "unfarmable" and "confabulation", "roi" sits inside
// "heroin". Exact-word-only, same fix as content-denylist.ts's coon/spic
// tier and for the same reason.
const PROFIT_GUARANTEE_WORD_PATTERNS = ['nfa', 'roi'];

function envKeyNames(): string[] {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return [];
  return fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .map((l) => l.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1])
    .filter((k): k is string => !!k);
}

function envSecretValues(): string[] {
  // Values worth catching even though the ask was "key names" -- a leaked
  // RPC URL or private key is strictly worse than a leaked key name.
  const names = [
    'FOUNDER_WALLET',
    'AIRDROP_PRIVATE_KEY',
    'RPC_URL',
    'X_API_BEARER_TOKEN',
    'DISCORD_WEBHOOK_URL',
    'DISCORD_PUBLIC_WEBHOOK_URL',
  ];
  return names.map((n) => process.env[n]).filter((v): v is string => !!v && v.length > 4);
}

// Flight Orders-only additions. "Angles only, forever" is the whole point
// of that post type -- a price call or a "post this exactly" instruction
// is precisely what turns an angle into either financial advice or a
// copy-paste amplification vector, so these hard-fail there specifically
// rather than folding into the base linter every post type shares.
const PRICE_PREDICTION_PATTERNS = [
  'price target',
  'will hit',
  'will reach',
  'will pump',
  'will moon',
  'going to $',
  'target of $',
  'expect it to',
  'should hit',
  'predict',
  'prediction',
];
const VERBATIM_INSTRUCTION_PATTERNS = [
  'post this exactly',
  'post exactly',
  'copy paste',
  'copy-paste',
  'verbatim',
  'word for word',
  'use this exact text',
  'post as-is',
  'post as is',
];

export function lintFlightOrders(text: string): string[] {
  const violations = lintDraft(text);
  const lower = text.toLowerCase();
  for (const p of PRICE_PREDICTION_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains price/prediction language: "${p}"`);
  }
  if (/\$\s?\d/.test(text)) violations.push('contains a price-looking dollar figure');
  for (const p of VERBATIM_INSTRUCTION_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains a verbatim-copy instruction: "${p}"`);
  }
  return [...new Set(violations)];
}

export function lintDraft(text: string): string[] {
  const violations: string[] = [];
  const lower = text.toLowerCase();

  for (const value of envSecretValues()) {
    if (text.includes(value)) violations.push('contains a live secret value (.env)');
  }
  for (const key of envKeyNames()) {
    if (text.includes(key)) violations.push(`contains a .env key name: ${key}`);
  }
  if (/\/Users\/[a-zA-Z0-9_.-]+/.test(text) || /\/private\/[a-zA-Z0-9_.-]+/.test(text) || /~\/[a-zA-Z0-9_.\/-]+/.test(text)) {
    violations.push('contains a local filesystem path');
  }
  if (/https?:\/\/[^\s)]+/.test(text)) {
    const urls = text.match(/https?:\/\/[^\s)]+/g) ?? [];
    const allowed = ['x.com', 'twitter.com', 'github.com', 'solscan.io', 'dexscreener.com', 'level941.live'];
    for (const u of urls) {
      const isAllowed = allowed.some((a) => u.includes(a));
      if (!isAllowed) violations.push(`contains a non-allowlisted URL: ${u}`);
    }
  }
  for (const p of PROFIT_GUARANTEE_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains profit/guarantee language: "${p}"`);
  }
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  for (const p of PROFIT_GUARANTEE_WORD_PATTERNS) {
    if (words.has(p)) violations.push(`contains profit/guarantee language: "${p}"`);
  }
  if (/@[a-zA-Z0-9_]{2,}/.test(text)) {
    violations.push('contains an @-mention -- review for real-world identity reference before approving');
  }
  violations.push(...checkCopyLaw(text));

  return [...new Set(violations)];
}
