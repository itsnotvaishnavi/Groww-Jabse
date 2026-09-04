# Jabse

**जब से** — *jab se*, Hindi for "since".

A watchlist that answers **"what has meaningfully changed *since I last looked*"**
rather than "what moved today".

Built for Groww "Code" — solo build, Sep 4–7 2026. Two runtime dependencies,
no build step, no API keys.

**Run it:** `npm install && npm start` → <http://localhost:3000>. Full setup in
[Setup](#setup).

---

## Contents

[The problem](#the-problem) · [What Jabse is](#what-jabse-is-in-one-paragraph) ·
[The engine](#the-engine) · [Data engineering](#data-engineering) ·
[Product surface](#product-surface) · [Setup](#setup) ·
[Architecture](#architecture) · [Decisions](#decisions-and-why) ·
[Scalability](#scalability) · [Deferred](#considered-and-deferred) ·
[Limitations](#known-limitations-stated-rather-than-hidden)

---

## The problem

Every watchlist shows the same number: today's percentage change. Three things
are wrong with it.

**"Today" is an arbitrary window that has nothing to do with you.** If you last
checked on Tuesday, a flat Friday tells you nothing about the 4% round trip you
missed. The window that matters is the one bounded by your own last visit, and
no product measures it.

**"Moved a lot" is not the same as "matters".** A 0.4% move is unremarkable for
ZOMATO and remarkable for HDFCBANK. A 2% rise when the whole market rose 2% is
not news about your stock. A 1% move on four times the usual volume often
matters more than a 3% move on a quiet tape. Sorting by magnitude reliably
surfaces the most volatile stock having an ordinary day and buries the placid
one doing something genuinely unusual.

**A system that flags things must be able to say why it did not.** "You weren't
alerted" is unauditable unless the app can produce the number that failed the
rule. Most can't, because the explanation is written by hand and drifts from the
code that decides.

So: **defining "meaningful", making it testable, and making it explainable** is
what this project is. The name is the thesis — *jab se*, since. Since when?
Since **you** last looked.

---

## What Jabse is, in one paragraph

**Jabse is not trying to show everything that happened in the market. It
answers a narrower question: what meaningfully changed since I last checked?**

Everything follows from taking that question literally:

- **The baseline is explicit.** Only an action by the user — "Mark seen", "Mark
  all as seen" — moves the point they are comparing from. Loading a page,
  polling, opening a row or refreshing never does.
- **Historical observations are immutable.** The snapshot log is append-only and
  the database enforces it, so a price the user has already seen cannot be
  rewritten under them.
- **Meaningfulness is deterministic.** Same snapshots, same config, same clock,
  same answer — byte for byte. No model, no randomness, no `random_state`
  belonging to someone else.
- **Data quality is part of the result, not a footnote.** Every score ships with
  a confidence, every price with a freshness state, and "we could not measure
  this" is a first-class answer that changes the arithmetic.
- **Explanations are evidence.** Every sentence is a template over a number the
  system holds and can show you. There is no LLM anywhere in the path.

### Why this is not a screener

Groww already has an intraday screener, and it is good at what it does:
price, volume, RSI, MACD, breakout signals — the whole indicator surface,
across the market, on demand.

Jabse is deliberately not trying to reproduce that. A screener answers "what
does the market look like right now, by these measures". Jabse answers "what
changed for **me** since **my** last visit, and does it deserve my attention".
The differentiation is **the diff against the user's own last view**, not the
number of indicators on screen. Adding twenty more indicators would make it a
worse version of a tool that already exists; making the personal baseline
first-class is the thing nothing else does.

That is also why there is no discovery, no recommendation, no screening across
the market, and no gamification. Each is listed under
[Deliberately out of scope](#deliberately-out-of-scope) as a decision with a
reason, not a gap.

---

## The engine

Four signals, each measured independently, each able to say "I could not
measure this". Weights are configuration, not constants.

| Signal | Weight | The question it answers |
|---|---|---|
| **Price anomaly** | 0.35 | Is this move unusual *for this stock*? |
| **Volume anomaly** | 0.25 | Is the tape busier than normal? |
| **Market-relative** | 0.20 | Did it move more than the market? |
| **Sector-relative** | 0.20 | Did it move more than its peers? |

Plus **change since you last looked**, which is deliberately *not* one of the
scored signals — it is the user's own frame of reference and the thing they came
back to find out, so it leads every explanation and is never averaged into a
score.

```
score = Σ(weight × contribution) ÷ Σ(weight of available signals)
```

### Renormalisation is the important part

If the sector signal is unavailable, the weighted sum is divided by **0.80**,
not 1.00. Dividing by 1.00 would treat "we could not measure the sector" as
"the sector said nothing was happening" — silently capping every unsectored
stock at 80% of the score it earns. One test recomputes the score from the
published breakdown; another asserts each missing signal removes exactly its own
weight and nothing else.

**Missing is never zero.** Absent volume is *unavailable*, not a collapse in
trading activity. A never-viewed symbol has *no baseline*, not a 0% change.
Every feature carries `available`, a machine-readable `reason`, and its own
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
**your** stock — and calling that attention-worthy would be the engine mistaking
context for news.

Turnover is part of that test deliberately. Gating only on the price z-score and
the change would have suppressed the volume-spike case — a 0.4% move on three
times normal volume — which is the most valuable thing this engine finds and the
one a percentage-change watchlist always misses. Volume is a fact about *this*
stock, not about the index.

The score is **not** rewritten when the floor applies: it stays the honest output
of the formula, so the published breakdown still reproduces it. Only the level is
capped, and the response carries `levelFloor` so the UI can say why a 0.44 shows
as `LOW`. As it happens the default weights make this unreachable from relative
signals alone — market and sector carry 0.20 each and neither can reach 1.0 — so
the floor is the explicit guarantee and the arithmetic is the implicit one. Both
are tested.

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

### One definition of "needs attention"

The engine computes `needsAttention` once per item and the summary banner, the
UI filter chip and the ranking all read that field. These had drifted into two
independent definitions — the banner counted `HIGH`/`MODERATE` while the chip
counted stale-or-conflicting rows — so one screen could show "Needs attention 0"
beside "2 deserve your attention". Two definitions of one word is a bug however
defensible each is separately. Data health is still visible, through the
freshness pill and `dataQuality`, but it is a different question from
meaningfulness.

### Determinism

Given the same snapshots, the same config and the same reference timestamp, the
engine produces the same score, the same level and the same reasons. There is no
randomness anywhere in the path, and **every "now" arrives through an injected
clock** — including in production, where it is just `Date.now`. A default
parameter buried three modules down would make the guarantee unverifiable.

The test evaluates two separately-constructed, identically-seeded databases and
compares serialised output byte for byte.

---

## Data engineering

The statistics are only as honest as the series underneath them, and most of the
work in this repo is in the series rather than the formula.

### Two timestamps per observation

`timestamp` is the instant the price is *about*. `ingested_at` is the instant we
*learned* it. A delayed feed makes them differ by 15–20 minutes, and collapsing
them destroys any ability to report freshness honestly — you can no longer tell
"the market is quiet" from "our feed stopped 20 minutes ago". Every freshness
state, every alert gate and the entire audit trail depend on holding both.

A lower bound rejects a timestamp in seconds where milliseconds were expected;
a value of `1.7e9` silently parses as January 1970 and would poison every
window it landed in.

### The log is append-only, enforced by the database

`BEFORE UPDATE` and `BEFORE DELETE` triggers `RAISE(ABORT)`. Event sourcing that
relies on everyone remembering not to write `UPDATE` is not an invariant, it is a
hope. A test attempts both from raw SQL and asserts the abort.

The consequence is that a price the user has already seen can never be
retroactively rewritten, which is what makes "since you last looked" a
statement about observed history rather than about whatever the source says
today.

### One instrument is one key

`RELIANCE`, `reliance` and `RELIANCE.NS` used to file as three separate keys, so
a watchlist entry under one saw a third of its own history. NSE is the implied
venue and its suffix now collapses. `.BO` is preserved, because BSE is a
genuinely different venue trading at a genuinely different price — merging them
would corrupt the NSE series and then report the result as a source conflict
with itself.

Canonicalisation is applied at **both** boundaries — watchlist writes and
snapshot writes — so the database can only ever hold canonical keys and no
reader has to remember to normalise.

### Returns are measured on a fixed bar grid

The log is not evenly spaced: live ticks every 15 seconds, backfill points every
~54, dropped ticks, ten-minute blackout windows. Computing returns between
consecutive rows mixes a 15-second return and a ten-minute return into one
standard deviation — which **inflates** it, and an inflated standard deviation
*suppresses* exactly the anomalies the engine exists to find. The bug would be
silent and would look like "the engine is conservative".

So observations are projected onto a 60-second grid first, and every return
covers the same elapsed time. Carry-forward is capped at two bars: without a cap,
a ten-minute outage fills ten bars with one stale price, producing a run of fake
zero returns that deflates volatility and makes whatever happens next look
anomalous. Gaps past the cap stay `null` and propagate as gaps — the chart draws
a break rather than a straight line across an outage.

### Numerical safety in one place

`engine/numeric.js` holds every arithmetic hazard: a standard-deviation floor so
a flat series cannot divide by zero, a z clamp so one bad tick cannot dominate,
a strictly-increasing bounded magnitude map, and `assertAllFinite` walking the
whole output tree so a `NaN` cannot reach the UI as a blank. Seven adversarial
histories are asserted to produce finite, in-range output: a single observation,
a perfectly flat series, all-zero volume, a jump to 1e6, a ₹0.01 price, a 1e12
volume spike, and a price alternating by one paisa.

### Old is not stale

On a Sunday the newest real quote is Friday 15:30 IST, and that is *correct* — it
is the last traded price. Flagging it for 62 straight hours is crying wolf. But a
price from four minutes ago during a live session, when we poll every fifteen
seconds, is genuinely broken. Five states carry the distinction: `live`,
`delayed`, `market_closed`, `stale`, `no_data` — and data predating the last
*open* session is still `stale`, because the feed broke while the market was
trading.

A demo scenario is the one case where the state is right and the *wording* was
not. A scenario seeds history up to a chosen instant and stops — its guarantees
are anchored to the end of its own series — so its newest observation ages and
the assessment correctly reaches `stale`. But "Stale — feed may be down" is
false: the feed is not down, time was moved on purpose, and telling a reviewer
the app is broken is the worst thing to be imprecise about. A frozen source is
therefore relabelled `Scenario snapshot · 19:41 IST`, and **only** the label
changes: the state, the age, the halved confidence and the alerts' refusal to
evaluate all stand, because the data really is old. That is what makes the
`data_delay` scenario still able to demonstrate what stale data does.

### `last_viewed_at` semantics

Written **only** by an explicit "Mark seen" or "Mark all as seen". Never as a
side effect of loading a page, rendering, polling, opening a symbol, expanding
its details, or refreshing. If a read consumed it, every delta would erase
itself on first render and could never be revisited.

A new watchlist entry starts at `NULL`, which is meaningfully different from
"viewed at the moment it was added" — defaulting to now would silently claim the
user had already seen a price.

And **no new observation is not a change of zero.** If the newest observation is
the one you already saw — exactly what a stale feed produces — diffing it against
itself yields `0.00 (0.00%)`, which reads as "we checked, the price is
unchanged". The data does not support that. The row reports *no new observation
since you looked* and shows the last known price with its age instead. The two
statements lead to opposite conclusions about whether the market is quiet or the
feed is broken.

Note this triggers on the absence of a newer observation, **not** on staleness: a
stale row that does have a genuine delta from before its feed stopped still
reports it, because hiding that would throw away a real measurement.

### Sector peers are your own holdings

A sector return is the mean of the user's *watched* peers in that sector, and
needs at least two. The alternative — ingesting the whole sector map so the peer
group is fixed — would mean polling a third-party endpoint for a dozen
instruments nobody asked about, on every tick. The cost of the chosen rule is
real and worth stating: the sector return depends on which peers you happen to
watch, so adding a holding can change it. That is why every response **names the
peers it used** rather than presenting the comparison as absolute.

A symbol absent from the static map has **no sector**. None is invented for it —
a fabricated classification produces a confidently wrong signal, which is worse
than an honest gap.

---

## Product surface

### Since you were away

The landing view: how long you were gone, how much changed, how much of it
deserves attention, then the few things that do — ranked by the engine, never by
raw percentage change. Past a day away it aggregates per level instead of
enumerating, because nobody returning after a weekend wants a tick-by-tick
account.

Loading it does not consume `last_viewed_at`, so the summary survives being
read.

### Mark seen, mark all as seen, and being caught up

**Mark Seen resets the user's comparison baseline, not market history.**

That sentence is the product. Marking seen moves `last_viewed_at` — the point
future change is measured *from* — and touches nothing else. It writes no
snapshot, deletes none, and rewrites none; the log's `BEFORE UPDATE` and
`BEFORE DELETE` triggers would abort the attempt if it tried. Every observation
the app ever made is still there afterwards, and there is a test that compares
the log byte for byte across a mark to prove it.

"Mark all as seen" stamps every symbol at **one instant, in one transaction**.
Per-row `Date.now()` calls would leave the rows milliseconds apart, and "how
long were you away" is the *minimum* `last_viewed_at` across the watchlist — so
a partial write would silently anchor the next visit to whichever row happened
to go first.

Afterwards the app says so explicitly: **"You're all caught up. Jabse will
watch what changes next."** That state is computed server-side beside the counts
it is made of, and is *derived rather than stored* — which is exactly what makes
it survive a refresh. The next request recomputes it from the same baselines, so
it persists for precisely as long as it remains true. It is deliberately strict:
every symbol must have a baseline, nothing may have moved since those baselines,
and nothing may be asking for attention. A symbol never marked seen blocks it,
because "caught up" is a claim about a comparison, and for that symbol no
comparison exists yet.

### Attention grouping

The watchlist is grouped rather than merely sorted:

| Group | What it means |
|---|---|
| **Needs attention** | At or above the engine's existing attention bar |
| **Meaningful changes** | Something notable happened to this stock, below the bar |
| **Stable** | Measured against your baseline, nothing notable to report |
| **No baseline yet** | Nothing to compare against — not the same as stable |

This is **presentation over the engine's verdict**, not a second scoring pass.
No new level, no new threshold, and nothing recomputed in the browser: the
engine publishes an `attentionGroup` per row, and the mapping reuses the level
floor's own negligibility test — extracted as `nothingNotableAbout()` so the
floor and the grouping cannot drift apart. A second copy of those three
comparisons in the UI would be a second definition of "notable", and this
codebase has already paid for one of those.

**The fourth group exists because of what it would otherwise be lying about.**
A symbol with no baseline is not stable. "Stable" reports a measurement; an
unseen symbol is the absence of one, and folding it in would have the app
claiming a comparison it never made.

*Meaningful changes* is the group an ordinary percentage-change watchlist has no
way to express: a 0.4% move on three times normal volume is not "a small move",
it is a small move with something behind it.

### Attention sensitivity

A three-way control — low, medium, high — over how aggressively
already-computed results are surfaced.

It is a **display threshold and nothing more**. It changes no score, no weight,
no confidence, no freshness, no alert, and no stored value; a test asserts the
evaluation is byte-identical before and after every setting is applied. The
scale it uses is the engine's own published levels, never an invented
percentage:

| Setting | Surfaced prominently |
|---|---|
| Low | `HIGH` only |
| Medium | the engine's own attention bar, exactly as it computes it |
| High | the bar, plus the meaningful-but-below-bar group |

At medium it returns the engine's answer unchanged. The other two move rows
between the attention band and the meaningful band, and the band **states the
threshold it is using** — because the "since you were away" banner reports what
the *engine* found while the band reports what *you asked to see*, and two
numbers on one screen are only both true if each says which it is.

In-session by decision: one display preference does not warrant a settings
table, and persisting it would mean a returning user could be shown less than
the engine found without remembering they had asked for that.

It lives in [frontend/sensitivity.js](frontend/sensitivity.js), with no DOM in
it, specifically so the test suite can import it and check the claim that it
cannot affect a score. An untested claim of that kind is worth very little.

### Change history

A chronological view of what Jabse has actually surfaced — timestamp, symbol,
level, the change against the baseline it was measured on, and the reasons that
qualified it.

It is a **view over the surfaced-signal store**, not a parallel history system.
That table has recorded which signals were presented and when since the engine
shipped; what it was missing was *what they said*, so two columns were added to
it. The reasons and the delta are **captured at surface time** — recomputing
them when the timeline is rendered would describe whatever the market is doing
at that later moment while displaying yesterday's timestamp, which is the same
reason a fired alert stores its diagnosis at fire time.

Ordering is by when a signal *became* news, not when it was last shown:
re-presenting an unchanged event on a later page load is a reload, not a second
event, so the count grows and the timestamp does not. Symbol breaks
same-millisecond ties so the order is total.

**There are no "stable" entries, by construction.** Nothing quiet is ever
surfaced, and the absence of change is not an event. Filters are `All`, `High`
and `Meaningful` — which are the only two levels that can appear.

### Search by ticker or company name

`TCS`, `tcs`, `Tata Consultancy` and `consultancy` all resolve to the same
instrument. Resolution happens server-side over the active source's own symbol
list, in a deliberate order: a ticker the source knows wins outright, then an
exact name, then a unique substring — simple `includes`, no fuzzy library, no
scoring, no search service.

**Ambiguity is reported, not guessed.** "tata" is Tata Consultancy *and* Tata
Motors; picking one would put the wrong stock on someone's watchlist, so the
candidates come back and the user picks. Input that is still ticker-shaped but
unlisted passes through, because `getSymbols()` returns a featured handful while
Yahoo knows thousands.

### Ingestion heartbeat

One line: `Last sync 19:42:18 · next ~19:42:33`.

The ingestor reports its own schedule — `nextTickAt` is `lastTickAt +
intervalMs` from the module that owns the `setInterval`, and **null whenever the
loop is not running**, so the UI can never draw a countdown with no timer behind
it. When ingestion is disabled it says that instead. There is no timer in the
frontend; the line refreshes on the same poll as everything else.

### The chart

Two ranges: **Since I checked** and **1D**. No 1W, no 1M, no 1Y — the row of
calendar-period buttons every other price chart carries would dilute the single
comparison this product makes, which is against your own last visit.

It carries the **period high and low** for the selected range (with their
timestamps, first occurrence winning a tie) and the **last-viewed marker**. On 1D
that marker is an interior dashed line with the region after it shaded:
everything to its right happened while you were away. On "Since I checked" the
visit *is* the left boundary, so it folds into the axis label rather than
overlaying a line on the chart's edge and shading the entire plot.

Honest details it does not paper over: a gap in the feed draws as a **break in
the line**, never a straight join across an outage; the bar size respects the
source's own cadence, so the grid is never finer than the data; a 1D window
against a six-hour log draws the six hours it holds and says so; and fewer than
three observations refuses to draw a line at all rather than implying a trend
from two points.

All of it is computed in [chart.js](backend/src/chart.js) — the browser scales
and positions, it does not decide what the high is or where the marker goes.

### Intraday analysis

An "Analyze Intraday" action on the expanded row. Deterministic rolling
statistics, no model and no forecast: current price, window high and low with
their timestamps, window return, volatility, volume against normal, movement
against the market and against sector peers.

**The window is named before any number is shown, and nothing borrows across
windows.** The app answers three different questions over three different
horizons — since you last looked (per-user), 1D (the chart), and the session
(this panel). A session high quietly sourced from the 1D range would be a lie
that looks exactly like a fact, so every figure here is recomputed from the
session window alone and anything the session cannot support reports
`unavailable` with a reason. There is a test that asks both features for "the
high" over deliberately different windows and asserts they **disagree**.

The engine's attention level, confidence and freshness are shown because they are
useful, but they are nested under `engine` and labelled *not session-scoped*,
because they are computed on the engine's own anomaly horizon.

**In simulator mode there is no exchange session** — the synthetic market runs
continuously, which is the entire reason it can be demoed while NSE is shut.
Inventing an open and a close for it would fabricate a boundary the data does not
have, so the window becomes a trailing stretch of the same *length* as an NSE
session and says plainly that it is not one.

Patterns are emitted only where the data supports them: unusual volume spike,
unusually large movement, sustained movement, sudden reversal, volatility
increase, divergence from market or sector, near the window high or low. Each is
past-tense and carries the evidence that produced it.

> "Unusually large" is measured against the window's own **trimmed** volatility.
> The naive comparison cannot work: a move delivered in one jump *is* `sd × √n`
> by construction, so it would score exactly 1σ however violent it was — the
> outlier inflating the very yardstick it is measured against. Trimming the
> largest few returns before estimating the scale fixes it.

### Alerts

Five types: price crosses above, price falls below, change since last viewed
exceeds, attention becomes HIGH, unusual volume.

**The crossing state machine is the whole problem.** A naive alert fires on every
evaluation where the condition holds, so a ₹1350 threshold with the price at
₹1352 re-fires every fifteen seconds forever. What "tell me when it crosses 1350"
means is an *edge*, not a level:

| Price | State | Result |
|---|---|---|
| 1348 | armed, condition false | nothing |
| 1350 | armed, condition true | **fires**, disarms |
| 1351 | disarmed | nothing |
| 1352 | disarmed | nothing |
| 1348 | below the reset band | re-arms, silent |
| 1352 | armed, condition true | **fires again** |

With **hysteresis**, because re-arming exactly at the threshold is not enough — a
price oscillating 1349.9 / 1350.1 would satisfy "crossed" on every wobble.
Re-arming needs the value a configurable band clear of the line (0.1% of the
threshold for prices; a fixed rupee band cannot suit both a ₹275 stock and a
₹4,000 one).

The `armed` flag lives in the database, so **a restart cannot turn a move the
user has already been told about back into news.** Tested by rebuilding the store
over the same database.

**Data quality gates everything.** An alert is only evaluated against an
observation the freshness layer calls `live` or `delayed`. A stale price fires
nothing; a `market_closed` period is not movement, so nothing fires during it.
Skipped evaluations record why and **leave the crossing state untouched** —
arming or disarming from data we have just declared untrustworthy would let a
stale reading suppress the real crossing that follows.

Evaluation hangs off the ingestion tick, because the moment new observations land
is exactly when a crossing can have happened — so an alert fires whether or not
anyone has the page open.

### "Why wasn't I alerted?"

For any alert that did not fire, the answer is specific and computed from the
engine — never a generic message:

| Situation | What it says |
|---|---|
| Below a price threshold | `Currently ₹1412.30 — ₹37.70 below your ₹1450 threshold` |
| Attention rule unmet | `Attention is MODERATE, not HIGH: the score is 0.43 and HIGH needs 0.7` |
| Stale feed | `Not evaluated: the newest observation is stale (1502s old). Alerts only run against live or delayed data.` |
| Already fired | `Already fired at ₹1352. It will not fire again until the value comes back past ₹1348.65` |
| No baseline | `you have not opened this symbol, so there is no baseline to compare against` |

Alongside every one of those sit the **feature facts** that produced it, each
carrying its own number: *price movement is not unusual for this stock (0.4σ)*,
*volume is normal (1.0×)*, *the market moved similarly (+0.084% vs +0.041%)*,
*sector comparison unavailable (insufficient_peers)*.

Three things make it trustworthy rather than decorative:

- **A stale feed is reported on its own, and never alongside "condition not
  met".** The rule was not checked and found wanting; it was not checked at all.
  `met` is `null`, not `false`. A permanently stale feed must not be able to hide
  behind language that suggests a quiet market.
- **"Measured and ordinary" and "could not measure" are different statements.**
  Both produce a low score and only one means the market was calm.
- **The explainer and the evaluator read the same rules.** Both import them from
  [alert-rules.js](backend/src/alert-rules.js), which exists precisely so neither
  keeps a private copy — an audit trail that disagrees with the thing it audits
  is worse than none. A test runs a diagnosis and an evaluation side by side and
  asserts they agree on every verdict.

The mirror case is recorded too: a fired alert stores its rule, the value that
crossed it and which signals contributed — **captured at fire time**, because by
the time anyone reads the notification the market has moved and a recomputed
explanation would describe a different moment.

### Demo scenarios

Named, seeded and reproducible: `npm run demo -- <condition> [timeAway]`.

| Condition | Produces |
|---|---|
| `normal` | All LOW — the baseline to read the others against |
| `high_volume` | MODERATE on turnover alone, price move unremarkable |
| `stock_outperforms` | **HIGH with all four signals, sector included** |
| `market_wide` | LOW despite a 6σ move — the relative signals cancel |
| `data_delay` | STALE, confidence halved, alerts refusing to fire |
| `source_conflict` | A 0.9% disagreement reported, not silently resolved |

Time away — `1h`, `6h`, `24h`, `2d` — is the absence override, named and one
click in the UI. It changes only the reported duration and whether the summary
enumerates or aggregates, never a score.

**The cold open is asserted, not assumed.** `stock_outperforms` must produce HIGH
*with the sector signal available*, because a HIGH reached on three signals with
sector renormalised away does not demonstrate the sector comparison at all. The
first version of that scenario silently failed this: its move completed an hour
before the end, outside the engine's fifteen-minute anomaly horizon, so it scored
0.29 and LOW. The test caught it, and still guards it.

> Market conditions are a **seeding** operation applied to a fresh database, not
> a live switch. The snapshot log is append-only, so writing crafted history over
> a live series would contaminate the statistics and cost these scenarios the
> determinism that is their entire point.

### API

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
| `POST` | `/api/alerts/events/acknowledge` | Mark the notification list seen |
| `POST` | `/api/alerts/evaluate` | Force an evaluation (demo affordance) |
| `GET` | `/api/alerts/diagnostics` | Why each alert did or did not fire |
| `GET` | `/api/demo/scenarios` | The named scenario catalogue |
| `GET` | `/api/meta` | Source, config, engine parameters, pipeline health |
| `GET` | `/api/sectors` | The static sector map |
| `GET` | `/api/symbols` | Suggestion list |
| `POST` | `/api/watchlist` | Add (`201` new, `200` already present) |
| `DELETE` | `/api/watchlist/:symbol` | Remove (history is kept) |
| `POST` | `/api/watchlist/:symbol/viewed` | Stamp "I have now seen this" |
| `POST` | `/api/watchlist/viewed-all` | Mark all as seen: one baseline instant for every symbol |
| `GET` | `/api/history` | Change history (`?level=HIGH\|MODERATE`, `?limit=`) |
| `GET` | `/api/snapshots/:symbol` | Raw log — the audit trail |
| `POST` | `/api/ingest/tick` | Force a poll now (demo affordance) |

Every parameter that reaches SQL is validated and bounded at the boundary,
including `limit` — a negative `LIMIT` is unbounded in SQLite, and `-1` is
truthy, so `Number(x) || fallback` does not catch it.

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
recompute — no threshold, weight or level boundary appears anywhere in
[frontend/](frontend/).

---

## Setup

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # 216 tests, no network / clock / filesystem
npm run demo              # the full fixture
npm run demo -- stock_outperforms 6h    # a named scenario
```

Requires Node 22+ (developed on 24). No API keys, no configuration file, no
migration step. The database is created on first boot.

### The Yahoo switch

```bash
DATA_SOURCE=yahoo npm start          # real NSE/BSE prices
DATA_SOURCE=simulator npm start      # the default: deterministic synthetic market
```

Both implement the same four-method `DataSource` interface
([sources/index.js](backend/src/sources/index.js)), and nothing downstream of
ingestion knows which one is attached. Yahoo is an unofficial endpoint reached
with raw `fetch` — no SDK, no key — and its `regularMarketVolume` fallback is
day-cumulative rather than per-interval, which is why volume is reported as a
ratio and why that fallback lowers the observation's confidence.

The simulator is the default because a hackathon demo has to work at 2am on a
Sunday with both exchanges shut, and because a deterministic market is the only
way to assert engine behaviour end to end.

Useful overrides while demoing:

```bash
curl 'localhost:3000/api/summary?awayMs=180000000'   # simulate a 50h absence
INGEST_ENABLED=false npm start                       # freeze the feed
SIM_SEED=whatever npm start                          # a different market
```

### Configuration

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

### Tests

```bash
npm test    # 216 tests
```

No network, no filesystem, no uncontrolled clock — in-memory SQLite, stub
sources, fixed timestamps. They assert the *guarantees*, not the
implementation:

- normal vs unusual movement; volume spike on a small move; large move on normal
  volume
- a market-wide move scoring **lower** than the same move alone
- every missing-signal case, with the renormalisation checked by recomputing the
  score from the published breakdown
- insufficient history; zero and near-zero volatility; no `NaN`/`Infinity`
  across seven adversarial histories (single point, flat, zero volume, 1e6 jump,
  ₹0.01 price, 1e12 volume, one-paisa alternation)
- `delayed`, `stale`, `market_closed` and conflicting-source states flowing
  through to the result
- first visit, short absence, long absence, repeated and surfaced signals,
  surfaced state surviving a restart
- the alert crossing edge, hysteresis, the persisted `armed` flag across a
  restart, and diagnosis agreeing with evaluation on every verdict
- session metrics never borrowing from the engine's window, asserted by making
  the two windows disagree
- ranking order, and determinism as byte-identical output
- history not being rewritable even by raw SQL; a seconds-vs-milliseconds
  timestamp being refused
- all generated text scanned for advice-like and causal vocabulary
- the simulated market matching its golden fingerprint

---

## Architecture

```
  ┌────────────┐   sources/         simulator (deterministic, O(1) at any instant)
  │  SOURCES   │   index.js         yahoo     (real NSE/BSE, raw fetch)
  └─────┬──────┘                    one 4-method interface, nothing below knows which
        │
  ┌─────▼──────┐   ingest.js        poll loop + boot backfill, canonicalises keys,
  │ INGESTION  │                    records absences and failures as facts
  └─────┬──────┘
        │
  ┌─────▼──────┐   db.js            append-only; UPDATE/DELETE aborted by trigger
  │  SNAPSHOT  │   snapshot-log.js  two timestamps per row: about-instant, learned-instant
  │   STORE    │                    the only reader/writer of observations
  └─────┬──────┘
        │
  ┌─────▼──────┐   engine/          fixed 60s bar grid, capped carry-forward,
  │  FEATURE   │   returns.js       rolling mean and σ over a 6h window
  │ EXTRACTION │   features.js      five measurements, no decisions
  └─────┬──────┘
        │
  ┌─────▼──────┐   engine/          z-score vs this stock's own distribution,
  │  ANOMALY   │   numeric.js       σ floor, z clamp, every hazard in one place
  │ DETECTION  │                    volume ratio, market-relative, sector-relative
  └─────┬──────┘
        │
  ┌─────▼──────┐   engine/          Σ(weight × contribution) ÷ available weight
  │ MEANINGFUL │   score.js         absolute level thresholds, level floor
  │   CHANGE   │
  │   SCORE    │
  └─────┬──────┘
        │
  ┌─────▼──────┐   engine/          observation × freshness × depth × coverage
  │ CONFIDENCE │   score.js         kept separate from the score, never merged
  └─────┬──────┘   freshness.js
        │
  ┌─────▼──────┐   engine/          score, then confidence, then symbol —
  │  RANKING   │   index.js         never raw percentage change
  └─────┬──────┘
        │
        ├──────────────────────────────┬─────────────────────────────┐
        │                              │                             │
  ┌─────▼──────┐              ┌────────▼────────┐          ┌─────────▼─────────┐
  │   ALERTS   │              │       UI        │          │  EXPLANATION      │
  │ alerts.js  │              │  api.js →       │          │  reasons.js       │
  │ alert-     │              │  frontend/      │          │  alert-           │
  │  rules.js  │              │                 │          │   diagnostics.js  │
  │ crossing   │              │  chart.js       │          │  deterministic    │
  │ edges,     │              │  intraday.js    │          │  templates over   │
  │ hysteresis │              │  summary.js     │          │  computed values  │
  └────────────┘              └─────────────────┘          └───────────────────┘
```

```
backend/src/
  symbols.js            one definition of "which instrument is this"
  config.js             every knob, with the reasoning attached
  db.js                 schema; append-only enforced by triggers
  snapshot-log.js       the only reader/writer of observations
  watchlist.js          add / remove / list / markViewed
  freshness.js          old vs stale, and source conflicts
  ingest.js             poll loop + boot backfill
  delta.js              the raw since-viewed diff (pre-engine path)
  summary.js            "since you were away"
  chart.js              the chart series: two ranges, high/low, marker
  intraday.js           session analysis — its own window, never borrowed
  alerts.js             definitions, the crossing state machine, events
  alert-rules.js        one definition of each rule, shared by the two below
  alert-diagnostics.js  why an alert did or did not fire
  api.js                HTTP surface, validation, bounds
  server.js             wiring and lifecycle
  engine/
    numeric.js          every arithmetic hazard, in one place
    returns.js          bar resampling, rolling statistics
    features.js         the five measurements, no decisions
    score.js            weighting, renormalisation, levels, confidence
    reasons.js          deterministic explanation templates
    surfaced.js         fingerprints and the "already shown" store
    index.js            orchestration, batching, memoisation, ranking
  sources/
    index.js            the DataSource interface
    noise.js            deterministic, O(1)-addressable pseudo-randomness
    simulator.js        synthetic market with a shared market factor
    yahoo.js            real NSE/BSE via raw fetch
  demo/
    fixture.js          the reproducible fixture
    scenarios.js        the six named market conditions
    seed.js             npm run demo

frontend/                plain ES modules, no framework, no build step
  index.html  app.js  panels.js  chart.js  styles.css
  sensitivity.js        the display threshold - no DOM, so it is testable
```

---

## Decisions, and why

Each of these is a place where a reasonable person would have chosen otherwise.
The reason matters more than the choice.

### No ML library

The anomaly detection is rolling mean and standard deviation.

- **Deterministic.** Same inputs, byte-identical output. An Isolation Forest's
  `random_state` would make that guarantee someone else's to keep.
- **Unit-testable.** Every branch has a test, including the divide-by-zero.
- **Dependency-free.** Two runtime dependencies total.
- **Explainable line by line** to a user who asks "why did you show me this" —
  which a tree ensemble's feature importances are not.

On this data — one instrument's own recent return distribution — a learned
anomaly detector would score no better than a z-score, and could not be
justified to the person reading the row.

### No LLM in the numeric path, and none in the explanations

**Explanations are deterministic templates.** An LLM could produce a fluent,
plausible reason the data does not support. `"Price moved +2.1% while the market
moved +0.4%"` is a report of two numbers we hold. `"Rose on positive earnings
sentiment"` is a causal claim this system has no instrument for, and is
forbidden regardless of how likely it is.

Reasons are also **gated on evidence thresholds**: a 0.1-sigma move is not
described as "unusually large", and a ratio of 1.02 is not "high volume". The
contribution still counts toward the score; only the claim is withheld.
Overstating one line costs trust in every other.

> **If an LLM were added later** it could only ever be a *phrasing* layer over
> these computed values, with the numbers passed through verbatim, a closed
> vocabulary that cannot introduce causes, and a validator asserting every figure
> in the output appears in the features. It must never decide a level.

### No recommendations, predictions, or buy/sell/hold

The product says "deserves attention". Never "buy", "sell", "will rise", or a
price target; no personalised recommendations, no forecasts, no targets. Every
pattern is past-tense.

This is not timidity about scope. A tool that ranks *attention* is making a
claim it can defend from data it holds. A tool that says "buy" is making a claim
about the future, about the user's finances and about their risk tolerance,
none of which this system measures. A test scans all generated text for that
vocabulary, so the boundary is enforced rather than merely intended.

### Absolute thresholds, not percentile ranking

Covered above under [Levels](#levels) — a percentile label describes your
watchlist rather than the instrument, and makes every level unstable under an
unrelated add.

### No gamification

No streaks, badges, leaderboards or "you've checked 5 days in a row". The
product's value is that it lets you look *less often* — engagement mechanics
would be working directly against the thesis, and in a financial context they
push people to trade for the app's benefit rather than their own.

### The anomaly horizon is fixed, not the length of your absence

The z-score measures a **15-minute** return against that stock's own
distribution of 15-minute returns. Z-scoring the return over exactly the user's
absence would be more literally on-thesis, and was rejected because:

- The anomaly should be a property of the **stock**, not of when you logged in.
  Otherwise two users see different z-scores for the same instrument at the same
  instant.
- A first visit has no absence window at all, so the signal would be unavailable
  precisely when a user most needs orientation.
- The surfaced-signal fingerprint would become user-relative and stop being
  comparable.

Your personal horizon is fully represented — it is the headline number on every
row, and the leading line of every explanation.

**Known statistical caveat:** the 15-minute windows overlap (one return ending at
every bar), so the samples are autocorrelated. The standard-deviation estimate is
still sound but its own standard error is larger than the raw count suggests.
Non-overlapping windows would leave ~24 samples over a six-hour window — too few
to estimate a spread from at all.

### The simulator has a market factor

Every symbol used to be an independent noise field, which made "the whole market
moved together" **impossible to generate** — and therefore made the
market-relative and sector-relative signals impossible to demonstrate on a
weekend. Returns now decompose the way real ones do:

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

### Already-surfaced state is keyed on the event, not the score

A change the user has already been shown is not a discovery. Without
persistence, a restart turns every ongoing move back into breaking news.

The fingerprint identifies the **event**: symbol, level, sorted reason codes,
direction, a 1% magnitude bucket, and the viewing epoch. Keying on the score
would refire every tick; keying on the symbol alone would never refire, so a
move growing from 2% to 9% would stay silent. Pressing "Mark seen" starts a new
epoch, so after the user explicitly acknowledges the state, the next change is
legitimately new again.

### The conflict fixture is constructed, and labelled as such

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
conflict path is shown by a **labelled constructed disagreement** on one symbol,
which is the shape a real conflict actually takes. Both are asserted in
[fixture.test.js](backend/test/fixture.test.js).

### The fixture and the demo script are the same artefact

`npm run demo` writes a fixed scenario and prints it, so the demo narration and
the regression baseline cannot drift apart.

| Symbol | Shows |
|---|---|
| `INFY` | **HIGH** — big idiosyncratic move, 5x volume, market flat |
| `SBIN` | **MODERATE** — 2.9x volume on a 0.8% move |
| `TCS` `WIPRO` `HCLTECH` | **LOW**, and INFY's sector peers |
| `HDFCBANK` | Two sources disagreeing 0.9% — the conflict path |
| `RELIANCE` / `RELIANCE.BO` | The **real** NSE/BSE pair, correctly *not* a conflict |
| `ITC` | Missing volume — unavailable, weight renormalised |
| `MARUTI` | Thin history — "not enough observations yet" |

The fixture is a static snapshot, so a fixture database left running will
correctly report every row as `stale` once its newest observation ages past the
tolerance, and scores drift as the anomaly window slides over frozen data. That
is the freshness layer working, not the demo breaking — but it is why the live UI
demo uses the simulator.

---

## Scalability

### What is already the right shape

**The expensive work is per-symbol, not per-user.** Bar resampling, rolling mean
and standard deviation, the price z-score, the volume ratio and the
market-relative comparison are all properties of an *instrument at an instant*.
Ten thousand users watching RELIANCE ask the identical question, and the answer
is identical. On top of that sits a thin per-user layer:

| Per symbol per tick | Per user per request |
|---|---|
| bar grid, rolling μ and σ | `last_viewed_at` lookup → change since viewed |
| price z-score, volume ratio | already-surfaced fingerprint check |
| market-relative excess | ranking of their own rows |
| freshness, source conflict | sector peer group (see below) |

The right-hand column is indexed reads and comparisons — cheap enough that
personalisation costs a lookup rather than a recomputation. That separation is
the load-bearing property for scale, and it is why the four scored signals were
defined as facts about instruments rather than facts about users.

**The sector signal is the deliberate exception.** Peers are drawn from the
user's own holdings, so the sector return is user-relative and cannot be shared.
That was chosen for the reason given [above](#sector-peers-are-your-own-holdings)
— the alternative is polling a dozen instruments nobody asked about — and the
cost is exactly this: one of five features does not amortise across users. With a
real exchange classification feed the peer group becomes fixed and this feature
joins the left-hand column.

**What the code does today.** Per request: one batched history query covering the
whole watchlist plus the benchmark, with every feature derived from that single
result set in memory; results memoised on the log's high-water mark, the config
identity, the clock bucket and the viewing epochs, so the UI's 5-second poll
recomputes nothing when no observation has landed; bar resampling is a single
linear pass with a forward pointer, not a scan per bar.

The memo is a **single slot keyed by user** — correct for one user, and the first
thing to change for many: a per-symbol feature cache with a per-user overlay,
which is the same split the table above already describes.

### The real limit: SQLite has one writer

This is the honest ceiling, and it is not query performance.

`better-sqlite3` is synchronous and in-process. WAL mode is enabled, so readers
never block the writer and the writer never blocks readers — but there is still
**exactly one writer at a time, in one process, against one local file**. Two
app instances cannot share the database over a network, and a second ingestion
process would serialise against the first.

At demo scale this is a feature, not a compromise: no connection pool, no
network round trip per query, microsecond reads, and a database file you can
copy to reproduce a bug exactly. It is genuinely the right choice for a
single-process app tracking tens of symbols for one user.

It fails at three specific points, in this order:

1. **A second app instance.** Horizontal scale-out is impossible while the store
   is a local file. This binds long before write throughput does.
2. **Ingestion width.** One writer polling thousands of symbols on a 15-second
   tick becomes a serial bottleneck — not because SQLite is slow, but because
   the fan-out has nowhere to go.
3. **Multi-tenancy.** `last_viewed_at`, `surfaced_signals`, `alerts` and
   `alert_events` are per user; the snapshot log is not. They have opposite
   growth curves and opposite access patterns, and one file has to serve both.

### Migration path

The seams for this were built deliberately, and each step is independent:

1. **Split the writer out.** Ingestion is already the only writer, behind
   `snapshot-log.js` as the only module that touches the table. It becomes a
   single ingestion service; app instances become readers.
2. **Move the log to Postgres or a timeseries store.** `snapshot-log.js` is the
   single seam — the append-only guarantee moves from a SQLite trigger to a
   revoked `UPDATE`/`DELETE` grant, and every reader is unchanged. The
   bitemporal shape (`timestamp`, `ingested_at`) is already what a timeseries
   store wants.
3. **Persist rolling aggregates.** Maintain mean, standard deviation and
   trailing volume per symbol, updated on ingest, turning evaluation into an O(1)
   read per row. Deliberately **not** built now: it introduces a second source of
   truth to reconcile against an append-only log, plus rebuild-on-restart and
   rebuild-on-backfill paths, for no measurable gain at this size.
4. **Shard on user.** Everything personal is already keyed by `user_id`, so the
   sharding boundary exists in the schema. Per-symbol features stay shared, per-user
   state shards — the split the table above describes.
5. **Batch the remaining per-symbol query.** Conflict detection is one query per
   symbol; fine for a dozen rows against an indexed table, needs the same
   batching as the history read at a thousand.

Nothing in the engine changes in any of those steps. It reads features and
returns scores; it does not know where the observations came from.

---

## Known limitations, stated rather than hidden

- **Trading holidays are not modelled.** Market hours are weekday + session
  time. A hardcoded 2026 NSE holiday list would be invented data; on a holiday
  the app reports "open" and will call a correctly-unchanging price stale.
- **Overlapping return windows** are autocorrelated (above).
- **Yahoo is an unofficial endpoint**, and its `regularMarketVolume` fallback is
  day-cumulative rather than per-interval — which is why volume is reported as a
  ratio and why that fallback lowers confidence.
- **One hardcoded dev user.** Every query is already scoped by `user_id`; there
  is no authentication.
- **Conflict detection is one query per symbol** — fine for a dozen rows against
  an indexed table, would need batching at a thousand.
- **Sector map is static and small** (16 symbols). A real product takes this from
  an exchange classification feed.

## Considered and deferred

These were designed, costed, and left out. Each is genuinely valuable; each was
deferred for a reason stronger than "no time", and an unfinished feature is
worse than a missing one.

### 52-week high/low proximity

Genuinely valuable — a stock close to its yearly high or low can deserve
attention even when today's movement alone does not score highly.

But the snapshot log holds hours, not a year. Doing it properly needs
source-level yearly range data, a per-symbol cache, a refresh policy, simulator
support, seeded scenarios and extra validation. **That is a data-sourcing
change, not a UI feature**, and it would arrive shallow if rushed.

### Opening gap detection

A meaningful opening gap needs a previous session close, a current session open,
and session-boundary awareness. The simulator runs continuously and models no
session — that is precisely why it can be demoed while NSE is shut. Adding gaps
for live data only would make the app behave differently in live and
deterministic modes, which costs the demo its reproducibility.

### CUSUM change-point detection

Interesting because it answers a *different* question — "did this stock's regime
change?" rather than "was this move unusual?". But it would alter the
statistical signal layer, need parameter tuning, scenario design and validation,
could change scoring behaviour, and would widen the test surface — on a build
that is finished and green.

### Event classification (shock / continuation / reversal)

Depends on the deferred change-point work above, and expands its scope.

### Post-event behaviour tracking

Whether an event continued, reversed or normalised depends on event
classification, and adds temporal logic on top of it.

### Volatility as a scored signal

Volatility relative to a prior window is already computed and shown in the
intraday panel. Promoting it into the *weighted* meaningful-change score is a
different matter: new weights, a renormalisation review, new scenarios and
extensive regression tests. It stays a reported metric, not a scored signal.

### A runtime data-mode toggle

Source selection stays configuration: `DATA_SOURCE=yahoo npm start`. A UI
switch would mean changing sources while ingestion is running, mid-flight, with
two sources' freshness semantics and conflict handling interleaved in one log.

### Multi-provider live fallback

The `DataSource` abstraction would take a second live provider cleanly, which is
exactly why it is tempting. But a second provider expands source
reconciliation, conflict handling, freshness semantics, testing and failure
modes all at once — and the existing conflict path already demonstrates the
interesting part of that problem.

## Deliberately out of scope

LLM integration, stock discovery or recommendations, gamification,
authentication, a chatbot, price prediction.

Price charts, intraday analysis and alerts were on this list during P0 and have
since been scoped in deliberately. Everything still listed above remains out,
and the scoring engine is still the submission.
