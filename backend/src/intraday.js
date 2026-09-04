/**
 * Intraday analysis.
 *
 * Deterministic throughout: rolling statistics over the snapshot log, no model,
 * no LLM, no forecast. Every number is reproducible from the same observations
 * and the same reference instant.
 *
 * THE ONE RULE THIS MODULE EXISTS TO ENFORCE: session values never borrow from
 * another window.
 *
 * The app already computes a change since you last looked (a per-user horizon)
 * and a chart over 1D (a calendar horizon). Those are different questions with
 * different answers, and a session high that quietly came from the 1D window
 * would be a lie that looks exactly like a fact. So everything below is
 * recomputed from the session window alone, and anything the session cannot
 * support is reported `available: false` with a reason rather than filled in
 * from a neighbouring window.
 *
 * The two exceptions are labelled as such and nested under `engine`: attention
 * level, confidence and freshness are the engine's own values on the engine's
 * own horizon. They are shown because the brief asks for them, and they are
 * segregated so nobody reads them as session-scoped.
 *
 * NOTHING HERE IS FORWARD-LOOKING. The patterns are observations about what
 * has already happened. There is no BUY, SELL, HOLD, target price or
 * prediction, and a test asserts that vocabulary never appears.
 */
import { SESSION_LENGTH_MS, sessionWindow } from './freshness.js';
import { toBars } from './engine/returns.js';
import { isFinite_, mean, round, safeDiv, stdDev } from './engine/numeric.js';

const unavailable = (reason, extra = {}) => ({ available: false, reason, ...extra });

/**
 * Resolve the analysis window.
 *
 * In simulator mode there is no exchange session to bound - the synthetic
 * market runs around the clock, which is the entire reason it exists. Inventing
 * an open and a close for it would fabricate a boundary the data does not have,
 * so the window becomes a trailing stretch of the same LENGTH as a real
 * session, and it says plainly that it is not one.
 */
export function resolveWindow({ sourceInfo, now }) {
  if (sourceInfo?.alwaysOpen) {
    return {
      kind: 'recent',
      isSession: false,
      from: now - SESSION_LENGTH_MS,
      to: now,
      lengthMs: SESSION_LENGTH_MS,
      label: 'Last 6h 15m (recent window)',
      note:
        'The simulated market has no exchange session - it runs continuously, which is why it can be demoed while NSE is shut. This is a trailing window of the same length as an NSE session, not a session.',
    };
  }

  const session = sessionWindow(now);

  return {
    kind: 'session',
    isSession: true,
    from: session.from,
    to: session.to,
    lengthMs: session.to - session.from,
    sessionOpen: session.sessionOpen,
    sessionClose: session.sessionClose,
    isOpen: session.isOpen,
    complete: session.complete,
    label: session.isOpen
      ? 'Today’s session so far (09:15 IST → now)'
      : 'Last completed session (09:15 → 15:30 IST)',
    note: session.isOpen
      ? 'The session is still open, so this covers the part of it that has happened.'
      : 'NSE is closed; this is the most recent completed session.',
  };
}

/** Bar-to-bar returns within a set of resampled bars. */
function barReturns(bars) {
  const out = [];
  for (let i = 1; i < bars.length; i += 1) {
    const a = bars[i - 1];
    const b = bars[i];
    if (!a || !b || a.price <= 0) continue;
    const r = b.price / a.price - 1;
    if (isFinite_(r)) out.push(r);
  }
  return out;
}

/** The plain return across a window's own bars. Null when it cannot be formed. */
function windowReturn(bars) {
  const present = bars.filter(Boolean);
  if (present.length < 2) return null;
  const first = present[0];
  const last = present[present.length - 1];
  return first.price > 0 ? last.price / first.price - 1 : null;
}

export function buildIntraday({
  snapshotLog,
  symbol,
  watchedSymbols = [],
  engineItem = null,
  sourceInfo,
  params,
  now = Date.now(),
}) {
  const window = resolveWindow({ sourceInfo, now });
  /**
   * Defaulted here rather than trusting the caller. A missing trim share made
   * `Math.floor(n * (1 - undefined))` NaN, which propagated into the volatility
   * figures - and this codebase's standing rule is that no non-finite number
   * ever leaves a computation, whoever forgot to pass what.
   */
  const {
    barMs,
    carryForwardBars,
    minBars,
    sectorMap,
    sectorMinPeers,
    benchmarkSymbol,
    volatilityTrimShare = 0.1,
    minStdDev = 0.0004,
  } = params;

  const sector = sectorMap?.[symbol] ?? null;
  const peers = (watchedSymbols ?? []).filter(
    (peer) => peer !== symbol && sectorMap?.[peer] === sector && sector,
  );

  /**
   * One batched query for the symbol, the benchmark and the sector peers -
   * plus the baseline stretch BEFORE the window, which the volume comparison
   * needs. Same batching discipline as the engine.
   */
  const baselineFrom = window.from - params.baselineWindowMs;
  const histories = snapshotLog.historyForSymbols([symbol, benchmarkSymbol, ...peers], {
    from: baselineFrom,
    to: window.to,
  });

  const barsIn = (from, to, series) =>
    toBars(series ?? [], { from, to, barMs, carryForwardBars });

  const series = histories.get(symbol) ?? [];
  const bars = barsIn(window.from, window.to, series);
  const present = bars.filter(Boolean);

  const enoughData = present.length >= minBars;
  const notEnough = () =>
    unavailable('insufficient_data', { barsObserved: present.length, barsRequired: minBars });

  // ------------------------------------------------------------ the basics

  const latest = snapshotLog.latest(symbol);

  const currentPrice = latest
    ? {
        available: true,
        price: latest.price,
        timestamp: latest.timestamp,
        source: latest.source,
        /**
         * Whether the newest observation falls inside the analysed window. A
         * closed market often leaves the last print inside the session, but an
         * after-hours or stale observation can sit outside it - and a "session
         * high" must not be compared against a price the session never saw.
         */
        inWindow: latest.timestamp >= window.from && latest.timestamp <= window.to,
      }
    : unavailable('no_observations');

  let high = notEnough();
  let low = notEnough();
  let ret = notEnough();
  let volatility = notEnough();

  if (enoughData) {
    let hi = present[0];
    let lo = present[0];
    for (const bar of present) {
      if (bar.price > hi.price) hi = bar;
      if (bar.price < lo.price) lo = bar;
    }

    high = { available: true, price: hi.price, timestamp: hi.t };
    low = { available: true, price: lo.price, timestamp: lo.t };

    const r = windowReturn(bars);
    ret =
      r === null
        ? unavailable('insufficient_data')
        : {
            available: true,
            percent: round(r * 100, 3),
            fromPrice: present[0].price,
            toPrice: present[present.length - 1].price,
            fromTimestamp: present[0].t,
            toTimestamp: present[present.length - 1].t,
          };

    const returns = barReturns(bars);
    const sd = stdDev(returns);

    if (sd === null) {
      volatility = unavailable('insufficient_data', { samples: returns.length });
    } else {
      /**
       * A ROBUST scale for judging "unusually large", separate from the plain
       * realised volatility reported to the user.
       *
       * The naive comparison - window return against sd * sqrt(n) - cannot
       * work: a move delivered in one jump IS sd * sqrt(n) by construction, so
       * it scores exactly 1 sigma however violent it was. The outlier inflates
       * the very yardstick it is measured against.
       *
       * Trimming the largest few absolute returns before estimating the scale
       * fixes it. A lone 3% step against an otherwise flat tape leaves a
       * near-zero trimmed scale and registers as enormous; the same step in a
       * genuinely choppy session leaves a healthy one and registers as
       * ordinary. Which is the discrimination the pattern is for.
       */
      const trimmed = [...returns]
        .sort((a, b) => Math.abs(a) - Math.abs(b))
        .slice(0, Math.max(2, Math.floor(returns.length * (1 - volatilityTrimShare))));
      const robust = Math.max(stdDev(trimmed) ?? 0, minStdDev);

      /**
       * The same statistic over the stretch immediately BEFORE this window, so
       * "volatility increased" can be a comparison rather than an assertion.
       * Its own window is named in the payload; it is not borrowed from the 1D
       * chart or the user's horizon.
       */
      const priorBars = barsIn(baselineFrom, window.from, series);
      const priorReturns = barReturns(priorBars);
      const priorSd = priorReturns.length >= minBars ? stdDev(priorReturns) : null;

      const increase =
        priorSd !== null && priorSd > 0 ? safeDiv(sd, priorSd) : null;

      volatility = {
        available: true,
        /** Realised volatility: standard deviation of bar returns, as a percentage. */
        perBarPct: round(sd * 100, 4),
        /**
         * The robust scale, and the window-length figure derived from it. This
         * is what the "unusually large movement" pattern compares the window
         * return against - never `perBarPct`, for the reason given above.
         * Reported separately so the two are never confused for each other.
         */
        robustPerBarPct: round(robust * 100, 4),
        typicalWindowPct: round(robust * Math.sqrt(returns.length) * 100, 3),
        barMs,
        samples: returns.length,
        priorPerBarPct: priorSd === null ? null : round(priorSd * 100, 4),
        priorFrom: baselineFrom,
        priorTo: window.from,
        increaseRatio: increase === null ? null : round(increase, 2),
      };
    }
  }

  // ------------------------------------------------------- volume vs normal

  let volume = notEnough();

  if (enoughData) {
    const windowVolumes = present.map((bar) => bar.volume).filter(isFinite_);
    const baselineBars = barsIn(baselineFrom, window.from, series).filter(Boolean);
    const baselineVolumes = baselineBars.map((bar) => bar.volume).filter(isFinite_);

    const windowAvg = mean(windowVolumes);
    const baselineAvg = mean(baselineVolumes);

    if (windowVolumes.every((v) => v === 0) && windowAvg === 0) {
      volume = unavailable('volume_not_reported');
    } else if (baselineVolumes.length < minBars) {
      volume = unavailable('no_baseline_history', { baselineBars: baselineVolumes.length });
    } else if (baselineAvg === null || baselineAvg <= 0) {
      volume = unavailable('no_baseline_volume');
    } else {
      const ratio = safeDiv(windowAvg, baselineAvg);
      volume =
        ratio === null
          ? unavailable('no_baseline_volume')
          : {
              available: true,
              ratio: round(ratio, 2),
              windowAvgPerBar: round(windowAvg, 0),
              baselineAvgPerBar: round(baselineAvg, 0),
              /**
               * "Normal" is the stretch immediately BEFORE this window, and it
               * is named here so the comparison is never mistaken for one
               * against the 1D chart or the user's own horizon.
               */
              baselineFrom,
              baselineTo: window.from,
              baselineBars: baselineVolumes.length,
            };
    }
  }

  // --------------------------------------------- relative to market / sector

  const symbolReturn = enoughData ? windowReturn(bars) : null;

  let vsMarket = notEnough();
  if (enoughData && symbolReturn !== null) {
    const benchmarkBars = barsIn(window.from, window.to, histories.get(benchmarkSymbol));
    const benchmarkReturn = windowReturn(benchmarkBars);

    vsMarket =
      benchmarkReturn === null
        ? unavailable('benchmark_no_data_for_window', { benchmarkSymbol })
        : {
            available: true,
            benchmarkSymbol,
            excessPct: round((symbolReturn - benchmarkReturn) * 100, 3),
            symbolReturnPct: round(symbolReturn * 100, 3),
            benchmarkReturnPct: round(benchmarkReturn * 100, 3),
          };
  }

  let vsSector = notEnough();
  if (!sector) {
    vsSector = unavailable('no_sector_mapping');
  } else if (enoughData && symbolReturn !== null) {
    const peerReturns = [];
    for (const peer of peers) {
      const r = windowReturn(barsIn(window.from, window.to, histories.get(peer)));
      if (r !== null) peerReturns.push({ peer, r });
    }

    if (peerReturns.length < sectorMinPeers) {
      vsSector = unavailable('insufficient_peers', {
        sector,
        peersWithData: peerReturns.length,
        peersRequired: sectorMinPeers,
      });
    } else {
      const peerMean = mean(peerReturns.map((p) => p.r));
      vsSector = {
        available: true,
        sector,
        excessPct: round((symbolReturn - peerMean) * 100, 3),
        symbolReturnPct: round(symbolReturn * 100, 3),
        sectorReturnPct: round(peerMean * 100, 3),
        peers: peerReturns.map((p) => p.peer),
      };
    }
  }

  const metrics = { currentPrice, high, low, return: ret, volatility, volume, vsMarket, vsSector };

  return {
    symbol,
    generatedAt: now,
    window,
    barMs,
    barsObserved: present.length,
    barsRequired: minBars,
    gaps: bars.length - present.length,

    metrics,

    /**
     * The engine's values, deliberately nested and labelled.
     *
     * These are NOT session figures - they are computed on the engine's own
     * anomaly horizon over its own stats window. Presenting them flat
     * alongside the session metrics would invite exactly the cross-window
     * confusion this module is built to prevent.
     */
    engine: engineItem
      ? {
          note: 'Computed on the engine horizon, not the session window.',
          attentionLevel: engineItem.level,
          needsAttention: engineItem.needsAttention,
          meaningfulScore: engineItem.meaningfulScore,
          confidence: engineItem.confidence,
          anomalyHorizonMs: engineItem.features?.priceAnomaly?.horizonMs ?? null,
          freshness: {
            state: engineItem.freshness.state,
            label: engineItem.freshness.label,
            ageMs: engineItem.freshness.ageMs,
            isStale: engineItem.freshness.isStale,
          },
          dataQuality: engineItem.dataQuality,
        }
      : null,

    patterns: detectPatterns({ metrics, window, params, present }),
  };
}

/** Stable machine codes for the observed patterns. */
export const PatternCode = {
  VOLUME_SPIKE: 'unusual_volume_spike',
  LARGE_MOVEMENT: 'unusually_large_movement',
  SUSTAINED_MOVEMENT: 'sustained_movement',
  SUDDEN_REVERSAL: 'sudden_reversal',
  VOLATILITY_INCREASE: 'volatility_increase',
  DIVERGENCE_FROM_MARKET: 'divergence_from_market',
  DIVERGENCE_FROM_SECTOR: 'divergence_from_sector',
  NEAR_WINDOW_HIGH: 'near_window_high',
  NEAR_WINDOW_LOW: 'near_window_low',
};

/**
 * Observed patterns, each emitted only where the data actually supports it.
 *
 * Every one is a statement about what has already happened, phrased in the past
 * tense, carrying the evidence that produced it. None is a forecast, an
 * instruction, or a judgement about what the price will do next - see the
 * module header.
 */
export function detectPatterns({ metrics, window, params, present }) {
  const patterns = [];
  const add = (code, text, evidence) => patterns.push({ code, text, evidence });

  const { high, low, return: ret, volatility, volume, vsMarket, vsSector, currentPrice } = metrics;

  if (volume.available && volume.ratio >= params.patternVolumeRatio) {
    add(
      PatternCode.VOLUME_SPIKE,
      `Traded at ${volume.ratio.toFixed(1)}x its normal volume for a window this long`,
      { ratio: volume.ratio, baselineAvgPerBar: volume.baselineAvgPerBar },
    );
  }

  /**
   * "Large" is measured against this window's OWN realised volatility, not a
   * fixed percentage. A 1% move is unremarkable for a volatile name and a large
   * one for a placid one, and a fixed threshold would report the wrong answer
   * for both.
   */
  if (ret.available && volatility.available && volatility.typicalWindowPct > 0) {
    const sigmas = Math.abs(ret.percent) / volatility.typicalWindowPct;
    if (sigmas >= params.patternLargeMoveSigma) {
      add(
        PatternCode.LARGE_MOVEMENT,
        `Moved ${ret.percent > 0 ? 'up' : 'down'} ${Math.abs(ret.percent).toFixed(
          2,
        )}%, about ${sigmas.toFixed(1)}x this window's own volatility`,
        {
          returnPct: ret.percent,
          typicalWindowPct: volatility.typicalWindowPct,
          sigmas: round(sigmas, 2),
        },
      );
    }
  }

  /**
   * Sustained versus choppy: what share of the bar-to-bar moves went the same
   * way as the window overall. A move that arrived in one jump and a move that
   * ground out over hours look identical in the return alone.
   */
  if (ret.available && present.length >= 4) {
    const direction = Math.sign(ret.percent);
    const steps = barReturns(present);
    const agreeing = steps.filter((r) => Math.sign(r) === direction && r !== 0).length;
    const share = safeDiv(agreeing, steps.length);

    if (direction !== 0 && share !== null && share >= params.patternSustainedShare) {
      add(
        PatternCode.SUSTAINED_MOVEMENT,
        `Movement was sustained rather than a single jump — ${Math.round(
          share * 100,
        )}% of intervals moved the same way`,
        { agreeingShare: round(share, 3), intervals: steps.length },
      );
    }
  }

  /**
   * A reversal: the window travelled a long way in one direction and then gave
   * a large share of it back. Detected from the extremes and their order, so it
   * needs no forecast to state.
   */
  if (high.available && low.available && present.length >= 4) {
    const last = present[present.length - 1];
    const wentUpFirst = high.timestamp < low.timestamp;
    const swing = high.price - low.price;

    if (swing > 0) {
      const retraced = wentUpFirst
        ? safeDiv(last.price - low.price, swing)
        : safeDiv(high.price - last.price, swing);

      const travelled = safeDiv(swing, wentUpFirst ? high.price : low.price);

      if (
        retraced !== null &&
        travelled !== null &&
        travelled * 100 >= params.patternReversalMinSwingPct &&
        retraced <= 1 - params.patternReversalRetrace
      ) {
        add(
          PatternCode.SUDDEN_REVERSAL,
          wentUpFirst
            ? `Reached ${high.price} then gave back most of the move`
            : `Fell to ${low.price} then recovered most of the move`,
          {
            swingPct: round(travelled * 100, 2),
            heldShare: round(retraced, 3),
            highAt: high.timestamp,
            lowAt: low.timestamp,
          },
        );
      }
    }
  }

  /**
   * Volatility increase, stated only when there is a prior stretch to compare
   * against. Without one this would be an assertion dressed as a measurement.
   */
  if (
    volatility.available &&
    volatility.increaseRatio != null &&
    volatility.increaseRatio >= params.patternVolatilityIncrease
  ) {
    add(
      PatternCode.VOLATILITY_INCREASE,
      `Price swings were ${volatility.increaseRatio.toFixed(
        1,
      )}x wider than in the preceding stretch`,
      {
        perBarPct: volatility.perBarPct,
        priorPerBarPct: volatility.priorPerBarPct,
        ratio: volatility.increaseRatio,
      },
    );
  }

  if (vsMarket.available && Math.abs(vsMarket.excessPct) >= params.patternDivergencePct) {
    add(
      PatternCode.DIVERGENCE_FROM_MARKET,
      `Diverged from ${vsMarket.benchmarkSymbol} by ${vsMarket.excessPct.toFixed(
        2,
      )}% over this window`,
      { excessPct: vsMarket.excessPct, benchmarkReturnPct: vsMarket.benchmarkReturnPct },
    );
  }

  if (vsSector.available && Math.abs(vsSector.excessPct) >= params.patternDivergencePct) {
    add(
      PatternCode.DIVERGENCE_FROM_SECTOR,
      `Diverged from ${vsSector.sector} peers by ${vsSector.excessPct.toFixed(2)}%`,
      { excessPct: vsSector.excessPct, peers: vsSector.peers },
    );
  }

  /**
   * Sitting near an extreme. Only stated when the extreme is a real one - a
   * window whose high and low are the same number puts the price "near" both,
   * which is true and useless.
   */
  if (currentPrice.available && high.available && low.available && high.price > low.price) {
    const span = high.price - low.price;
    const fromHigh = safeDiv(high.price - currentPrice.price, span);
    const fromLow = safeDiv(currentPrice.price - low.price, span);

    if (fromHigh !== null && fromHigh <= params.patternNearExtremeShare) {
      add(
        PatternCode.NEAR_WINDOW_HIGH,
        `Currently near the ${window.isSession ? 'session' : 'window'} high of ${high.price}`,
        { high: high.price, current: currentPrice.price, distanceShare: round(fromHigh, 3) },
      );
    } else if (fromLow !== null && fromLow <= params.patternNearExtremeShare) {
      add(
        PatternCode.NEAR_WINDOW_LOW,
        `Currently near the ${window.isSession ? 'session' : 'window'} low of ${low.price}`,
        { low: low.price, current: currentPrice.price, distanceShare: round(fromLow, 3) },
      );
    }
  }

  return patterns;
}
