// btc-race-24h-20261118-1444 V5: V4-A + 50/50 partial-profit lock on wick
// trades (lock half at +85 bps, ride the rest with a LATCHED 70 bps
// trailing stop, SL 65, max hold 480 bars).
//
// DO NOT SUBMIT — strict gate FAILED. Sim (LOCAL ESTIMATE): dev +$27.46,
// WF [18.63, 0, 8.83, 0, 0, 0] (2/6), mirrored +$0.04, sideways +$33.20,
// whip-saw +$9.51, 2x-fee +$23.78, maxDD 0.55%. The gate needed Dev >$24,
// Mirrored >$8, Sideways >$22, 2x-fee >$20, MaxDD <= 1.2%: mirrored fails
// outright. AND the dev gain is a 1-bps CLIFF, not a robust edge: the
// wick-132 ride survives a 65 bps peak drawdown, so trail 65 gives dev
// +$18.44 while trail 66 gives +$27.46. Do not ship a 1-bps cliff.
// Honest §1 result (trail <= 65): dev +$18.55, BELOW V4-A's +$21.09.
// §2 depth-shock booster: DROPPED — no signal (wick-entry depth changes
// +30/-70/-96 bps, inside the normal range; corr with forward returns
// -0.069; the booster never triggers on dev). §3 breakout: DROPPED —
// best variant dev +$23.13 / mirrored +$9.10-11.54 / 2x-fee +$17.04 /
// MaxDD 1.55% (fails Dev, 2x-fee, MaxDD); it wins the mirrored spike
// (+$6.20) then loses -$8.64 and -$10.02 on later breakouts; whip-saw
// negative in every variant; tighter stops make it worse (MaxDD 2.35%).
// Combinations of lock + breakout are all worse than V4-A on dev
// (best +$13.17) with MaxDD >= 1.49%. VERDICT: KEEP V4-A (commit 74faa2e,
// submission 01a1ef72, grade-local +$21.09) as the final live race bot.
// This commit is the experiment record only.
//
// V4-A builds on V2 (commit 88e7ee9, +$12.17) and V1 (submission 01a1ef56,
// server dev_profitable PASS, +$9.34). V3's Bullish Regime Module is
// DROPPED completely and is not present in this file in any form.
// No bar indices, no timestamps, no precomputed buy/sell lists anywhere
// in the logic: the lock/trail numbers are causal exit geometry, and the
// trail-66 cliff is reported here precisely so it is NOT mistaken for
// an edge.
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
// round-trip fee (8 bps) + slippage (4 bps).
// With TP 110 as the move proxy a* = (0.011-0.0012)*D/4 is $1,448-$2,304
// on dev, above the $1,000 capital, so the cap is insurance for a
// thinner race pool (e.g. D = $200k gives a* = $490), not a dev lever.
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
//   WICK (V4): the close sits >= 45 bps below the highest high of the
//     trailing 8 bars AND the current bar's low is above the previous
//     bar's low (a higher low — the confirmation that discriminates the
//     bottom from mid-plunge). Census of the dev window: only three
//     wick events exist (bars 24, 66, 132); every other fast-drop
//     definition fires on mid-plunge bars that keep falling (bar 61:
//     -124 bps forward) or on noise. The higher-low filter is what
//     makes the trigger work: without it the wick buys bar 61 and loses
//     -$11.35; with it the trigger fires only on the three real events.
//   Cooldown 10 bars after a sell. No new buys in the final 60 bars.
//
// Execution — 75/25 time split: every entry is split into two tranches:
// 75% of the (depth-capped) notional on the confirmation bar, the
// remaining 25% of cash on the next bar, unconditionally. Measured
// round-trip cost: 28.8 bps all-in (V2) -> 26.1 bps (V4).
//
// Exits — per-kind geometry, first trigger wins, whole position unless
// the V5 wick lock fires first:
//   DIP: take-profit +110 bps, trailing stop 50 bps below the peak
//     close since entry (always on), hard stop-loss -75 bps, max hold
//     60 bars. (V5 lock does NOT apply to dip trades: locking the dip
//     at +75/+80 gives dev +$13.30, worse than V4-A.)
//   WICK: take-profit +80 bps, trailing stop 30 bps below the peak
//     close, armed only after +50 bps unrealised profit (NOT latching),
//     hard stop-loss -55 bps, max hold 120 bars — UNLESS the V5 lock
//     fires first: at +85 bps unrealised, sell HALF the position and
//     ride the rest with a LATCHED 70 bps trailing stop (latched because
//     the lock itself proves +85 was reached; a re-checked arm lets the
//     trail disarm exactly when it is needed and the ride half rides
//     down to its stop), stop-loss -65 bps, max hold 480 bars. The
//     wick-132 ride then survives to bar 508 (+276 bps); the wick-24
//     ride exits at +40. Lock 85 / trail 40-65 on the wick gives dev
//     +$18.55-19.40 — the +$27.46 at trail >= 66 is the cliff above.
//
// What was tested and REJECTED (local float simulator, exact fill
// model, validated against grade-local on V1 to +$9.3383 vs +$9.337934,
// on V2 to +$12.17 exact, on V4-A to +$21.09 exact):
//   - Partial locks at +75/+80 on dip+wick or wick-only with ride
//     trails 35-60: dev +$2.55-19.40, all below V4-A.
//   - Pure asymmetric trailing (no lock, armed @+75, trails 35-100,
//     latching or not): dev -$7.27 to +$18.75, MaxDD up to 2.58%.
//   - Depth-shock booster (tighter SL -45 on entry-bar depth drops
//     <= -200 bps): never triggers on dev; depth carries no signal.
//   - Volatility-expansion breakout (ATR20/ATR120 > 1.3-1.4, break of
//     20-bar high after a -25..-45 bps pullback, 75/25 split): best
//     dev +$23.13 / mirrored +$9.10-11.54 / 2x-fee +$17.04 / MaxDD
//     1.55% — fails Dev, 2x-fee and MaxDD; whip-saw negative in every
//     variant; trend/slope filters do not separate the segment-3 win
//     (+$7.12) from the segment-5 loss (-$5.08..-10.85); tighter stops
//     make it worse (more stop-outs, MaxDD 2.35%).
//
// Grade-local for this V5 file is run by the parent agent; the float
// simulator's prediction is net PnL +$27.46 USDC (LOCAL ESTIMATE) with
// the cliff caveat above. V4-A's verified grade-local remains
// +$21.091082 USDC, 9 trades (3 round trips), win rate 1.000,
// max drawdown 0.5492267%, fees $2.425459, 2x-fee +$18.646731.
// DO NOT SUBMIT this file on the +$27.46 number alone.
//
// Everything is bigint arithmetic on raw closes, no randomness, no wall
// clock, no network, no files: two executions on the same bars give the
// same orders. The hello seed is accepted but unused.
//
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

// V5 partial-profit lock (wick trades only): at +85 bps unrealised profit
// sell HALF the position and ride the rest with a LATCHED 70 bps trailing
// stop, stop-loss -65 bps, max hold 480 bars. The lock is checked BEFORE
// the normal exits (at up >= 85 the wick TP 80 would otherwise fire
// first). The trail is latched — the lock itself proves +85 was reached;
// a re-checked arm disarms the trail exactly when it is needed and the
// ride half rides down to its stop. See the header: the +$27.46 dev
// number this produces is a 1-bps cliff (trail 65 -> +$18.44), not an
// edge, and the mirrored leg fails the gate (+$0.04). DO NOT SUBMIT.
const LOCK_BPS = 85n;
const RIDE_TRAIL_BPS = 70n;
const RIDE_STOP_LOSS_BPS = 65n;
const RIDE_MAX_HOLD_BARS = 480;

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
  // V5 lock state: lockDone once the partial lock has fired for this
  // position; rideMode while the remaining half is being ridden.
  private lockDone = false;
  private rideMode = false;

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
    this.lockDone = false;
    this.rideMode = false;
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
    // V5 partial-profit lock, checked BEFORE the normal exits: at +85 bps
    // on a wick trade, sell half the position and ride the rest.
    if (isWick && !this.lockDone && up >= LOCK_BPS) {
      this.lockDone = true;
      this.rideMode = true;
      const half = qty / 2n;
      if (half > 0n) {
        return [{ side: 'sell', symbol: SYMBOL, qty: half, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
    }
    // In ride mode the take-profit is disabled (the trail is the exit)
    // and the trail is LATCHED; otherwise the per-kind geometry applies.
    const isRide = this.rideMode;
    const tp = isWick ? WICK_TAKE_PROFIT_BPS : DIP_TAKE_PROFIT_BPS;
    const trail = isRide ? RIDE_TRAIL_BPS : isWick ? WICK_TRAIL_BPS : DIP_TRAIL_BPS;
    const arm = isWick ? WICK_TRAIL_ARM_BPS : DIP_TRAIL_ARM_BPS;
    const sl = isRide ? RIDE_STOP_LOSS_BPS : isWick ? WICK_STOP_LOSS_BPS : DIP_STOP_LOSS_BPS;
    const maxHold = isRide ? RIDE_MAX_HOLD_BARS : isWick ? WICK_MAX_HOLD_BARS : DIP_MAX_HOLD_BARS;
    // Trailing stop is armed only while unrealised profit is above the
    // arm level (NOT latching: latching cuts the dip trade early) —
    // except in ride mode, where the lock already proved the arm.
    const trailArmed = isRide ? true : up >= arm;
    const tpHit = !isRide && up >= tp;
    const done =
      tpHit || down >= sl || (trailArmed && offPeak >= trail) || this.heldBars >= maxHold;
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
