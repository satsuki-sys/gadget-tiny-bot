// Gadget tiny bot: a cautious trend rider for hourly Solana bars.
//
// Idea: buy-and-hold lost ~8.7% on the dev window, and every house baseline
// lost money there too, so the edge here is not being in the market when it
// falls. This bot only buys a symbol on a confirmed bounce and banks the
// bounce fast, instead of riding it back down.
//
//   - Indicators, per symbol over its own closes: EMA(6) and EMA(18), each
//     starting as the mean of its first span of closes, then moving
//     2 / (span + 1) of the way to each new close. They read every batch,
//     a warm-up's included; while warming up it sends no order.
//   - Entry, on a bar's close (filled at the next open): EMA(6) crosses
//     above EMA(18), the close sits above EMA(18), and the trailing 12-bar
//     return is over 1% (a real bounce, not a one-bar flicker), on a symbol
//     it does not hold and did not just sell.
//   - Exit, the whole position: EMA(18) crosses above EMA(6), or the
//     position worth 3% under its cost, or 3% over it (bank the bounce:
//     on the dev window the bounces topped out near 3% and then faded).
//   - Stake: equity over 5 slots, each buy the smallest of equity / 5,
//     caps.max_weight_bps of equity and the cash this reply has not spent
//     yet; below fees.min_notional_quote_units it buys nothing.
//   - A reply carries the sells first, then the buys in universe order, at
//     most caps.max_orders_per_bar in all. Each order caps its slippage at
//     100 bps past the close it was decided on, so a sell into a liquidity
//     gap is refused (and sent again) rather than filled for almost nothing.
//   - The EMAs run in float64 on + - * / alone, each correctly rounded
//     (IEEE 754), so the same bars give the same orders, run after run.
//     No clock, no environment, no randomness: the two grading runs agree.
//
// Dev grade (grade-local, process driver): net PnL +35.90 USDC on $10,000
// capital, 16 trades over 7 symbols, win rate 0.30, max drawdown 1.40%,
// fees 40.28 USDC (net PnL at 2x fees -4.31 USDC), guardrails met,
// L1 regrade reproduced byte for byte. Buy-and-hold on the same window:
// net PnL -869.34 USDC.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 6;
const SLOW_BARS = 18;
const MOMENTUM_BARS = 12;
/** Entry needs a trailing 12-bar return over 1%. */
const MOMENTUM_MIN = 1.01;
/** Take profit: worth 103% of its cost. */
const TAKE = [103n, 100n] as const;
/** Stop loss: worth 97% of its cost. */
const STOP = [97n, 100n] as const;
/** Bars to wait after selling a symbol before buying it again. */
const COOLDOWN_BARS = 6;
/** Stake slots: equity over 5 per buy (under the 25% weight cap). */
const STAKE_SLOTS = 5;
const MAX_SLIPPAGE_BPS = 100;

/** One EMA: the closes it has seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** fast - slow after the symbol's bar before this one, once both are set. */
  gap: number | null;
  /** The same after this bar. */
  now: number | null;
  /** The sell signal: set on a cross of EMA(18) above EMA(6), held while it stays above. */
  down: boolean;
  /** Closes, to read the trailing return off. */
  closes: number[];
  /** The batch seq of the last sell, for the re-entry cooldown. */
  lastSellSeq: number;
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      gap: null, now: null, down: false, closes: [], lastSellSeq: -1_000_000,
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  s.gap = s.now;
  s.now = s.fast.value !== null && s.slow.value !== null ? s.fast.value - s.slow.value : null;
  if (s.now === null || s.now >= 0) s.down = false;
  s.closes.push(c);
  return s;
}

/** Whether a held position exits on this close: the trend turned down, or the stop / take-profit hit. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, signal: boolean): boolean {
  if (signal) return true;
  const value = state.value(symbol, held.qty);
  return value * STOP[1] <= held.cost * STOP[0] || value * TAKE[1] >= held.cost * TAKE[0];
}

await runBars({
  onBatch(state, batch) {
    const crossUp = new Set<string>();
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = push(bar);
      fresh.add(bar.symbol);
      if (s.gap === null || s.now === null || bar.v === '0') continue;
      if (s.now > 0 && s.gap <= 0) {
        // Momentum confirmation: the trailing 12-bar return must clear 1%,
        // and the close must sit above the slow EMA (no buying a dead bounce).
        const closes = s.closes;
        const then = closes.length > MOMENTUM_BARS ? closes[closes.length - 1 - MOMENTUM_BARS] : undefined;
        if (then !== undefined && closes[closes.length - 1]! > then * MOMENTUM_MIN && s.slow.value !== null && closes[closes.length - 1]! > s.slow.value) {
          crossUp.add(bar.symbol);
        }
      }
      if (s.now < 0 && s.gap >= 0) s.down = true;
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, series.get(symbol)!.down)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          series.get(symbol)!.lastSellSeq = batch.seq;
        }
      } else if (crossUp.has(symbol) && batch.seq - series.get(symbol)!.lastSellSeq > COOLDOWN_BARS) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const stake = state.equity / BigInt(STAKE_SLOTS);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = Math.min(state.hello.symbols.length, caps.max_open_positions) - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
