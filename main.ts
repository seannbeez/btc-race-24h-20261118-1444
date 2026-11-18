// btc-race-24h-20261118-1444: selective dip mean-reversion bot for cbBTC/USDC.
//
// The harness speaks agent-fun/bars-replay/v1: it sends one hello, then one
// batch per minute bar, then done. This bot answers every batch with exactly
// one reply echoing the batch seq, carrying zero or one order. A buy decided
// on a batch fills at the next bar's open, so every decision here is made on
// a closed bar and priced at the following open.
//
// Strategy (why these numbers — all re-validated on THIS kit's dev window,
// 2026-11-18, not carried over blindly from the 15 Nov race):
//
// The dev window is a quiet, slow drift down (-280 bps over 24 h, 1-minute
// volatility only ~7 bps, max dip vs SMA120 just 133 bps). The old
// 200 bps dip trigger fires ZERO times on it, so it would fail the dev gate
// with exactly $0. The only clean mean-reversion event in the window is one
// sharp plunge (bars ~61-69, -280 bps in ~15 bars) followed by a +160 bps
// bounce. Everything else that looks like a dip is slow drift: buying it
// loses money after the ~36 bps full-size round-trip cost (4 bps fee +
// 2 bps slippage + ~12 bps impact each way at ~$840k pool depth).
//
// So the entry is deliberately selective. It buys full size only when the
// close is far below a moving average AND has already started to turn:
//   - dip >= 75 bps vs the 15-bar average, OR
//   - dip >= 100 bps vs the 60-bar average, OR
//   - dip >= 200 bps vs the 120-bar or 240-bar average (the deep-dip leg
//     from the 15 Nov family: never fires on this dev window, but it is
//     the leg that catches a real capitulation if the race window has one),
//   AND the close is above the previous bar's low (rebound confirmation:
//   never buy while the price is still making fresh lows).
// The rebound filter is what keeps the bot out of the losing dips: on the
// dev window it rejects the entries at the falling edge of the plunge and
// admits exactly one buy, at the bar after the low.
//
// Exits (whole position, first trigger wins): take-profit +100 bps above
// the entry close, trailing stop 50 bps below the peak close since entry,
// hard stop-loss -75 bps, or max hold 60 bars. Cooldown 10 bars after a
// sell before the next buy. On the dev window the single trade exits on
// take-profit. A 100 bps target (not 150+) is deliberate: the dev bounce
// peaked and faded, so a higher target banks less.
//
// Two window-shape rules, both counted in bars seen (never wall clock):
//   - No new buys in the final 60 bars: a trade opened there has no time
//     to reach its target and is flattened at the last close instead.
//     On dev this avoids a -$2.43 forced flattening.
//   - Late-window guardrail: if no position has ever been held by bar
//     1200, the dip loosens to >= 50 bps vs the 60- or 30-bar average
//     (still with the rebound filter, still before the final-60 cutoff).
//     This never fires on the dev window (the bot already traded), it is
//     insurance for the race window only: an entry with zero trades ranks
//     below every entry that meets the 1-trade guardrail, so a late loose
//     trade is worth more than no trade at all.
//
// Volatility-adaptive thresholds were tested and REJECTED on this window:
// scaling the dip by realised 60-bar volatility scored +$5.89 with a
// negative walk-forward segment, vs +$9.34 for the fixed thresholds above.
//
// Multi-regime candidates (Fura's design) were tested the same way and
// REJECTED: Bollinger(20) + RSI(7) wick buys -$19 to -$53 (11-16 round
// trips, 5/6 walk-forward segments negative); momentum breakout on
// volatility spike + Kaufman efficiency -$0.67 to -$5.94 with one trade
// (or $0 with no trade at strict thresholds); hybrids of either with this
// dip bot scored +$2.37 (breakout) and -$12.43 (Bollinger), both worse
// than this bot alone. End-of-window force-close was tested too: selling
// in the final 5-10 minutes scored $6.43 vs $6.91 for the harness's own
// auto-flatten, so the bot keeps the no-new-buys cutoff instead of an
// early force-close. Full size (100% of cash) beat 70-95% sizing on both
// PnL and walk-forward. These rejections match the Nov 15 evidence
// (RSI-Bollinger -$57, EMA-cross -$135, momentum -$41 to -$80).
//
// Verified grade-local (Node 22, --driver process, kit dev window):
// net PnL +$9.337934, 2 trades (1 buy + 1 sell), win rate 1.0,
// max drawdown 0.4807%, fees $0.803897, net PnL at 2x fees +$8.531070,
// 0 rejected, L1 regrade reproduced byte for byte. All PnL comes from
// hourly block 1 (the single plunge-and-bounce); walk-forward 6x4h
// segments: [+$9.34, $0, $0, $0, $0, $0] — 1/6 positive, 0/6 negative.
//
// Everything is bigint arithmetic on raw closes, no randomness, no wall
// clock, no network, no files: two executions on the same bars give the
// same orders. The hello seed is accepted but unused.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;

// Entry: dip thresholds in bps, per moving-average length.
const DIP_SHORT_BPS = 75n; // vs the 15-bar average
const DIP_MID_BPS = 100n; // vs the 60-bar average
const DIP_DEEP_BPS = 200n; // vs the 120-bar and 240-bar averages
const DIP_GUARD_BPS = 50n; // late-window guardrail dip vs 60- / 30-bar average

// Exits, in bps unless noted.
const TAKE_PROFIT_BPS = 100n;
const TRAIL_BPS = 50n;
const STOP_LOSS_BPS = 75n;
const MAX_HOLD_BARS = 60;
const COOLDOWN_BARS = 10;

// Window-shape rules, counted in bars seen.
const GUARDRAIL_BAR = 1200; // loosen the dip from here if never traded
const NO_BUY_AFTER_BAR = 1380; // no new buys in the final 60 bars

const MAX_SLIPPAGE_BPS = 100; // 1% past the latest close
const MIN_BUY_QUOTE = 1_000_000n; // $1 minimum buy notional

/** Rolling mean of the last `length` raw closes, kept as a running sum. */
class RunningMean {
  readonly length: number;
  private ring: bigint[] = [];
  private sum = 0n;

  constructor(length: number) {
    this.length = length;
  }

  push(close: bigint): void {
    this.ring.push(close);
    this.sum += close;
    if (this.ring.length > this.length) {
      this.sum -= this.ring.shift()!;
    }
  }

  get ready(): boolean {
    return this.ring.length >= this.length;
  }

  get mean(): bigint {
    return this.sum / BigInt(this.length);
  }

  /** How far below this mean `close` sits, in bps (0 when at/above it). */
  dipBps(close: bigint): bigint {
    if (!this.ready) return 0n;
    const avg = this.mean;
    if (close >= avg) return 0n;
    return ((avg - close) * BPS) / avg;
  }
}

/** The whole trading state, carried across batches. */
class DipTrader {
  private shortMean = new RunningMean(15);
  private midMean = new RunningMean(60);
  private longMean = new RunningMean(120);
  private longerMean = new RunningMean(240);
  private guardMean = new RunningMean(30);
  private prevLow: bigint | null = null;
  private seenBars = 0;
  private everHeld = false;
  private pendingEntry: bigint | null = null;
  private entryClose: bigint | null = null;
  private peakClose: bigint | null = null;
  private heldBars = 0;
  private cooldownLeft = 0;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // no fresh bar this minute: decide nothing
    const close = BigInt(bar.c);
    const low = BigInt(bar.l);
    this.seenBars += 1;

    this.shortMean.push(close);
    this.midMean.push(close);
    this.longMean.push(close);
    this.longerMean.push(close);
    this.guardMean.push(close);

    const holding = state.positions.get(SYMBOL);
    const held = holding !== undefined && holding.qty > 0n;
    if (held) {
      this.everHeld = true;
      if (this.entryClose === null) {
        // The buy sent on an earlier batch has now filled (at this bar's
        // open). Anchor exits on the close it was decided on.
        this.entryClose = this.pendingEntry ?? close;
        this.peakClose = this.entryClose;
        this.heldBars = 0;
      }
      this.pendingEntry = null;
    } else {
      this.entryClose = null;
      this.peakClose = null;
      this.heldBars = 0;
      this.pendingEntry = null;
    }

    let orders: OrderInput[] = [];
    if (state.warmingUp) {
      // Warm-up batches build history only; orders here are rejected.
    } else if (held) {
      orders = this.exitOrders(holding!.qty, close);
    } else {
      orders = this.entryOrders(state, close);
    }

    this.prevLow = low;
    return orders;
  }

  /** Whole-position exits, first trigger wins. */
  private exitOrders(qty: bigint, close: bigint): OrderInput[] {
    this.heldBars += 1;
    if (this.peakClose !== null && close > this.peakClose) this.peakClose = close;
    const entry = this.entryClose!;
    const peak = this.peakClose!;
    const up = ((close - entry) * BPS) / entry;
    const down = ((entry - close) * BPS) / entry;
    const offPeak = ((peak - close) * BPS) / peak;
    const done =
      up >= TAKE_PROFIT_BPS ||
      down >= STOP_LOSS_BPS ||
      offPeak >= TRAIL_BPS ||
      this.heldBars >= MAX_HOLD_BARS;
    if (!done) return [];
    this.cooldownLeft = COOLDOWN_BARS;
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  /** Full-size buy when a deep dip has started to turn. */
  private entryOrders(state: BarsState, close: bigint): OrderInput[] {
    if (this.cooldownLeft > 0) {
      this.cooldownLeft -= 1;
      return [];
    }
    if (this.seenBars >= NO_BUY_AFTER_BAR) return []; // too late to exit cleanly
    // Rebound confirmation: never buy while still making fresh lows.
    if (this.prevLow === null || close <= this.prevLow) return [];

    const dipped =
      this.shortMean.dipBps(close) >= DIP_SHORT_BPS ||
      this.midMean.dipBps(close) >= DIP_MID_BPS ||
      this.longMean.dipBps(close) >= DIP_DEEP_BPS ||
      this.longerMean.dipBps(close) >= DIP_DEEP_BPS;
    let guardrail = false;
    if (!dipped && !this.everHeld && this.seenBars >= GUARDRAIL_BAR) {
      // Insurance only: no trade yet late in the window, so accept a
      // shallower dip rather than finish with zero trades.
      guardrail =
        this.midMean.dipBps(close) >= DIP_GUARD_BPS ||
        this.guardMean.dipBps(close) >= DIP_GUARD_BPS;
    }
    if (!dipped && !guardrail) return [];

    const cash = state.cash;
    if (cash < MIN_BUY_QUOTE) return [];
    this.pendingEntry = close;
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
}

const trader = new DipTrader();

await runBars({
  onBatch(state, batch) {
    return trader.onBatch(state, batch);
  },
});
