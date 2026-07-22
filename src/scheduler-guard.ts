// Idempotent wrapper around `npm run send-auto`, safe to invoke from both
// the exact 9:41 calendar trigger and from RunAtLoad (boot/login catch-up).
// A marker file records the local calendar date a run last completed
// successfully; an atomic mkdir-based lock stops two invocations racing
// into a double-send (e.g. the calendar trigger firing seconds after a
// catch-up run already started, or two rapid RunAtLoad events on a flaky
// boot). Whichever loses the race just no-ops -- there is no queueing.
//
// Usage: tsx src/scheduler-guard.ts scheduled   -- the 9:41 calendar trigger
//        tsx src/scheduler-guard.ts catchup     -- RunAtLoad; only acts if
//                                                   it's already past 9:41
//                                                   local and today hasn't
//                                                   succeeded yet.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, 'data', 'logs', 'send-auto-last-success.txt');
const LOCK_DIR = path.join(ROOT, 'data', 'logs', 'send-auto.lock');
const STALE_LOCK_MS = 30 * 60 * 1000;
const TARGET_HOUR = 9;
const TARGET_MINUTE = 41;

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function alreadySucceededToday(): boolean {
  if (!fs.existsSync(MARKER)) return false;
  return fs.readFileSync(MARKER, 'utf8').trim().startsWith(todayLocal());
}

function pastTargetTime(): boolean {
  const now = new Date();
  return now.getHours() > TARGET_HOUR || (now.getHours() === TARGET_HOUR && now.getMinutes() >= TARGET_MINUTE);
}

// Atomic: mkdir either succeeds (we hold the lock) or fails with EEXIST
// (someone else does). A lock older than STALE_LOCK_MS is assumed to be
// left behind by a killed/crashed process, not an in-progress run.
function acquireLock(): boolean {
  try {
    fs.mkdirSync(LOCK_DIR);
    return true;
  } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
      if (age > STALE_LOCK_MS) {
        fs.rmdirSync(LOCK_DIR);
        fs.mkdirSync(LOCK_DIR);
        return true;
      }
    } catch {
      /* lost the race to remove/recreate it, or it's gone -- either way, not our lock */
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    fs.rmdirSync(LOCK_DIR);
  } catch {
    /* already gone */
  }
}

function runSendAuto(reason: string): void {
  console.log(`scheduler-guard: ${new Date().toISOString()} running send-auto (${reason})`);
  try {
    execFileSync('npm', ['run', 'send-auto'], { stdio: 'inherit', cwd: ROOT });
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, `${todayLocal()} ${new Date().toISOString()} (${reason})\n`);
    console.log('scheduler-guard: send-auto completed, marker written.');
  } catch (e) {
    console.log(
      `scheduler-guard: send-auto FAILED, marker NOT written, next trigger will retry. ${e instanceof Error ? e.message : String(e)}`
    );
    process.exitCode = 1;
  }
}

function main(): void {
  const trigger = process.argv[2] === 'catchup' ? 'catchup' : 'scheduled';

  if (alreadySucceededToday()) {
    console.log(`scheduler-guard: ${new Date().toISOString()} [${trigger}] already succeeded today per ${MARKER}, nothing to do.`);
    return;
  }
  if (trigger === 'catchup' && !pastTargetTime()) {
    console.log(`scheduler-guard: ${new Date().toISOString()} [catchup] before 9:41 local, deferring to the calendar trigger.`);
    return;
  }
  if (!acquireLock()) {
    console.log(`scheduler-guard: ${new Date().toISOString()} [${trigger}] lock held by another run, skipping.`);
    return;
  }
  try {
    runSendAuto(trigger === 'catchup' ? 'catch-up on load, past 9:41 with no success marker for today' : 'scheduled 9:41 trigger');
  } finally {
    releaseLock();
  }
}

main();
