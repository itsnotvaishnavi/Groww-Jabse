# Jabse

**जब से** — *jab se*, Hindi for "since when".

A watchlist that answers **"what has meaningfully changed *since I last looked*"**
rather than "what moved today".

Built for Groww "Code" — solo build, Sep 4–7 2026.

---

## The idea

The name is the whole thesis. Every watchlist app shows the same thing: today's
percentage change. But "today" is an arbitrary window that has nothing to do
with you. If you last checked on Tuesday, a flat Friday tells you nothing about
the 4% round trip you missed.

*Jab se* — since when? Since **you** last looked.

And "moved a lot" is not the same as "matters". A 0.4% move is unremarkable for
ZOMATO and remarkable for HDFCBANK. A 2% rise when the whole market rose 2% is
not news about your stock. A 1% move on four times the usual volume often
matters more than a 3% move on a quiet tape. **Defining "meaningful", making it
testable, and making it explainable is what this project is.**

## Run it

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # 151 tests, no network / clock / filesystem
npm run demo              # build the demo scenario and print it
```

Requires Node 22+ (developed on 24). No API keys, no configuration, no
migration step.

```bash
DATA_SOURCE=yahoo npm start                          # real NSE/BSE prices
curl 'localhost:3000/api/summary?awayMs=180000000'   # simulate a 50h absence
```

---

## What "meaningful change" means here

Four signals, each measured independently, each able to say "I could not
measure this". Weights are config, not constants.

| Signal | Weight | The question it answers |
|---|---|---|
| **Price anomaly** | 0.35 | Is this move unusual *for this stock*? |
| **Volume anomaly** | 0.25 | Is the tape busier than normal? |
| **Market-relative** | 0.20 | Did it move more than the market? |
| **Sector-relative** | 0.20 | Did it move more than its peers? |

Plus **change since you last looked**, which is not one of the scored signals —
it is the user's own frame of reference and the thing they came back to find out.

```
score = Σ(weight × contribution) / Σ(weight of available signals)
```

### Renormalisation is the important part

If the sector signal is unavailable, the weighted sum is divided by **0.80**,
not 1.00. Dividing by 1.00 would treat "we could not measure the sector" as
"the sector said nothing was happening" — silently capping every unsectored
stock at 80% of the score it earns. There is a test that recomputes the score
from the published breakdown and a test asserting each missing signal removes
exactly its own weight.

**Missing is never zero.** Absent volume is *unavailable*, not a collapse in
trading activity. A never-viewed symbol has *no baseline*, not a 0% change. Each
feature carries `available`, a machine-readable `reason`, and its own
`confidence`.

### Levels

| Score | Level |
|---|---|
| 0.00–0.39 | `LOW` |
| 0.40–0.69 | `MODERATE` |
| 0.70–1.00 | `HIGH` |

**Absolute, not percentile within your watchlist.** Under percentile ranking a
stock's level would change because you added an unrelated stock — the label
would describe the watchlist rather than the instrument, and the
already-surfaced fingerprint would churn every time the list did. Tested.

### Relative signals scale; they do not saturate

The market- and sector-relative contributions use `m / (m + k)` rather than a
clamp. A clamped mapping gave **1.0** to any excess past its reference, so a
−2% excess and a −20% excess contributed identically — and those are not the
same event. The curve is strictly increasing over the whole range and only
approaches 1 asymptotically, so bigger is always bigger. `k` is the
half-contribution point, which makes it a meaningful thing to configure.

### The level floor: your stock outranks the index

Relative signals **alone** cannot carry a symbol above `LOW`. If a stock's own
move is unremarkable, its turnover is normal, *and* you have seen nothing change
since your last visit, then whatever the index did, nothing much happened to
**your** stock — and calling that attention-worthy would be the engine
mistaking context for news.

Turnover is part of that test deliberately. Gating only on the price z-score and
the change would have suppressed the volume-spike case — a 0.4% move on three
times normal volume — which is the most valuable thing this engine finds and the
one a percentage-change watchlist always misses. Volume is a fact about *this*
stock, not about the index.

The score is **not** rewritten when the floor applies: it stays the honest
output of the formula, so the published breakdown still reproduces it. Only the
level is capped, and the response carries `levelFloor` so the UI can say why a
0.44 is showing as `LOW`. As it happens the default weights make this
unreachable from relative signals alone — market and sector carry 0.20 each and
neither can reach 1.0 — so the floor is the explicit guarantee and the
arithmetic is the implicit one. Both are tested.

### The chart

Two ranges: **Since I checked** and **1D**. No 1W, no 1M, no 1Y — the row of
calendar-period buttons every other price chart carries would dilute the single
comparison this product makes, which is against your own last visit.

It carries the **period high and low** for the selected range (with their
timestamps, first occurrence winning a tie) and the **last-viewed marker**. On
1D that marker is an interior dashed line with the region after it shaded:
everything to its right happened while you were away. On "Since I checked" the
visit *is* the left boundary, so it folds into the axis label rather than
overlaying a line on the chart's edge and shading the entire plot.

Honest details it does not paper over: a gap in the feed draws as a **break in
the line**, never a straight join across an outage; the bar size respects the
source's own cadence, so the grid is never finer than the data; a 1D window
against a six-hour log draws the six hours it holds and says so; and fewer than
three observations refuses to draw a line at all rather than implying a trend
from two points.

All of it is computed in `backend/src/chart.js` — the browser scales and
positions, it does not decide what the high is or where the marker goes.

### Intraday analysis

An "Analyze Intraday" action on the expanded row. Deterministic rolling
statistics, no model and no forecast: current price, window high and low with
their timestamps, window return, volatility, volume against normal, movement
against the market and against sector peers.

**The window is named before any number is shown, and nothing borrows across
windows.** The app already answers three different questions over three
different horizons — since you last looked (per-user), 1D (the chart), and the
session (this panel). A session high quietly sourced from the 1D range would be
a lie that looks exactly like a fact, so every figure here is recomputed from
the session window alone and anything the session cannot support reports
`unavailable` with a reason. There is a test that asks both features for "the
high" over deliberately different windows and asserts they **disagree**.

The engine's attention level, confidence and freshness are shown because they
are useful, but they are nested under `engine` and labelled *not
session-scoped*, because they are computed on the engine's own anomaly horizon.

**In simulator mode there is no exchange session** — the synthetic market runs
continuously, which is the entire reason it can be demoed while NSE is shut.
Inventing an open and a close for it would fabricate a boundary the data does
not have, so the window becomes a trailing stretch of the same *length* as an
NSE session and says plainly that it is not one.

Patterns are emitted only where the data supports them: unusual volume spike,
unusually large movement, sustained movement, sudden reversal, volatility
increase, divergence from market or sector, near the window high or low. Each
is past-tense and carries the evidence that produced it.

> "Unusually large" is measured against the window's own **trimmed** volatility.
> The naive comparison cannot work: a move delivered in one jump *is* `sd × √n`
> by construction, so it would score exactly 1σ however violent it was — the
> outlier inflating the very yardstick it is measured against. Trimming the
> largest few returns before estimating the scale fixes it.

**Nothing here is forward-looking.** No BUY, SELL, HOLD, target price or
prediction, and a test scans all generated text for that vocabulary.

### Alerts

Five types: price crosses above, price falls below, change since last viewed
exceeds, attention becomes HIGH, unusual volume.

**The crossing state machine is the whole problem.** A naive alert fires on
every evaluation where the condition holds, so a ₹1350 threshold with the price
at ₹1352 re-fires every fifteen seconds forever. What "tell me when it crosses
1350" means is an *edge*, not a level:

| Price | State | Result |
|---|---|---|
| 1348 | armed, condition false | nothing |
| 1350 | armed, condition true | **fires**, disarms |
| 1351 | disarmed | nothing |
| 1352 | disarmed | nothing |
| 1348 | below the reset band | re-arms, silent |
| 1352 | armed, condition true | **fires again** |

With **hysteresis**, because re-arming exactly at the threshold is not enough —
a price oscillating 1349.9 / 1350.1 would satisfy "crossed" on every wobble.
Re-arming needs the value a configurable band clear of the line (0.1% of the
threshold for prices; a fixed rupee band cannot suit both a ₹275 stock and a
₹4,000 one).

The `armed` flag lives in the database, so **a restart cannot turn a move the
user has already been told about back into news.** Tested by rebuilding the
store over the same database.

**Data quality gates everything.** An alert is only evaluated against an
observation the freshness layer calls `live` or `delayed`. A stale price fires
nothing; a `market_closed` period is not movement, so nothing fires during it.
Skipped evaluations record why and **leave the crossing state untouched** —
arming or disarming from data we have just declared untrustworthy would let a
stale reading suppress the real crossing that follows.

Evaluation hangs off the ingestion tick, because the moment new observations
land is exactly when a crossing can have happened — so an alert fires whether or
not anyone has the page open.

### One definition of "needs attention"

The engine computes `needsAttention` once per item and the summary banner, the
UI filter chip and the ranking all read that field. These had drifted into two
independent definitions — the banner counted `HIGH`/`MODERATE` while the chip
counted stale-or-conflicting rows — so one screen could show "Needs attention 0"
beside "2 deserve your attention". Two definitions of one word is a bug however
defensible each is separately. Data health is still visible, through the
freshness pill and `dataQuality`, but it is a different question from
meaningfulness.

### Score and confidence are different things

The **score** says how much this change matters. The **confidence** says how
much the score itself deserves to be believed. A 3-sigma move measured off a
stale feed with twenty samples is high-score and low-confidence, and collapsing
those into one number throws away the more actionable half.

Confidence multiplies four independent sources of doubt, because they compound:

```
confidence = observation × freshness × depth × coverage
```

*observation* — the source's own confidence in the price
*freshness* — `live` 1.0, `delayed` 0.9, `market_closed` 0.85, `stale` 0.5
*depth* — how much history the statistics had
*coverage* — how much of the total signal weight was measurable

---

## Design decisions worth defending

### Returns are measured on a fixed bar grid

The log is not evenly spaced: live ticks every 15 seconds, backfill points every
~54, dropped ticks, ten-minute blackout windows. Computing returns between
consecutive rows mixes a 15-second return and a ten-minute return into one
standard deviation — which **inflates** it, and an inflated standard deviation
*suppresses* exactly the anomalies the engine exists to find. The bug would be
silent and would look like "the engine is conservative".

So observations are projected onto a 60-second grid first, and every return
covers the same elapsed time. Carry-forward is capped at two bars: without a
cap, a ten-minute outage fills ten bars with one stale price, producing a run of
fake zero returns that deflates volatility and makes whatever happens next look
anomalous.

### The anomaly horizon is fixed, not the length of your absence

The z-score measures a **15-minute** return against that stock's own
distribution of 15-minute returns. It would have been defensible to z-score the
return over exactly the user's absence instead — that is more literally
on-thesis. It was rejected because:

- The anomaly should be a property of the **stock**, not of when you logged in.
  Otherwise two users see different z-scores for the same instrument at the same
  instant.
- A first visit has no absence window at all, so the signal would be unavailable
  precisely when a user most needs orientation.
- The surfaced-signal fingerprint would become user-relative and stop being
  comparable.

Your personal horizon is fully represented — it is feature A, the headline
number on every row.

**Known statistical caveat:** the 15-minute windows overlap (one return ending
at every bar), so the samples are autocorrelated. The standard-deviation
estimate is still sound but its own standard error is larger than the raw count
suggests. Non-overlapping windows would leave ~24 samples over a six-hour
window — too few to estimate a spread from at all.

### No ML library, and no LLM in the numeric path

The anomaly detection is rolling mean and standard deviation. That is a
decision, not a shortfall:

- **Deterministic.** Same inputs, byte-identical output. An Isolation Forest's
  `random_state` would make that guarantee someone else's to keep.
- **Unit-testable.** Every branch has a test, including the divide-by-zero.
- **Dependency-free.** Two runtime dependencies total.
- **Explainable line by line** to a user who asks "why did you show me this" —
  which a tree ensemble's feature importances are not.

On this data — one instrument's own recent return distribution — a learned
anomaly detector would score no better than a z-score, and could not be
justified to the person reading the row.

**Explanations are deterministic templates**, for the same reasons plus one
more: an LLM could produce a fluent, plausible reason the data does not support.
`"Price moved +2.1% while the market moved +0.4%"` is a report of two numbers we
hold. `"Rose on positive earnings sentiment"` is a causal claim this system has
no instrument for, and is forbidden regardless of how likely it is.

Reasons are also **gated on evidence thresholds**: a 0.1-sigma move is not
described as "unusually large", and a ratio of 1.02 is not "high volume". The
contribution still counts toward the score; only the claim is withheld.
Overstating one line costs trust in every other.

> **If an LLM were added later** it could only ever be a *phrasing* layer over
> these computed values, with the numbers passed through verbatim, a closed
> vocabulary that cannot introduce causes, and a validator asserting every
> figure in the output appears in the features. It must never decide a level.

### No investment advice, anywhere

The product says "deserves attention". Never "buy", "sell", "will rise", or a
price target. No personalised recommendations, no predictions. There is a test
that scans all generated text for advice-like and causal vocabulary.

### The simulator has a market factor

Every symbol used to be an independent noise field, which made "the whole market
moved together" **impossible to generate** — and therefore made the
market-relative and sector-relative signals impossible to demonstrate during a
weekend when NSE and BSE are shut. Returns now decompose the way real ones do:

```
symbol_return = beta × market_return + idiosyncratic_return
```

Beta is deterministic per symbol in [0.6, 1.5]; the shared market series is
addressable on its own so it can be ingested as the benchmark. Measured return
correlations with the index run 0.13–0.84. Still O(1) at any instant, still
gapping, still replayable from a seed.

Two events recur on a seed-derived schedule so any recent window contains an
anomaly to find: a large idiosyncratic price move on one symbol, and a volume
spike on a modest price move on another.

### Symbol identity

`RELIANCE`, `reliance` and `RELIANCE.NS` used to file as three separate keys, so
a watchlist entry under one saw a third of its own history. NSE is the implied
venue and its suffix now collapses. `.BO` is preserved, because BSE is a
genuinely different venue trading at a genuinely different price — and merging
them would both corrupt the NSE series and then report the result as a source
conflict with itself.

Canonicalisation is applied at **both** boundaries — watchlist writes and
snapshot writes — so the database can only ever hold canonical keys and no
reader has to remember to normalise.

### Sector peers are your own holdings

A sector return is the mean of the user's *watched* peers in that sector, and
needs at least two. The alternative — ingesting the whole sector map so the peer
group is fixed — would mean polling a third-party endpoint for a dozen
instruments nobody asked about, on every tick. The cost of the chosen rule is
real and worth stating: the sector return depends on which peers you happen to
watch, so adding a holding can change it. That is why every response **names
the peers it used** rather than presenting the comparison as absolute.

A symbol absent from the static map has **no sector**. None is invented for it —
a fabricated classification produces a confidently wrong signal, which is worse
than an honest gap.

### `last_viewed_at` semantics

Written **only** by an explicit "Mark seen". Never as a side effect of loading a
page or fetching the summary. If a read consumed it, every delta would erase
itself on first render and could never be revisited.

A new watchlist entry starts at `NULL`, which is meaningfully different from
"viewed at the moment it was added" — defaulting to now would silently claim the
user had already seen a price.

And **no new observation is not a change of zero.** If the newest observation is
the one you already saw — exactly what a stale feed produces — diffing it against
itself yields `0.00 (0.00%)`, which reads as "we checked, the price is
unchanged". The data does not support that. The row reports *no new observation
since you looked* and shows the last known price with its age instead. The
distinction matters because the two statements lead to opposite conclusions about
whether the market is quiet or the feed is broken.

Note this triggers on the absence of a newer observation, **not** on staleness: a
stale row that does have a genuine delta from before its feed stopped still
reports it, because hiding that would throw away a real measurement.

### Already-surfaced state

A change the user has already been shown is not a discovery. Without
persistence, a restart turns every ongoing move back into breaking news.

The fingerprint identifies the **event**, not the score: symbol, level, sorted
reason codes, direction, a 1% magnitude bucket, and the viewing epoch. Keying on
the score would refire every tick; keying on the symbol alone would never
refire, so a move growing from 2% to 9% would stay silent. Pressing "Mark seen"
starts a new epoch, so after the user explicitly acknowledges the state, the
next change is legitimately new again.

### Old is not stale

On a Sunday the newest real quote is Friday 15:30 IST, and that is *correct* —
it is the last traded price. Flagging it for 62 straight hours is crying wolf.
But a price from four minutes ago during a live session, when we poll every
fifteen seconds, is genuinely broken. Five states carry that distinction:
`live`, `delayed`, `market_closed`, `stale`, `no_data` — and data predating the
last *open* session is still `stale`, because the feed broke while the market
was trading.

### The log is append-only, enforced by SQLite

`BEFORE UPDATE` and `BEFORE DELETE` triggers `RAISE(ABORT)`. Event sourcing that
relies on everyone remembering not to write `UPDATE` is not an invariant, it is a
hope. Two timestamps per row — `timestamp` (the instant the price is *about*) and
`ingested_at` (the instant we *learned* it) — because a delayed feed makes them
differ by 15–20 minutes and collapsing them destroys any ability to report
freshness honestly.

---

## Determinism

Given the same snapshots, the same config and the same reference timestamp, the
engine produces the same score, the same level and the same reasons. There is no
randomness anywhere in the path, and **every "now" arrives through an injected
clock** — including in production, where it is just `Date.now`. A default
parameter buried three modules down would make the guarantee unverifiable.

The test evaluates two separately-constructed, identically-seeded databases and
compares serialised output byte for byte.

## Performance

Features are **not** recomputed per symbol per request:

- **One batched history query** covers the watchlist and the benchmark;
  every feature for every symbol is derived from that single result set in
  memory.
- **Memoised** on the log's high-water mark, the config, the clock bucket and
  the viewing epochs. The UI polls every 5 seconds; with no new observation, the
  second poll recomputes nothing.
- Bar resampling is a single linear pass with a forward pointer, not a scan per
  bar.

**How this scales.** At a dozen symbols this is comfortably the right shape. The
next bottleneck is the per-symbol conflict query and the width of the batched
history read. Beyond roughly a few hundred watched symbols per process the move
is to persisted rolling aggregates updated on ingest (mean, standard deviation
and trailing volume per symbol), turning evaluation into an O(1) read per row.
That was deliberately **not** built now: it introduces a second source of truth
to reconcile against an append-only log, plus rebuild-on-restart and
rebuild-on-backfill paths, for no measurable gain at this size. For many users
the surfaced-signals table and `last_viewed_at` are already keyed by `user_id`,
so the sharding boundary is a user.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness only — touches no database or upstream |
| `GET` | `/ready` | Readiness: per-symbol freshness, `503` if nothing is fresh |
| `GET` | `/api/watchlist` | Scored, ranked, explained watchlist |
| `GET` | `/api/summary` | "Since you were away" (`?awayMs=` dev override) |
| `GET` | `/api/chart/:symbol` | Chart series (`?range=since_viewed\|1d`) |
| `GET` | `/api/intraday/:symbol` | Session analysis: high, low, return, volatility, volume, relatives, patterns |
| `GET` `POST` | `/api/alerts` | List / create alert definitions |
| `DELETE` | `/api/alerts/:id` | Remove an alert |
| `GET` | `/api/alerts/events` | The notification list: what fired and why |
| `POST` | `/api/alerts/evaluate` | Force an evaluation (demo affordance) |
| `GET` | `/api/meta` | Source, config, engine parameters, pipeline health |
| `GET` | `/api/sectors` | The static sector map |
| `GET` | `/api/symbols` | Suggestion list |
| `POST` | `/api/watchlist` | Add (`201` new, `200` already present) |
| `DELETE` | `/api/watchlist/:symbol` | Remove (history is kept) |
| `POST` | `/api/watchlist/:symbol/viewed` | Stamp "I have now seen this" |
| `GET` | `/api/snapshots/:symbol` | Raw log — the audit trail |
| `POST` | `/api/ingest/tick` | Force a poll now (demo affordance) |

`/api/watchlist` **extends** the previous contract rather than reshaping it:
`latest`, `freshness`, `delta` and `conflict` are still in the same places, with
the engine's fields alongside. There is a test asserting that.

```json
{
  "symbol": "INFY",
  "meaningfulScore": 1,
  "level": "HIGH",
  "confidence": 0.9,
  "changeSinceViewed": { "absolute": 58.1, "percent": 3.15, "available": true },
  "reasons": ["change_since_viewed", "unusual_price_movement", "high_volume",
              "market_outperformance", "sector_outperformance"],
  "reasonText": ["+3.1% since you last checked", "..."],
  "features": { "priceAnomaly": { "available": true, "z": 6, "confidence": 0.9 }, "...": "..." },
  "scoreBreakdown": { "priceAnomaly": { "weight": 0.35, "contribution": 1, "weighted": 0.35 } },
  "dataQuality": "LIVE",
  "alreadySurfaced": false
}
```

All business logic is in the backend. The frontend renders; it does not
recompute.

## Architecture

```
backend/src/
  symbols.js          one definition of "which instrument is this"
  config.js           every knob, with the reasoning attached
  db.js               schema; append-only enforced by triggers
  snapshot-log.js     the only reader/writer of observations
  watchlist.js        add / remove / list / markViewed
  freshness.js        old vs stale, and source conflicts
  ingest.js           poll loop + boot backfill
  summary.js          "since you were away"
  chart.js            the chart series: two ranges, high/low, marker
  intraday.js         session analysis - its own window, never borrowed
  alerts.js           definitions, the crossing state machine, events
  api.js              HTTP surface
  engine/
    numeric.js        every arithmetic hazard, in one place
    returns.js        bar resampling, rolling statistics
    features.js       the five measurements, no decisions
    score.js          weighting, renormalisation, levels, confidence
    reasons.js        deterministic explanation templates
    surfaced.js       fingerprints and the "already shown" store
    index.js          orchestration, batching, memoisation, ranking
  sources/
    index.js          the DataSource interface
    noise.js          deterministic, O(1)-addressable pseudo-randomness
    simulator.js      synthetic market with a shared market factor
    yahoo.js          real NSE/BSE via raw fetch
  demo/
    fixture.js        the reproducible scenario
    seed.js           npm run demo
```

## Configuration

Everything lives in [config.js](backend/src/config.js); nothing else reads
`process.env`. Selected values:

| Variable | Default | Notes |
|---|---|---|
| `DATA_SOURCE` | `simulator` | `simulator` \| `yahoo` |
| `SIM_SEED` | `groww-code-2026` | Same seed ⇒ same market, exactly |
| `ENGINE_BAR_MS` | `60000` | Resampling grid |
| `ENGINE_ANOMALY_HORIZON_MS` | `900000` | The window the z-score judges |
| `ENGINE_STATS_WINDOW_MS` | `21600000` | How much history the statistics see |
| `ENGINE_MIN_RETURNS` | `20` | Below this, an anomaly is unavailable |
| `ENGINE_MIN_STDDEV` | `0.0004` | The divide-by-zero floor |
| `ENGINE_Z_CLAMP` | `6` | One bad tick cannot dominate |
| `ENGINE_W_*` | `.35/.25/.20/.20` | Signal weights |
| `ENGINE_LEVEL_MODERATE/HIGH` | `0.4` / `0.7` | Level thresholds |
| `ENGINE_RELATIVE_HALF_PCT` | `1.5` | Half-contribution point for the relative signals |
| `ENGINE_FLOOR_MIN_Z` | `0.75` | Below this the stock's own move is negligible |
| `ENGINE_FLOOR_MIN_CHANGE_PCT` | `0.25` | Below this your visible change is negligible |
| `ENGINE_FLOOR_MIN_VOLUME` | `1.5` | Below this the turnover is negligible |
| `ENGINE_LONG_ABSENCE_MS` | `86400000` | Past this, the summary aggregates |
| `SECTOR_MIN_PEERS` | `2` | One peer is not a sector |

## Tests

```bash
npm test    # 151 tests
```

No network, no filesystem, no uncontrolled clock — in-memory SQLite, stub
sources, fixed timestamps. They assert the *guarantees*, not the implementation:

- normal vs unusual movement; volume spike on a small move; large move on normal
  volume
- a market-wide move scoring **lower** than the same move alone
- every missing-signal case, with the renormalisation checked by recomputing the
  score from the published breakdown
- insufficient history; zero and near-zero volatility; no `NaN`/`Infinity`
  across seven adversarial histories
- `delayed`, `stale`, `market_closed` and conflicting-source states flowing
  through to the result
- first visit, short absence, long absence, repeated and surfaced signals,
  surfaced state surviving a restart
- ranking order, and determinism as byte-identical output
- history not being rewritable even by raw SQL; a seconds-vs-milliseconds
  timestamp being refused
- the simulated market matching its golden fingerprint

## The demo scenario

`npm run demo` writes a fixed scenario and prints it — the demo script and the
regression baseline are the same artefact.

Two demos, for two different things:

- **`npm run demo`** — the engine, deterministically. Its printed output *is* the
  artefact, and its guarantees hold at the reference instant it was seeded for.
- **`npm start`** (simulator) — the live UI, with prices actually moving.

The fixture is a static snapshot, so a fixture database left running will
correctly report every row as `stale` once its newest observation ages past the
tolerance, and scores drift as the anomaly window slides over the frozen data.
That is the freshness layer working, not the demo breaking — but it is why the
live UI demo uses the simulator.

| Symbol | Shows |
|---|---|
| `INFY` | **HIGH** — big idiosyncratic move, 5x volume, market flat |
| `SBIN` | **MODERATE** — 2.9x volume on a 0.8% move |
| `TCS` `WIPRO` `HCLTECH` | **LOW**, and INFY's sector peers |
| `HDFCBANK` | Two sources disagreeing 0.9% — the conflict path |
| `RELIANCE` / `RELIANCE.BO` | The **real** NSE/BSE pair, correctly *not* a conflict |
| `ITC` | Missing volume — unavailable, weight renormalised |
| `MARUTI` | Thin history — "not enough observations yet" |

### A correction on the conflict case

The brief suggested using a real captured pair — RELIANCE at 1327.60 on NSE
against 1329.10 on BSE, seconds apart — as the conflicting-source case. **It
cannot be one**, for two independent reasons:

1. Those are deliberately **different instruments** since the canonicalisation
   fix. Filing them as one symbol is the bug that fix removed.
2. They **agree**. The spread is 0.113%, well inside the 0.5% tolerance, so
   flagging it would be the false positive the tolerance exists to prevent.

Lowering the tolerance until real, agreeing data trips the alarm would be tuning
the product to make a demo fire. So the real pair demonstrates what it genuinely
shows — two venues, correctly separate, correctly not in conflict — and the
conflict path is shown by a labelled constructed disagreement on one symbol,
which is the shape a real conflict actually takes. Both are asserted in
[fixture.test.js](backend/test/fixture.test.js).

---

## Known limitations, stated rather than hidden

- **Trading holidays are not modelled.** Market hours are weekday + session
  time. A hardcoded 2026 NSE holiday list would be invented data; on a holiday
  the app reports "open" and will call a correctly-unchanging price stale.
- **Overlapping return windows** are autocorrelated (above).
- **Yahoo is an unofficial endpoint**, and its `regularMarketVolume` fallback is
  day-cumulative rather than per-interval — which is why volume is reported as a
  ratio and why that fallback lowers confidence.
- **One hardcoded dev user.** Every query is already scoped by `user_id`.
- **Conflict detection is one query per symbol** — fine for a dozen rows against
  an indexed table, would need batching at a thousand.
- **Sector map is static and small** (16 symbols). A real product takes this from
  an exchange classification feed.

## Deliberately out of scope

LLM integration, stock discovery or recommendations, gamification,
authentication, a chatbot, price prediction.

Price charts, intraday analysis and alerts were on this list during P0 and have
since been scoped in deliberately — the chart, then the intraday panel and
alerts. Everything still listed above remains out, and the scoring engine is
still the submission.
