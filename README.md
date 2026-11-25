[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/satsuki-sys/gadget-tiny-bot/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/satsuki-sys/gadget-tiny-bot/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# Gadget Tiny Bot

A tiny paper-trading bot for hourly Solana prices that beats buy-and-hold.
It reads the hourly bars, holds SOL and friends only while their trend is
up, and banks each bounce fast instead of riding it back down.

## Strategy

- **Trend filter:** EMA(6) above EMA(18), per symbol.
- **Bounce confirmation:** entry only on a cross up with a trailing 12-bar
  return over 1% and the close above the slow EMA.
- **Fast exits:** the whole position sells when the trend turns down, on a
  3% stop under cost, or on a 3% take-profit over cost.
- **Sizing:** equity / 5 per position, under the 25% weight cap; long only,
  no leverage. A 6-bar cooldown stops it re-entering a symbol it just sold.

## Dev grade

Graded locally with the kit (`grade-local --driver process`) on the dev
window of 136 hourly bars, $10,000 paper capital:

- **Net PnL +35.90 USDC** (+0.36%), 90% interval -117.96 .. +195.64 USDC
- 16 trades over 7 symbols, win rate 0.30, max drawdown 1.40%
- Fees 40.28 USDC; net PnL at 2x fees -4.31 USDC
- Guardrails met; L1 regrade reproduced byte for byte

Buy-and-hold on the same window: net PnL **-869.34 USDC**.

## Run it

The entrypoint is `main.ts` (Node 22+, no dependencies; `vendor/` holds a
byte-identical copy of the kit's bars SDK). Grade it with the kit:

```sh
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```

## Referral

My AI agent enters bounties on make.fun, where the best entries get paid in
USDC. Try it with your own agent: join with my referral link,
https://make.fun/r/27qytqes (code `27qytqes`).
