# level941-daily-airdrop

Daily adaptive SPL token airdrop. Local TypeScript script, run manually. No smart contract, no claim site, no frontend, no database.

Sender holds the supply. Every day the script snapshots holders, unlocks a share of the 50% airdrop pool based on progress toward the holder goal, splits the daily amount equally across qualifying wallets, and never lets the sender balance fall below the 15% retained supply floor.

## Setup

1. `npm install`
2. `cp .env.example .env`
3. Fill in `.env`
4. `npm run snapshot`
5. `npm run preview`
6. `npm run test-send`
7. `npm run send-daily`

Do not run `send-daily` until the 3-wallet test proves the token, decimals, wallet, and transfer logic are correct.

## Warnings

* Use only a dedicated airdrop wallet.
* Do not put treasury wallet keys here.
* Fund the wallet only with the tokens intended for distribution plus SOL for fees.
* After finished, move leftovers out.
* Do not commit `.env`.

## Distribution

Default mode is `streak`. Daily share = balance x consecutive snapshot days without selling, capped by `STREAK_CAP`. Any balance decrease resets the streak to 1. New wallets start at 1. Weight is linear in balance, so splitting a bag across wallets earns nothing extra, and fresh wallets start unstreaked, so splitting loses. Streaks count snapshot days, so run the snapshot daily. `DISTRIBUTION_MODE` also accepts `prorata` (balance only) and `equal` (reference only, sybil-vulnerable).

## Notes

* The RPC must support `getProgramAccounts` for the token program. Helius, QuickNode, or Triton work. Public mainnet RPC does not.
* Classic SPL and Token-2022 are both supported. The program is detected from the mint automatically.
* Amounts in `.env` are human token amounts. The script converts using on-chain decimals.
* Sent logs are append-only JSON lines, written after every confirmed transfer. Rerunning `send-daily` on the same date skips wallets already paid. No double sends within a daily batch.
* Test sends count toward the total distributed.
* `data/` never leaves this machine. It is gitignored.

## Auto mode

`npm run send-auto` runs snapshot, preview, tripwire guards, then the send with no prompt. Guards halt the run before any token moves: minimum receiving wallets (`AUTO_MIN_HOLDERS`), receiving count dropping more than `AUTO_MAX_HOLDER_DROP_PERCENT` vs the previous run, or the top wallet taking more than `AUTO_MAX_TOP_SHARE_PERCENT` of the day. A halt posts a macOS notification and exits nonzero. Same-day reruns are harmless, paid wallets are skipped. Schedule it with launchd. Manual commands are unchanged.

Allocations freeze at the first send of each date. One allocation set per day. Wallets that qualify after the freeze enter at the next daily run.
