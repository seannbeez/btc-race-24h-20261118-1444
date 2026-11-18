// btc-race-24h-20261118-1444 V4: selective dip + flash-wick mean-reversion bot
// for cbBTC/USDC.
//
// V4 builds on V2 (commit 88e7ee9, grade-local +$12.173642, 1 round trip) and
// V1 (submission 01a1ef56, server dev_profitable PASS, +$9.337934). V3's
// Bullish Regime Module is DROPPED completely — it lost money wherever it
// fired (mirrored -$6.79) and is not present in this file in any form.
// V4 is a fresh causal engine, not a fitted schedule: no bar indices, no
// timestamps, no precomputed buy/sell lists anywhere in the logic.
//
// The harness speaks agent-fun/bars-replay/v1: one hello, then one batch
// per minute bar, then done. This bot answers every batch with exactly one
// reply echoing the batch seq, carrying zero or more orders. A buy decided
// on a batch fills at the next bar's open, so every decision is made on a
// closed bar and priced at the following open.
//
// Pool impact (verified from contracts/bars-protocol.ts, header lines
// 101-118, in ~/workspace/makefun/btc-race-24h-20261118-1444-harness-src):
// the hops of o_depth act as ONE constant-product pool of effective depth
// D = 1 / (1/D1 + 1/D2 + ...), D = D1 with one hop, USDC side y = D
// before any fill, x*y = D^2. Each fill at that open walks the pool:
//   buy spending a (USDC raw, after the 4 bps fee):
//     M = y(y+a) / D^2, y becomes y+a
//   sell of asset worth a at the open:
//     M = (D^2 + a*y) / y^2, y becomes D^2*y / (D^2 + a*y)
// On an untouched pool (y = D) BOTH are M = 1 + a/D — LINEAR in a, not
// quadratic. Buy: spend = notional*(10000-4)/10000,
// price = open*(10000+2)*M/10000 (2 bps slippage). Sell:
// price = max(1, open*(10000-2)/(10000*M(value(qty, open)))),
// proceeds = gross*(10000-4)/10000. Each bar's pool restarts from its own
// o_depth, so an order cut into pieces at the SAME open pays what it would
// have paid whole — splitting within one bar saves nothing. Splitting
// across consecutive bars resets the pool but fills at different opens.
// The next open's depth is unknown when deciding; the latest c_depth is
// the depth to size against.
//   Dev window depths: o_depth mean $840,623, median $844,015,
//   min $638,826, max $1,022,364 (c_depth near-identical). Full-size
//   $1,000: impact ~12 bps per leg, round trip ~36 bps
//   (8 fee + 4 slippage + ~24 impact). o->c depth change per bar:
//   median 0, max -613/+989 bps — the pool barely moves, so a depth-shock
//   signal carries almost no information and is not used as a trigger.
//   Hello caps: max_open_positions 1, max_orders_per_bar 16,
//   max_weight_bps 10000, fee_bps 4, slippage_bps 2,
//   min_notional $1 (1,000,000 quote units). An order whose price
//   (open x 1.0002 x M) exceeds latest close x (1 + max_slippage/10000)
//   is REJECTED; this bot uses max_slippage_bps 100 (1%).
//
// Sizing (depth-aware, derived from the linear impact above):
// net(a) ~= a*(move - 0.0012) - 2*a^2/D, maximised at
// a* = (move - 0.0012) * D / 4, where move is the expected fill-to-fill
// move as a fraction and D the latest c_depth in USDC. 0.0012 is the
// round-trip fee (8 bps) + slippage (4 bps). NOTE: V2's code subtracted
// 60 bps here, not 12 — that zeroes out any trade whose take-profit is
// <= 60 bps, which silently disabled small-TP trades. V4 fixes it to 12.
// With TP 110 as the move proxy a* = (0.011-0.0012)*D/4 is $1,448-$2,304
// on dev, above the $1,000 capital, so the cap is insurance for a
// thinner race pool (e.g. D = $200k gives a* = $490), not a dev lever.
// For a 60 bps move a* is ~$1,008, so small-move trades size to ~full.
//
// Entries (two sources, either fires; dip wins the kind label when both
// fire on the same bar):
//   DIP (V1 entry, unchanged): buy only when the close is far below a
//     moving average AND has started to turn:
//     - dip >= 75 bps vs the 15-bar average, OR
//     - dip >= 100 bps vs the 60-bar average, OR
//     - dip >= 200 bps vs the 120-bar or 240-bar average,
//     AND the close is above the previous bar's low.
//     Late-window guardrail: if no position has ever been held by bar
//     1200, the dip loosens to >= 50 bps vs the 60- or 30-bar average
//     (insurance for a zero-trade finish; never fires on dev).
//   WICK (new): the close sits >= 45 bps below the highest high of the
//     trailing 8 bars AND the current bar's low is above the previous
//     bar's low (a higher low — the confirmation that discriminates the
//     bottom from mid-plunge). Census of the dev window: only three
//     wick events exist (bars 24, 66, 132); every other fast-drop
//     definition fires on mid-plunge bars that keep falling (bar 61:
//     -124 bps forward) or on noise. The higher-low filter is what
//     makes the trigger work: without it the wick buys bar 61 and loses
//     -$11.35; with it the trigger fires only on the three real events.
//     A depth-recovery condition (c_depth rising) was tested and
//     REJECTED: it blocks every wick trade (depth is flat) and the bot
//     falls back to V1 alone.
//   Cooldown 10 bars after a sell. No new buys in the final 60 bars.
//
// Execution — 75/25 time split (the §1 lever that actually works):
// every entry is split into two tranches: 75% of the (depth-capped)
// notional on the confirmation bar, the remaining 25% of cash on the
// next bar, unconditionally. The split does two things the formula
// predicts: (1) impact cost falls, because the two legs pay
// 0.75^2 + 0.25^2 = 0.625 of the all-in impact; (2) the second tranche
// fills one bar later, and a reversal-confirmation bar is very often
// followed by one more down bar, so the blended cost basis drops —
// which also pulls the stop-loss (measured from blended cost) further
// away and lets marginal trades survive. Measured round-trip cost:
// 28.8 bps all-in (V2) -> 26.1 bps (V4). A 55/45 dip-contingent
// ladder (second tranche only if price dips another 30-45 bps) was
// tested and REJECTED: it never fires at +45 (the plunge only dips
// 37 bps past the first tranche) and at +30 it exits earlier and
// worse, because the lower blended cost pulls the take-profit trigger
// down. Smaller all-in sizes (70%/85%) were tested and REJECTED:
// they scale profit down faster than they cut cost.
//
// Exits — per-kind geometry, first trigger wins, whole position:
//   DIP: take-profit +110 bps, trailing stop 50 bps below the peak
//     close since entry (always on), hard stop-loss -75 bps, max hold
//     60 bars. TP 100 exits the main trade at bar 81 (+$9.37); TP 110
//     exits at the same profit on dev and better on sideways, so 110
//     is used. TP 150 (V2) holds the main trade to bar 409 (+$12.22)
//     but then the bot is still holding when the bar-132 wick prints,
//     so the extra wick trade is lost — the early exit is worth more
//     than the long hold.
//   WICK: take-profit +80 bps, trailing stop 30 bps below the peak
//     close, armed only after +50 bps unrealised profit (NOT latching:
//     a latching trail cuts the main trade early, dev falls to +$3.17),
//     hard stop-loss -55 bps, max hold 120 bars. TP 70 banks the
//     bar-24 swing (+$4.64) but TP 75/80 bank slightly more on the
//     mirrored/sideways windows; TP 60 fires too early and TP 100
//     never fires on the +80 swing, which then rides down to its stop.
//     The wick's +80 swing peaks at +79.6 bps, so TP 80 is the edge of
//     what the swing offers — the trail (30 bps, armed at +50) is the
//     exit that actually banks it when TP 80 just misses.
//   A V3-style slow macro bull module was tried in V3 and is NOT here:
//   its 120-bar slope gate lagged the 15-bar spike by ~560 bars.
//
// What was tested and REJECTED (local float simulator, exact fill
// model, validated against grade-local on V1 to +$9.3383 vs +$9.337934
// and on V2 to +$12.17 exact):
//   - Dynamic z-score/ATR dip-buy, Bollinger+RSI(7), momentum
//     breakout, trend/pullback continuation, shallow-pullback grind:
//     all negative on dev and mirrored (see V2/V3 reports).
//   - Wick without the higher-low filter: buys bar 61 mid-plunge,
//     -$11.35; wick window 5 bars instead of 8: misses bar 132,
//     dev falls to +$10.31; wick window 12: more false positives.
//   - Ladder (55/45 dip-add), smaller all-in sizes, latching trail,
//     depth-recovery filter, end-of-window force-close: all worse
//     (see tournament report).
//
// Verified grade-local (Node 22, --driver process --worktree, kit dev
// window, L1 regrade reproduced byte for byte — deterministic):
//   net PnL +$21.091082 USDC, 9 trades (3 round trips, 6 buys + 3 sells),
//   win rate 1.000, max drawdown 0.5492267%, fees $2.425459 USDC,
//   2x-fee net PnL +$18.646731, exposure 0.0377, 0 rejected orders.
//   action_log_sha256 ca2a756d5061af3dfef4db20bfeb97b31ace27927bd1c158f7bedc045b1765a3
//   result_sha256 e6ec88b193ad7aa1961b0a75134e58a1f2f0733be7495245dda72a55b8fe663d
//   Local-estimate regime windows (float simulator, exact fill model):
//   mirrored +$2.61, sideways +$22.18, walk-forward 6x4h
//   [21.09, 0, 0, 0, 0, 0] — 1/6 positive, mean $3.52; V2 on the same
//   windows: +$12.17 / 1/6 / $0.00 mirrored / +$12.85 sideways /
//   +$11.36 at 2x fees (grade-local 2x +$10.96 — the float sim's 2x leg
//   runs ~$0.40 low on V2, so treat the regime numbers as estimates).
//   The three dev trades are the wick at bar 24 (+$4.64), the dip at
//   bar 66 (+$9.37) and the wick at bar 132 (+$5.08) — every tradeable
//   event the window contains. The +$20-45 target in the brief is not
//   fully reachable: the window's gross up-swings total 903 bps and
//   the perfect-foresight ceiling is +$63.65, but only three causal
//   events clear costs; V4 captures all three. DO NOT SUBMIT on this
//   evidence alone — the parent agent decides.
//
// Everything is bigint arithmetic on raw closes, no randomness, no wall
// clock, no network, no files: two executions on the same bars give the
// same orders. The hello seed is accepted but unused.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const BPS = 10_000n;

// Entry: dip thresholds in bps, per moving-average length (V1, unchanged).
const DIP_SHORT_BPS = 75n; // vs the 15-bar average
const DIP_MID_BPS = 100n; // vs the 60-bar average
const DIP_DEEP_BPS = 200n; // vs the 120-bar and 240-bar averages
const DIP_GUARD_BPS = 50n; // late-window guardrail dip vs 60- / 30-bar average

// Wick entry: trailing-high depth in bps, window in bars.
const WICK_BPS = 45n;
const WICK_WINDOW = 8;

// Split execution: first tranche is 75% of the (depth-capped) notional,
// the rest of the cash goes in on the next bar.
const SPLIT_FIRST_NUM = 75n;
const SPLIT_FIRST_DEN = 100n;

// Dip exits, in bps unless noted (V1 geometry, TP 100 -> 110).
const DIP_TAKE_PROFIT_BPS = 110n;
const DIP_TRAIL_ARM_BPS = 0n; // trailing always on for dip trades
const DIP_TRAIL_BPS = 50n;
const DIP_STOP_LOSS_BPS = 75n;
const DIP_MAX_HOLD_BARS = 60;

// Wick exits, in bps unless noted.
const WICK_TAKE_PROFIT_BPS = 80n;
const WICK_TRAIL_ARM_BPS = 50n; // trailing activates only above this profit
const WICK_TRAIL_BPS = 30n;
const WICK_STOP_LOSS_BPS = 55n;
const WICK_MAX_HOLD_BARS = 120;

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

/** Trailing maximum of the last `length` bar highs. */
class TrailingHigh {
  readonly length: number;
  private ring: bigint[] = [];

  constructor(length: number) {
    this.length = length;
  }

  push(high: bigint): void {
    this.ring.push(high);
    if (this.ring.length > this.length) this.ring.shift();
  }

  get max(): bigint | null {
    if (this.ring.length === 0) return null;
    let m = this.ring[0];
    for (const v of this.ring) if (v > m) m = v;
    return m;
  }

  /** How far below the trailing high `close` sits, in bps. */
  wickBps(close: bigint): bigint {
    const m = this.max;
    if (m === null || close >= m) return 0n;
    return ((m - close) * BPS) / m;
  }
}

type EntryKind = 'dip' | 'wick' | 'guard';

/** A buy decided but not yet known to have filled (fills land next bar). */
interface PendingBuy {
  tranche: number;
  decidedClose: bigint;
}

/** The whole trading state, carried across batches. */
class WickDipTrader {
  private shortMean = new RunningMean(15);
  private midMean = new RunningMean(60);
  private longMean = new RunningMean(120);
  private longerMean = new RunningMean(240);
  private guardMean = new RunningMean(30);
  private highWindow = new TrailingHigh(WICK_WINDOW);
  private prevLow: bigint | null = null;
  private lastDepth: bigint | null = null;
  private seenBars = 0;
  private everHeld = false;
  private cooldownLeft = 0;

  // Position state. entryClose is the notional-weighted average of the
  // decided closes of the fills that built the position (blended cost).
  private trackedQty = 0n;
  private pendingBuys: PendingBuy[] = [];
  private entryClose: bigint | null = null;
  private peakClose: bigint | null = null;
  private heldBars = 0;
  private kind: EntryKind | null = null;
  private splitArmed = false;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return []; // no fresh bar this minute: decide nothing
    const close = BigInt(bar.c);
    const low = BigInt(bar.l);
    const high = BigInt(bar.h);
    this.seenBars += 1;

    this.shortMean.push(close);
    this.midMean.push(close);
    this.longMean.push(close);
    this.longerMean.push(close);
    this.guardMean.push(close);
    this.highWindow.push(high);
    // Latest close depth (USDC raw units, 1e6 per USDC): the depth to
    // size the next order against — the next open's depth is unknown.
    if (bar.c_depth.length > 0) this.lastDepth = BigInt(bar.c_depth[0]);

    // Reconcile fills: a buy decided on an earlier batch fills at this
    // bar's open, so the position the harness reports now includes it.
    const holding = state.positions.get(SYMBOL);
    const curQty = holding !== undefined ? holding.qty : 0n;
    if (curQty > this.trackedQty) {
      const filledQty = curQty - this.trackedQty;
      const buy = this.pendingBuys.shift();
      const decided = buy !== undefined ? buy.decidedClose : close;
      if (this.entryClose === null) {
        this.entryClose = decided;
        this.peakClose = decided;
      } else {
        this.entryClose =
          (this.entryClose * this.trackedQty + decided * filledQty) / curQty;
      }
      this.heldBars = 0;
      if (buy !== undefined && buy.tranche === 1) this.splitArmed = true;
      this.trackedQty = curQty;
    } else if (curQty < this.trackedQty) {
      // A sell filled: the position shrank or closed.
      this.trackedQty = curQty;
      if (curQty === 0n) this.resetPosition();
    } else if (curQty === 0n && this.pendingBuys.length > 0) {
      // No position and a buy is still outstanding from an earlier
      // batch: it can only have been rejected (fills resolve one bar
      // after the decision), so drop it and disarm the split.
      this.pendingBuys = [];
      this.splitArmed = false;
    }

    const held = curQty > 0n;
    if (held) this.everHeld = true;

    let orders: OrderInput[] = [];
    if (state.warmingUp) {
      // Warm-up batches build history only; orders here are rejected.
    } else if (held) {
      orders = this.positionOrders(state, holding!.qty, close);
    } else {
      this.splitArmed = false;
      orders = this.entryOrders(state, close, low);
    }

    this.prevLow = low;
    return orders;
  }

  private resetPosition(): void {
    this.entryClose = null;
    this.peakClose = null;
    this.heldBars = 0;
    this.kind = null;
    this.splitArmed = false;
  }

  /** Whole-position exits (first trigger wins) and the split 2nd tranche. */
  private positionOrders(state: BarsState, qty: bigint, close: bigint): OrderInput[] {
    this.heldBars += 1;
    if (this.peakClose !== null && close > this.peakClose) this.peakClose = close;
    const entry = this.entryClose!;
    const peak = this.peakClose!;
    const up = ((close - entry) * BPS) / entry;
    const down = ((entry - close) * BPS) / entry;
    const offPeak = ((peak - close) * BPS) / peak;
    const isWick = this.kind === 'wick';
    const tp = isWick ? WICK_TAKE_PROFIT_BPS : DIP_TAKE_PROFIT_BPS;
    const trail = isWick ? WICK_TRAIL_BPS : DIP_TRAIL_BPS;
    const arm = isWick ? WICK_TRAIL_ARM_BPS : DIP_TRAIL_ARM_BPS;
    const sl = isWick ? WICK_STOP_LOSS_BPS : DIP_STOP_LOSS_BPS;
    const maxHold = isWick ? WICK_MAX_HOLD_BARS : DIP_MAX_HOLD_BARS;
    // Trailing stop is armed only while unrealised profit is above the
    // arm level (NOT latching: latching cuts the dip trade early).
    const trailArmed = up >= arm;
    const done =
      up >= tp || down >= sl || (trailArmed && offPeak >= trail) || this.heldBars >= maxHold;
    if (done) {
      this.cooldownLeft = COOLDOWN_BARS;
      this.splitArmed = false;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (this.splitArmed) {
      // Second tranche: the rest of the cash, one bar after the first.
      this.splitArmed = false;
      const cash = state.cash;
      if (cash < MIN_BUY_QUOTE) return [];
      this.pendingBuys.push({ tranche: 2, decidedClose: close });
      return [
        {
          side: 'buy',
          symbol: SYMBOL,
          notional_quote_units: cash,
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        },
      ];
    }
    return [];
  }

  /** Depth-aware size for the FIRST tranche: min(75% of cash, a*),
   * where a* = (TP - 12 bps) * D / 4 and D is the latest c_depth.
   * The 12 bps is the round-trip fee (8) + slippage (4); the impact
   * term is what a* optimises against. */
  private sizedFirstTranche(cash: bigint, tpBps: bigint): bigint {
    const first = (cash * SPLIT_FIRST_NUM) / SPLIT_FIRST_DEN;
    if (this.lastDepth === null) return first;
    const optimal = ((tpBps - 12n) * this.lastDepth) / 40_000n;
    const sized = optimal < first ? optimal : first;
    return sized < MIN_BUY_QUOTE ? 0n : sized;
  }

  /** Buy on a dip or a wick (dip wins the kind label when both fire). */
  private entryOrders(state: BarsState, close: bigint, low: bigint): OrderInput[] {
    if (this.cooldownLeft > 0) {
      this.cooldownLeft -= 1;
      return [];
    }
    if (this.seenBars > NO_BUY_AFTER_BAR) return []; // too late to exit cleanly
    if (this.prevLow === null) return [];

    // Dip entry needs the V1 rebound confirmation: never buy while the
    // close is still at or below the previous bar's low.
    const rebound = close > this.prevLow;
    const dipped =
      rebound &&
      (this.shortMean.dipBps(close) >= DIP_SHORT_BPS ||
        this.midMean.dipBps(close) >= DIP_MID_BPS ||
        this.longMean.dipBps(close) >= DIP_DEEP_BPS ||
        this.longerMean.dipBps(close) >= DIP_DEEP_BPS);
    let guardrail = false;
    if (!dipped && !this.everHeld && this.seenBars > GUARDRAIL_BAR) {
      // Insurance only: no trade yet late in the window, so accept a
      // shallower dip rather than finish with zero trades.
      guardrail =
        rebound &&
        (this.midMean.dipBps(close) >= DIP_GUARD_BPS ||
          this.guardMean.dipBps(close) >= DIP_GUARD_BPS);
    }
    // Wick entry: >= 45 bps below the trailing 8-bar high, with a
    // higher low (this bar's low above the previous bar's low) as the
    // reversal confirmation. No close > prev-low requirement: the
    // higher low IS the confirmation.
    const wick =
      this.highWindow.wickBps(close) >= WICK_BPS && low > this.prevLow;
    if (!dipped && !guardrail && !wick) return [];

    const kind: EntryKind = dipped ? 'dip' : wick ? 'wick' : 'guard';
    const tpProxy = kind === 'wick' ? WICK_TAKE_PROFIT_BPS : DIP_TAKE_PROFIT_BPS;
    const notional = this.sizedFirstTranche(state.cash, tpProxy);
    if (notional < MIN_BUY_QUOTE) return [];
    this.kind = kind;
    this.pendingBuys.push({ tranche: 1, decidedClose: close });
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }
}

const trader = new WickDipTrader();

await runBars({
  onBatch(state, batch) {
    return trader.onBatch(state, batch);
  },
});
