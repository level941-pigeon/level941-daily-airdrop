// Dead-man's switch. Runs at 9:55 local, 14 minutes after the scheduled
// send-auto trigger. Two independent checks, both alert-on-failure only --
// silence is the failure mode this exists to kill, so a check that can't
// complete (e.g. `defaults read` erroring) is itself worth logging loudly
// rather than swallowed.
//
// 1. No successful send-auto run logged for today by 9:55 -> alert.
// 2. AutomaticallyInstallMacOSUpdates reads back to 1 (re-armed after being
//    turned off) -> alert, since an unattended restart-install is exactly
//    what breaks the poller and the daily run.

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = path.join(ROOT, 'data', 'logs', 'send-auto-last-success.txt');

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

async function alert(message: string): Promise<void> {
  console.log(`deadman-check: ALERT: ${message}`);
  const url = process.env.DISCORD_PUBLIC_WEBHOOK_URL;
  if (!url) {
    console.log('deadman-check: DISCORD_PUBLIC_WEBHOOK_URL not set, cannot notify -- this alert only reached this log.');
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) {
      console.log(`deadman-check: webhook responded ${res.status} ${res.statusText}`);
    }
  } catch (e) {
    console.log(`deadman-check: webhook post failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function checkTodaysRun(): Promise<void> {
  const ok = fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf8').trim().startsWith(todayLocal());
  if (ok) {
    console.log(`deadman-check: ${new Date().toISOString()} today's send-auto run is confirmed successful.`);
    return;
  }
  await alert(`level941 dead-man's switch: no successful send-auto run logged for ${todayLocal()} as of 9:55 AM. The daily run did not complete.`);
}

async function checkAutoUpdateToggle(): Promise<void> {
  try {
    const out = execFileSync(
      'defaults',
      ['read', '/Library/Preferences/com.apple.SoftwareUpdate', 'AutomaticallyInstallMacOSUpdates'],
      { encoding: 'utf8' }
    ).trim();
    if (out === '1') {
      await alert(
        'level941 dead-man\'s switch: AutomaticallyInstallMacOSUpdates reads 1 again -- an unattended reboot could freeze the poller and skip the daily run.'
      );
    } else {
      console.log(`deadman-check: ${new Date().toISOString()} AutomaticallyInstallMacOSUpdates = ${out}, no alert needed.`);
    }
  } catch (e) {
    console.log(`deadman-check: could not read AutomaticallyInstallMacOSUpdates: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// A manual kickstart outside the 9:55 window would otherwise produce zero
// visible output whenever both real checks are already green (exactly the
// case right after a successful run) -- this sends one unmistakably
// labeled post so a manual verification always has proof it reached
// Discord, independent of whatever the real conditions happen to be.
async function sendLabeledTestPost(): Promise<void> {
  await alert(
    `[TEST] level941 dead-man's switch manual verification -- fired at ${new Date().toISOString()}, ` +
      `not a real incident. If you're seeing this, the webhook path from the daemon context works.`
  );
}

async function main(): Promise<void> {
  if (process.argv[2] === 'test') {
    await sendLabeledTestPost();
  }
  await checkTodaysRun();
  await checkAutoUpdateToggle();
}

main();
