import { loadConfig } from './config.js';
import { runSnapshot } from './holders.js';
import { runAnnounceToday, runPreview, runSendAuto, runSendDaily, runTestSend } from './airdrop.js';
import { runSweep, runSweepDeny, runSweepStatus } from './sweep.js';
import { runBridgeStatus } from './bridge.js';
import { runDrawCommit, runDrawSettle, runDrawStatus } from './draw.js';
import { runLoyaltyPreview, runLoyaltyPay } from './loyalty.js';
import { runFounderPreview, runFounderPay } from './founder.js';
import { runOgFounderPreview, runOgFounderPay } from './og-founder.js';
import { setNotifyWebhook } from './airdrop.js';
import { runPublishBoard } from './board.js';

const USAGE = `level941-daily-airdrop

Commands:
  npm run snapshot     Snapshot holders and build the qualifying list
  npm run preview      Calculate today's airdrop. Sends nothing.
  npm run test-send    Send to the first 3 qualifying wallets only
  npm run send-daily   Send the full daily airdrop. Requires typing CONFIRM.
  npm run send-auto    Unattended daily run: snapshot, preview, guards, send.
  npm run sweep        Manual sweep with full pipeline report.
  npm run sweep-status Show every foreign token and its lane. Moves nothing.
  npm run sweep-deny   Denylist a mint forever: npm run sweep-deny -- <mint>
  npm run announce-today  Repost today's public summary from the ledger.
  npm run bridge-status   Show OG bridge eligibility, pending, and paid.
  npm run draw-commit     941 draw phase 1: freeze + publish the round.
  npm run draw-settle     941 draw phase 2: settle with announced entropy.
  npm run draw-status     Show committed and settled draw rounds.
  npm run loyalty-preview The 94 longest-held wallets and their bonus.
  npm run loyalty-pay     Pay the loyalty capstone (needs LOYALTY_EVENT_ID).
  npm run founder-preview Founder drop: preview recipients + cold-floor check.
  npm run founder-pay     Execute founder drop (needs FOUNDER_EVENT_ID).
  npm run og-holders      Pull current OG-mint holders via Helius DAS. Read-only.
  npm run og-founder-preview  OG founder seed: preview recipients + cold-floor check.
  npm run og-founder-pay      Execute OG founder seed (needs OG_FOUNDER_EVENT_ID).
  npm run publish-board       Emit docs/board.json from today's snapshot.
`;

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    console.log(USAGE);
    process.exit(1);
  }

  const cfg = loadConfig();
  setNotifyWebhook(cfg.discordWebhookUrl, cfg.discordPublicWebhookUrl);

  switch (command) {
    case 'snapshot':
      await runSnapshot(cfg);
      break;
    case 'preview':
      await runPreview(cfg);
      break;
    case 'test-send':
      await runTestSend(cfg);
      break;
    case 'send-daily':
      await runSendDaily(cfg);
      break;
    case 'send-auto':
      await runSendAuto(cfg);
      break;
    case 'sweep':
      await runSweep(cfg);
      break;
    case 'sweep-status':
      await runSweepStatus(cfg);
      break;
    case 'sweep-deny':
      await runSweepDeny(cfg, process.argv[3] ?? '');
      break;
    case 'announce-today':
      await runAnnounceToday(cfg);
      break;
    case 'bridge-status':
      await runBridgeStatus(cfg);
      break;
    case 'draw-commit':
      await runDrawCommit(cfg);
      break;
    case 'draw-settle':
      await runDrawSettle(cfg);
      break;
    case 'draw-status':
      await runDrawStatus(cfg);
      break;
    case 'loyalty-preview':
      await runLoyaltyPreview(cfg);
      break;
    case 'loyalty-pay':
      await runLoyaltyPay(cfg);
      break;
    case 'founder-preview':
      await runFounderPreview(cfg);
      break;
    case 'founder-pay':
      await runFounderPay(cfg);
      break;
    case 'og-founder-preview':
      await runOgFounderPreview(cfg);
      break;
    case 'og-founder-pay':
      await runOgFounderPay(cfg);
      break;
    case 'publish-board':
      await runPublishBoard(cfg);
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('Error:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
