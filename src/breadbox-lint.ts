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

// Machine internals -- daemon/process plumbing, OS configuration keys --
// reach the public channel only inside a human-approved entry (someone
// deliberately writing "we fixed a launchd bug" is fine; the ops alert
// text itself leaking verbatim into a public post is not). This is a
// blocklist of infrastructure vocabulary, not a claim that it's exhaustive.
const MACHINE_INTERNALS_PATTERNS = [
  'launchd',
  'launchctl',
  'launchdaemon',
  'launchagent',
  'com.level941.',
  'com.apple.',
  'ex_config',
  'exit code',
  'tcc',
  'crontab',
  'systemd',
  'automaticallyinstallmacosupdates',
  'softwareupdate',
  'sudo ',
];

// DEVICE_FINGERPRINT: three classes (identity / device / security), all
// permanent, all hard-fail, all reported as the single generic string
// "BLOCKED: SECURITY" -- never the matched term, never which pattern hit.
// A rejection message that says *what* it caught is itself a leak vector
// (a log line reading "contains hostname: bns-mac-mini" defeats the point
// of blocking the hostname). This is the one check in this file that
// deliberately withholds its own reasoning from every log the public path
// touches.
//
// Seeded from what has actually appeared in this project's own working
// session -- hostname, OS build, the deploy key filename -- because those
// are the concretely known leak risks, not a hypothetical list. Extend it
// the moment anything else identifying surfaces; this is not meant to be
// exhaustive on day one.
//
// Two match tiers for the same collision reason as content-denylist.ts:
// "bn" as a bare substring would match constantly (been, bnb, cabin...),
// so short/collision-prone tokens are exact-word-only.
const DEVICE_FINGERPRINT_SUBSTRING_PATTERNS = [
  // identity class
  // (no confirmed personal name/handle/location on record yet -- add here
  // the moment one surfaces; this list is not a promise nothing exists)
  // device class
  'bns-mac-mini',
  'macos tahoe',
  '25f84',
  '25f71',
  'darwin 25',
  // security class
  'level941_deploy',
  '.ssh/',
  'id_ed25519',
  'private key',
  'keychain',
  'deploy key',
  'credential helper',
  'osxkeychain',
];
const DEVICE_FINGERPRINT_WORD_PATTERNS = ['bn'];

function checkDeviceFingerprint(text: string): string[] {
  const lower = text.toLowerCase();
  const words = new Set(lower.split(/[^a-z0-9._-]+/).filter(Boolean));
  const hit =
    DEVICE_FINGERPRINT_SUBSTRING_PATTERNS.some((p) => lower.includes(p)) ||
    DEVICE_FINGERPRINT_WORD_PATTERNS.some((p) => words.has(p)) ||
    // absolute path under this machine's home directory -- doctrine's
    // "home-directory or absolute paths" clause. The existing local-path
    // check below already catches this generically too; this duplicate
    // entry point exists so it also gets the SECURITY-generic treatment
    // rather than the more descriptive "contains a local filesystem path"
    // message the general check produces.
    /\/Users\/[a-zA-Z0-9_.-]+/.test(text) ||
    /~\/[a-zA-Z0-9_.\/-]+/.test(text);
  return hit ? ['BLOCKED: SECURITY'] : [];
}

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

// Doctrine item 2: price/prediction language and verbatim-copy
// instructions are hard-fails across the whole public path, not just
// flight-orders -- "angles only, forever" is a house-wide rule now, not a
// per-voice add-on.
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

// Own handle, not a third-party identity reference -- doctrine explicitly
// wants "tag @level941" as normal community language, so it's exempt from
// the @-mention flag rather than hard-failing every post that follows the
// house style.
const SELF_HANDLE = '@level941';

export function lintDraft(text: string): string[] {
  // Security-class hit short-circuits everything else: the whole point is
  // that a blocked post's rejection reason never itself describes what it
  // caught, so it can't leak by way of the linter's own output.
  const securityHit = checkDeviceFingerprint(text);
  if (securityHit.length > 0) return securityHit;

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
  const mentions = text.match(/@[a-zA-Z0-9_]{2,}/g) ?? [];
  if (mentions.some((m) => m.toLowerCase() !== SELF_HANDLE)) {
    violations.push('contains an @-mention -- review for real-world identity reference before approving');
  }
  for (const p of MACHINE_INTERNALS_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains machine/daemon internals: "${p.trim()}"`);
  }
  for (const p of PRICE_PREDICTION_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains price/prediction language: "${p}"`);
  }
  if (/\$\s?\d/.test(text)) violations.push('contains a price-looking dollar figure');
  for (const p of VERBATIM_INSTRUCTION_PATTERNS) {
    if (lower.includes(p)) violations.push(`contains a verbatim-copy instruction: "${p}"`);
  }
  violations.push(...checkCopyLaw(text));

  return [...new Set(violations)];
}
