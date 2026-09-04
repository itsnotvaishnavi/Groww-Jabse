/**
 * Deterministic explanations.
 *
 * WHY NO LLM
 * Explanations are templates over computed feature values. That is a decision,
 * not a limitation. A language model in this path would make the demo require
 * network access, add latency to every row, make identical inputs produce
 * different output (destroying the determinism guarantee the whole engine is
 * built on), and - worst - it could produce a fluent, plausible reason that the
 * data does not support. The README records the tradeoff and the grounding
 * constraints a phrasing layer would have to satisfy before it could be let
 * near this.
 *
 * THE EVIDENCE RULE
 * A reason may only state what the system measured. "Price moved +2.1% while
 * the market moved +0.4%" is a report of two numbers we hold. "Rose on positive
 * earnings sentiment" is a causal claim about the world that this system has no
 * instrument for, and is therefore forbidden regardless of how likely it is.
 *
 * NO INVESTMENT ADVICE
 * The vocabulary is descriptive throughout: "deserves attention", never "buy",
 * "sell", "will rise", or a target price. Nothing here is personalised to a
 * financial position, because the app does not know one and must not imply it.
 */

/** Stable machine codes; the API returns these, the UI renders the text. */
export const ReasonCode = {
  CHANGE_SINCE_VIEWED: 'change_since_viewed',
  UNUSUAL_PRICE_MOVEMENT: 'unusual_price_movement',
  HIGH_VOLUME: 'high_volume',
  MARKET_OUTPERFORMANCE: 'market_outperformance',
  MARKET_UNDERPERFORMANCE: 'market_underperformance',
  MOVED_WITH_MARKET: 'moved_with_market',
  SECTOR_OUTPERFORMANCE: 'sector_outperformance',
  SECTOR_UNDERPERFORMANCE: 'sector_underperformance',
  LOW_CONFIDENCE: 'low_confidence',
  INSUFFICIENT_DATA: 'insufficient_data',
};

const signed = (n, digits = 1) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

/** Minutes, for phrasing a horizon in words a person uses. */
function horizonWords(ms) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'hour' : `${hours} hours`;
}

/**
 * Build the reason list for one result, ordered by how much each signal
 * actually contributed to the score - so the first line a user reads is the
 * biggest part of the answer rather than whichever feature happened to be
 * declared first.
 */
export function buildReasons({ features, scoreResult, confidence, engine }) {
  const reasons = [];

  const push = (code, text, weight) => reasons.push({ code, text, weight });

  // Contribution of a named signal to the score, for ordering.
  const contributionOf = (name) => scoreResult.breakdown[name]?.weighted ?? 0;

  /**
   * Change since last viewed leads when present. It is not one of the four
   * scored signals - it is the user's own frame of reference, and it is the
   * thing they came back to find out.
   */
  const change = features.changeSinceViewed;
  if (change.available && Math.abs(change.percent) > 0) {
    push(
      ReasonCode.CHANGE_SINCE_VIEWED,
      `${signed(change.percent)} since you last checked`,
      Number.POSITIVE_INFINITY,
    );
  }

  const price = features.priceAnomaly;
  const priceMagnitude = price.available ? Math.abs(price.z) : 0;
  if (price.available && priceMagnitude >= engine.reasonMinZ) {
    const wording =
      priceMagnitude >= engine.zFullContribution
        ? 'Movement is far outside this stock’s normal range'
        : 'Movement is unusually large for this stock';
    push(
      ReasonCode.UNUSUAL_PRICE_MOVEMENT,
      `${wording} (${priceMagnitude.toFixed(1)}σ over ${horizonWords(price.horizonMs)})`,
      contributionOf('priceAnomaly'),
    );
  }

  const volume = features.volumeAnomaly;
  if (volume.available && volume.ratio >= engine.reasonMinVolumeRatio) {
    push(
      ReasonCode.HIGH_VOLUME,
      `Volume is ${volume.ratio.toFixed(1)}x its normal level`,
      contributionOf('volumeAnomaly'),
    );
  }

  const market = features.marketRelative;
  if (market.available) {
    const excess = market.excessPct;
    const contribution = contributionOf('marketRelative');
    const material = Math.abs(excess) >= engine.reasonMinRelativePct;

    if (material && excess > 0) {
      push(
        ReasonCode.MARKET_OUTPERFORMANCE,
        `Outperformed the market by ${excess.toFixed(1)}%`,
        contribution,
      );
    } else if (material && excess < 0) {
      push(
        ReasonCode.MARKET_UNDERPERFORMANCE,
        `Underperformed the market by ${Math.abs(excess).toFixed(1)}%`,
        contribution,
      );
    } else if (Math.abs(market.symbolReturnPct) >= engine.reasonInlineWithMarketPct) {
      /**
       * The deliberately deflationary reason, and one of the most useful things
       * the engine can say: the stock DID move, but so did the whole market, so
       * this was not about the stock.
       *
       * Gated on the stock having actually moved. Without that gate it would
       * also fire when nothing happened at all - "moved broadly in line with
       * the market (+0.0% vs +0.0%)" - which is noise dressed as insight.
       */
      push(
        ReasonCode.MOVED_WITH_MARKET,
        `Moved broadly in line with the market (${signed(market.symbolReturnPct)} vs ${signed(
          market.benchmarkReturnPct,
        )})`,
        -1,
      );
    }
  }

  const sector = features.sectorRelative;
  if (sector.available && Math.abs(sector.excessPct) >= engine.reasonMinRelativePct) {
    const excess = sector.excessPct;
    push(
      excess > 0 ? ReasonCode.SECTOR_OUTPERFORMANCE : ReasonCode.SECTOR_UNDERPERFORMANCE,
      `${excess > 0 ? 'Ahead of' : 'Behind'} ${sector.sector} peers by ${Math.abs(
        excess,
      ).toFixed(1)}%`,
      contributionOf('sectorRelative'),
    );
  }

  /**
   * Nothing was measurable at all - a brand-new symbol, or one whose feed has
   * barely spoken. This is a different statement from "we measured and are not
   * confident", and it gets its own wording: "treat with caution" on a row with
   * no signal implies there is something to be cautious ABOUT, when in fact
   * there is simply nothing there yet.
   */
  if (scoreResult.availableWeight === 0) {
    push(
      ReasonCode.INSUFFICIENT_DATA,
      'Not enough observations yet to assess this',
      Number.NEGATIVE_INFINITY,
    );
  } else if (confidence < 0.5) {
    /**
     * A caveat, not a signal. If the score rests on thin or stale data the user
     * is told, because a confident-looking row built on twenty samples of a
     * delayed feed is the kind of thing that erodes trust once noticed.
     */
    push(
      ReasonCode.LOW_CONFIDENCE,
      'Based on limited or delayed data — treat with caution',
      Number.NEGATIVE_INFINITY,
    );
  }

  // Ties broken by code so ordering is total and therefore reproducible.
  reasons.sort((a, b) => b.weight - a.weight || a.code.localeCompare(b.code));

  return reasons.map(({ code, text }) => ({ code, text }));
}
