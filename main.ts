// btc-race-24h-20261118-1444 V3: V2 core (untouched) + a strictly-gated
// Bullish Regime Module. V1 (submission 01a1ef56, grade-local +$9.337934,
// server dev_profitable PASS) is the safe fallback. V2 (commit 88e7ee9,
// grade-local +$12.173642) is the fallback candidate. This V3 does NOT
// clear Fura's promotion gate (see the header note at the end), so it
// must NOT be submitted on this evidence.
//
// The module was added exactly as specified and tournament-tested in
// ~/workspace/makefun/btc-race-v2/v3_tournament.py (local float
// simulator, exact fill model, validated against grade-local on V1 to
// +$9.3383 vs +$9.337934): it arms ONLY when close > SMA240 AND
// SMA60 > SMA240 AND the 120-bar close slope > +80 bps, AND no dip
// trade has ever fired (or >360 bars since the last exit), and enters
// ONLY on a new 60-bar high (confirmed higher-low / momentum
// continuation breakout). It NEVER fires on the dev window (verified:
// V3 grade-local trade log is identical to V2's), so V2's +$12.17 dev
// behaviour is preserved exactly. On the mirrored (+281 bps) window
// every firing variant LOSES (-$6.79 to -$11.09) and the module also
// cuts sideways from +$12.85 to +$6.49 — see the limits note below.
//
// The harness speaks agent-fun/bars-replay/v1: one hello, then one batch
// per minute bar, then done. This bot answers every batch with exactly one
// reply echoing the batch seq, carrying zero or one order. A buy decided
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
//   median 0, max -613/+989 bps; bar-to-bar c_depth change max -680/+1080
//   bps — the pool barely moves, so a depth-shock signal carries almost
//   no information on this window and is not used as an entry trigger.
//   Hello caps: max_open_positions 1, max_orders_per_bar 16,
//   max_weight_bps 10000, fee_bps 4, slippage_bps 2,
//   min_notional $1 (1,000,000 quote units). An order whose price
//   (open x 1.0002 x M) exceeds latest close x (1 + max_slippage/10000)
//   is REJECTED; this bot uses max_slippage_bps 100 (1%).
//
// Sizing (depth-aware, derived from the linear impact above):
// net(a) ~= a*(move - 0.0012) - 2*a^2/D, maximised at
// a* = (move - 0.0012) * D / 4, where move is the expected fill-to-fill
// move as a fraction and D the latest c_depth in USDC. With the take
// profit as the expected-move proxy (TP 150 bps): a* = (0.015-0.0012)*D/4.
// On the dev window a* ranges $1,448-$2,304, always above the $1,000
// capital, so V2 buys full size on dev — the sizing rule is insurance
// for a thinner race pool (e.g. D = $200k gives a* = $690), not a dev
// lever. For moves below ~60 bps a* drops under $1,000, so small-move
// trades size down instead of paying full impact.
//
// Entry (unchanged from V1 — every alternative entry tested worse):
// full-size (or depth-sized) buy only when the close is far below a
// moving average AND has started to turn:
//   - dip >= 75 bps vs the 15-bar average, OR
//   - dip >= 100 bps vs the 60-bar average, OR
//   - dip >= 200 bps vs the 120-bar or 240-bar average,
//   AND the close is above the previous bar's low (rebound confirmation).
// Late-window guardrail: if no position has ever been held by bar 1200,
// the dip loosens to >= 50 bps vs the 60- or 30-bar average (insurance
// for a zero-trade finish; never fires on dev). Cooldown 10 bars after
// a sell. No new buys in the final 60 bars.
//
// Exits (changed from V1: TP 100 -> 150, trail 50 -> armed trailing,
// hold 60 -> 360). Whole position, first trigger wins:
//   - take-profit +150 bps above the entry close,
//   - trailing stop 60 bps below the peak close since entry, but ONLY
//     once unrealised profit has reached +70 bps (before that the trail
//     is off, so a normal 40-60 bps wobble cannot stop the trade out),
//   - hard stop-loss -65 bps,
//   - max hold 360 bars.
// V1's TP 100 / trail 50 / hold 60 cut the dev window's one clean bounce
// (+162 bps low-to-high) at +93 bps net. The wider exit lets the same
// trade run to +122 bps net in the local simulator. The gain is one
// trade's timing, not a new edge — see the limits note below.
//
// Bullish Regime Module (V3, strictly gated, non-interfering):
// arms ONLY when the macro trend is unmistakably bullish —
//   close > SMA240 AND SMA60 > SMA240 AND the 120-bar close slope
//   (close - close_120_bars_ago) / close > +80 bps —
// AND no dip trade has ever fired, or >360 bars have passed since the
// last exit. Enters ONLY on a confirmed breakout: a new 60-bar high
// (no overhead resistance in the last 60 bars, so the >120 bps upside
// requirement is the open trend itself, not a fitted level). The dip
// entry is checked first and always wins; the module can only fire
// where V2 would otherwise sit idle. Bull exits (no take-profit — the
// wide trail is the exit): trailing stop 80 bps below the peak, armed
// only after +90 bps unrealised profit, hard stop-loss -70 bps, max
// hold 480 bars. Sizing is the same depth-aware rule, with the 150 bps
// move proxy (full size on dev depths).
//
// What was tested and REJECTED (local float simulator, exact fill model,
// validated against grade-local on V1 to +$9.3383 vs +$9.337934):
//   - Mode 1 dynamic z-score/ATR dip-buy (threshold = max(45-70,
//     k*ATR60), k = 10-20, TP 100-250, trail 45-60, SL 55-65,
//     hold 120-360): best +$9.28 dev, walk-forward 2/6 positive,
//     mirrored -$17.04 — more trades, all in the losing direction.
//     ATR60 on dev is ~4-5 bps, so the ATR thresholds land at 45-70 bps
//     and admit the slow-drift dips that lose after the 36 bps cost.
//   - Mode 2 trend/pullback continuation (SMA30 > SMA120 with rising
//     slope, buy -35..-55 bps below SMA20, trail 80-120) and the
//     shallow-pullback "grind" variant (15-45 bps below SMA60/SMA20 in
//     an uptrend): every variant negative on dev (-$2.53..-$13.95) and
//     negative on the mirrored window (-$6.68..-$15.62). Shallow
//     pullbacks in this data are noise, not continuation.
//   - Two-bar micro-reversal confirmation instead of close > prev low:
//     -$8.46 dev.
//   - D-aware sizing: identical to full size on dev (a* > capital),
//     as derived above.
//   - End-of-window force-close (tested in V1): hurts, not used.
//
// V3 Bullish Module — what was tested (v3_tournament.py, same simulator
// and regime constructions as V2; all numbers LOCAL ESTIMATE except the
// grade-local dev row). Breakout variants at slope 80, exits trail 80
// armed @90 / SL 70 / hold 480, no TP:
//   B1 new 60-bar high:      dev +$12.17, WF 1/6, mirrored -$6.79, sideways +$6.49, 2x-fee +$10.96 (sim)
//   B1c tight consolidation: same trades as B1 on every window
//   B2 new 30-bar high + momentum: mirrored -$11.09, sideways +$6.49
//   B3 higher-low + new 20-bar high: mirrored -$6.79, sideways +$6.49
//   B4 pullback-then-break above SMA20: mirrored -$10.82, sideways +$12.85
//   Slope 120 / 150 bps: module never fires anywhere (mirrored $0.00)
//   SMA60-slope definition: never fires anywhere (max 77 bps < 80 on mirrored)
//   Exit variants (arm 70/120, trail 60/100, SL 55/90, hold 240, TP 250/350):
//     mirrored stays -$6.79..-$9.37, sideways $6.49..$12.55 — no geometry fixes it
//   Faster slope windows (30/60 bars, thr 50): module fires and LOSES
//     everywhere — mirrored -$11.78/-$6.69, dev falls to +$1.44/+$1.96
//     (a losing bull trade in segment 5), 2x-fee turns negative. Loosening
//     the gate destroys the core too.
// Mechanism (trade log, B1): mirrored buys bar 653 at $65,751 — the
// first bar the 120-bar slope confirms the trend — and holds 480 bars
// to a max-hold exit at $65,522, -$6.79. The mirrored "uptrend" is one
// +202 bps spike in 15 bars (bars 54-69) plus slow drift; the slope
// gate first exceeds 80 bps only at bar 627, ~560 bars after the move.
// After entry the max forward upside is +41 bps — below the ~36 bps
// round-trip cost plus any margin — so no exit geometry can save the
// trade. The SMA60 > SMA240 condition blocks the spike itself (the
// 15-bar spike barely moves SMA60). The module is structurally too
// slow for this window's shape: it buys the top of the post-spike
// drift and bleeds on the pullback. On sideways it adds a losing
// trade (buy 878, sell 1358) that cuts +$12.85 to +$6.49.
// PROMOTION GATE (V3): dev >= +$12.17 (PASS, identical trade log),
// mirrored > +$8.00 (FAIL, best firing variant -$6.79; $0.00 if it
// never fires), sideways > +$10.00 (FAIL for every firing variant),
// 2x-fee > +$10.00 (PASS on dev only because the module never fires
// there), WF >= 2/6 (FAIL, stays 1/6). RECOMMENDATION: KEEP V2.
// The live race risk the module was meant to fix — $0 on a bullish
// 24h window — is real, but this window's bullish shape (one spike
// plus drift) cannot be caught causally by any tested gated entry:
// the only profitable bullish entries would have to buy the spike
// itself, before any trend confirmation exists.
//
// Verified grade-local (Node 22, --driver process --worktree, kit dev
// window, two runs identical, L1 regrade reproduced byte for byte):
// net PnL +$12.173642, 2 trades (1 buy + 1 sell), win rate 1.0,
// max drawdown 1.4964%, fees $0.805032, net PnL at 2x fees +$11.364509,
// 0 rejected, action_log_sha256 c5a9cf6e0ef2bc661c0bf40663c1eea72a866d3b431aa6c945a7ab06ea3fa8a2.
// The action log is BYTE-IDENTICAL to V2's (same sha256): the bull
// module never fires on the dev window, so V3's dev behaviour is
// exactly V2's, trade for trade. Walk-forward 6x4h [0, +12.17, 0, 0, 0, 0]
// — 1/6 positive (local simulator, exit attributed to its segment).
// Mirrored/sideways numbers are LOCAL ESTIMATE from v3_tournament.py,
// not grade-local (the kit grades dev only): mirrored -$6.79 with the
// B1 module firing once, sideways +$6.49. The exit is in segment 2:
// the same single plunge trade as V1/V2, held longer (max hold 360,
// armed trailing) instead of TP 100 at bar ~85.
//
// WHY THE GATES FAIL — the window's arithmetic, not the tuning:
// A perfect-foresight dynamic program over the exact fill model (buy/sell
// at every bar, fills at next open, 4 bps fee + 2 bps slippage + linear
// impact, full size) caps the dev window at +$63.65. Allowing optimal
// partial sizing (25/50/75/100% of cash per trade, Pareto-frontier DP)
// raises the ceiling only to +$78.33. The window's gross up-swings
// (zigzag, 40 bps threshold) total 903 bps = $90.30 before any cost,
// and the largest single swing is 246 bps. Gate 1 ($95.00) is above
// the perfect-foresight ceiling: no bot — causal or clairvoyant — can
// clear it on this dev window. Gate 2 (5/6 walk-forward slices > $0,
// profitable mirrored AND sideways, 2x-fee > $45) fails too: the best
// candidate manages 1/6 positive slices, $0.00 on mirrored, $10.96 at
// 2x fees. Segment 6 of dev (bars 1200-1439) contains no up-swing at
// all (a -277 bps drift), so 6/6 was never available; 5/6 needs the
// 60-74 bps swings in segments 3 and 5, which no tested entry captures
// net of the 36 bps round-trip cost. DO NOT SUBMIT this V2.
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

// Exits, in bps unless noted (V2: wider, armed trailing, longer hold).
const TAKE_PROFIT_BPS = 150n;
const TRAIL_ARM_BPS = 70n; // trailing activates only above this profit
const TRAIL_BPS = 60n;
const STOP_LOSS_BPS = 65n;
const MAX_HOLD_BARS = 360;
const COOLDOWN_BARS = 10;

// Bullish Regime Module exits (V3): no take-profit — the wide trail
// is the exit. Trail 80 bps, armed only after +90 bps profit;
// hard stop-loss -70 bps; max hold 480 bars.
const BULL_TRAIL_ARM_BPS = 90n;
const BULL_TRAIL_BPS = 80n;
const BULL_STOP_LOSS_BPS = 70n;
const BULL_MAX_HOLD_BARS = 480;
// Bull arming: 120-bar close slope must exceed this (bps).
const BULL_SLOPE_BPS = 80n;
// Bull idle gate: bars since the last exit before the module may fire.
const BULL_IDLE_BARS = 360;

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
  private lastDepth: bigint | null = null;
  private seenBars = 0;
  private everHeld = false;
  private pendingEntry: bigint | null = null;
  private entryClose: bigint | null = null;
  private peakClose: bigint | null = null;
  private heldBars = 0;
  private cooldownLeft = 0;
  // Bullish module state: last 121 closes (for the 120-bar slope and
  // the 60-bar-high breakout), the mode of the open position, and the
  // bar on which the last sell was decided.
  private closes: bigint[] = [];
  private mode: 'dip' | 'bull' | null = null;
  private lastExitBar = -1_000_000;

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
    // Keep the last 121 closes for the bull module's 120-bar slope
    // (close vs the close 120 bars ago) and 60-bar-high breakout.
    this.closes.push(close);
    if (this.closes.length > 121) this.closes.shift();
    // Latest close depth (USDC raw units, 1e6 per USDC): the depth to
    // size the next order against — the next open's depth is unknown.
    if (bar.c_depth.length > 0) this.lastDepth = BigInt(bar.c_depth[0]);

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

  /** Whole-position exits, first trigger wins. Exit geometry depends
   * on the mode of the open position: V2 dip exits, or the bull
   * module's wide armed trail (no take-profit — the trail is the exit). */
  private exitOrders(qty: bigint, close: bigint): OrderInput[] {
    this.heldBars += 1;
    if (this.peakClose !== null && close > this.peakClose) this.peakClose = close;
    const entry = this.entryClose!;
    const peak = this.peakClose!;
    const up = ((close - entry) * BPS) / entry;
    const down = ((entry - close) * BPS) / entry;
    const offPeak = ((peak - close) * BPS) / peak;
    const bull = this.mode === 'bull';
    // Bull: trail 80 armed only after +90 bps unrealised profit.
    // Dip: V2 trail 60 armed only after +70 bps unrealised profit.
    const trailArm = bull ? BULL_TRAIL_ARM_BPS : TRAIL_ARM_BPS;
    const trail = bull ? BULL_TRAIL_BPS : TRAIL_BPS;
    const stopLoss = bull ? BULL_STOP_LOSS_BPS : STOP_LOSS_BPS;
    const maxHold = bull ? BULL_MAX_HOLD_BARS : MAX_HOLD_BARS;
    const trailArmed = up >= trailArm;
    const done =
      (!bull && up >= TAKE_PROFIT_BPS) ||
      down >= stopLoss ||
      (trailArmed && offPeak >= trail) ||
      this.heldBars >= maxHold;
    if (!done) return [];
    this.cooldownLeft = COOLDOWN_BARS;
    this.lastExitBar = this.seenBars;
    this.mode = null;
    return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  /** Depth-aware size: a* = (TP - 60 bps) * D / 4, capped at cash. */
  private sizedNotional(cash: bigint): bigint {
    if (this.lastDepth === null) return cash;
    // D in USDC = c_depth raw / 1e6; a* in USDC = (TP-60)/10000 * D / 4.
    // In raw quote units (1e6 per USDC): a* = (TP-60) * c_depth / 40000.
    const numerator = (TAKE_PROFIT_BPS - 60n) * this.lastDepth;
    const optimal = numerator / 40_000n;
    const sized = optimal < cash ? optimal : cash;
    return sized < MIN_BUY_QUOTE ? 0n : sized;
  }

  /** Buy when a deep dip has started to turn (V1 entry, unchanged). */
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
    // The dip entry is checked first and always wins; the bull module
    // can only fire where V2 would otherwise sit idle.
    let bull = false;
    if (!dipped && !guardrail) {
      bull = this.bullEntry(close);
      if (!bull) return [];
    }

    const notional = this.sizedNotional(state.cash);
    if (notional < MIN_BUY_QUOTE) return [];
    this.pendingEntry = close;
    this.mode = bull ? 'bull' : 'dip';
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  /** Bullish Regime Module: arms ONLY on an unmistakable macro
   * uptrend — close > SMA240 AND SMA60 > SMA240 AND the 120-bar
   * close slope > +80 bps — AND only when no dip trade has ever
   * fired, or >360 bars have passed since the last exit. Enters
   * ONLY on a confirmed breakout: a new 60-bar high, so there is no
   * overhead resistance in the last 60 bars and the >120 bps upside
   * requirement is the open trend itself. Returns false on a
   * downtrend or chop, where V2's behaviour must stay untouched. */
  private bullEntry(close: bigint): boolean {
    if (this.closes.length < 121) return false; // need 120 bars of slope
    if (!this.longerMean.ready || !this.midMean.ready) return false;
    if (close <= this.longerMean.mean) return false; // below SMA240
    if (this.midMean.mean <= this.longerMean.mean) return false; // SMA60 <= SMA240
    const close120Ago = this.closes[this.closes.length - 121];
    const slope = ((close - close120Ago) * BPS) / close;
    if (slope <= BULL_SLOPE_BPS) return false;
    // Idle gate: only when V2 would otherwise stay completely idle.
    if (this.everHeld && this.seenBars - this.lastExitBar <= BULL_IDLE_BARS) return false;
    // Breakout confirmation: a new 60-bar high.
    let high = 0n;
    for (let k = this.closes.length - 60; k < this.closes.length; k++) {
      if (this.closes[k] > high) high = this.closes[k];
    }
    return close >= high;
  }
}

const trader = new DipTrader();

await runBars({
  onBatch(state, batch) {
    return trader.onBatch(state, batch);
  },
});
