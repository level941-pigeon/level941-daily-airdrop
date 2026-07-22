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
  'nfa',
  'roi',
  'profit',
];

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
  if (/@[a-zA-Z0-9_]{2,}/.test(text)) {
    violations.push('contains an @-mention -- review for real-world identity reference before approving');
  }

  return [...new Set(violations)];
}
