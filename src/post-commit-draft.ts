// Completed-work-marker auto-draft, invoked by .git/hooks/post-commit.
// Skips the poller's routine "live-state: <ts>" auto-commits (every
// ~75s while it's running) -- those aren't completed work, they're a
// heartbeat write, and drafting one per commit would flood the queue.
// Draft-only by construction (autoDraftWorkflow never posts); any
// failure here is caught and logged, never allowed to fail the commit
// itself -- see the hook script, which always exits 0.

import { execFileSync } from 'node:child_process';
import { autoDraftWorkflow } from './breadbox.js';

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function githubCommitUrl(hash: string): string | null {
  try {
    const remote = git(['remote', 'get-url', 'origin']);
    // Handles both SSH host-alias remotes (git@github.com-level941:owner/repo.git)
    // and https remotes -- pull owner/repo out either way.
    const m = remote.match(/[:/]([^/:]+)\/([^/]+?)(\.git)?$/);
    if (!m) return null;
    return `https://github.com/${m[1]}/${m[2]}/commit/${hash}`;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const hash = git(['rev-parse', 'HEAD']);
  const subject = git(['log', '-1', '--format=%s']);

  if (subject.startsWith('live-state:')) {
    return; // routine poller commit, not completed work
  }

  const url = githubCommitUrl(hash);
  if (!url) {
    console.log('post-commit-draft: could not determine a commit URL, skipping auto-draft.');
    return;
  }

  await autoDraftWorkflow('testing.', subject.slice(0, 80), `Committed: ${subject}`, url, 'post-commit');
}

main().catch((e) => {
  console.error('post-commit-draft error:', e instanceof Error ? e.message : String(e));
});
