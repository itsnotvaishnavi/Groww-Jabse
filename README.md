# Jabse

**जब से** (*jab se*) means “since”. Jabse is a watchlist that answers:

> **What meaningfully changed since I last looked?**

It compares each stock with the last observation available when the user
explicitly opened that stock, then explains what deserves attention. It is not
a screener, trading tool, forecast, or investment recommendation.

Built for Groww Code 2026. Node 22+, Express, SQLite, vanilla ES modules, and
no frontend build step.

## What It Solves

Most watchlists show today’s percentage change. That loses the user’s actual
context:

- “Today” may not be the period since the user last checked.
- A large move can be normal for a volatile stock.
- A small move can matter when volume is unusual or peers are quiet.
- A market-wide move is different from stock-specific news.

Jabse makes the user’s own viewing history the comparison boundary. It surfaces
what changed while they were away, ranks meaningfulness rather than raw
volatility, and shows the evidence behind each result.

## Product

- **Since you last looked:** the primary watchlist question and headline.
- **Opening a stock means seeing it:** opening a detail view records that
  stock’s `last_viewed_at` baseline. Rendering, scrolling, polling, hovering,
  ticker display, and preloading do not.
- **Attention grouping:** Needs attention, Meaningful changes, Stable, and No
  baseline yet.
- **Evidence-based explanations:** concise “Why this matters” text comes from
  the deterministic engine.
- **Compact trend sparklines:** existing 1D chart data rendered inline in each
  row, with no axes or extra metrics.
- **Stock detail:** clean price, since-viewed change, chart, reasons, related
  news, intraday analysis, and alerts.
- **Broad search:** local/cached NSE/BSE equity-catalogue search with ticker,
  company, exchange, series, and canonical symbol identity. Only selected
  results enter the watchlist and monitoring path.
- **You might want to watch:** at most four discovery candidates based on the
  user’s followed sectors and existing engine activity.
- **Latest News:** optional supporting context, never part of the score.
- **Optional contextual AI:** short explanations only for attention-worthy
  moves when relevant verified news exists. AI never decides importance.

## What Makes It Different

A normal watchlist answers “what moved today?” by sorting percentages.

Jabse answers “what changed for me since my last visit?” It combines a
personal baseline with stock-specific, volume, market-relative, and
sector-relative evidence. A stock is not surfaced merely because it is the
biggest mover, and a market move is not automatically treated as stock news.

## Meaningful Change Engine

The backend engine is the source of truth. The browser renders its output and
does not recompute scores or thresholds.

Four scored signals are evaluated independently:

- **Price anomaly:** is the recent move unusual for this stock?
- **Volume anomaly:** is current activity higher than normal?
- **Market-relative:** did the stock move more or less than the benchmark?
- **Sector-relative:** did it move more or less than watched peers?

The separate **change since viewed** value is the user’s personal frame of
reference. It leads the explanation but is not averaged into the score.

Available signals are weighted and renormalised. Missing data is unavailable,
not silently treated as zero. The result includes:

- A meaningfulness score from 0 to 1.
- Absolute `LOW`, `MODERATE`, or `HIGH` levels.
- Confidence, calculated separately from meaningfulness.
- `needsAttention`, the single attention verdict used by the summary and UI.
- Deterministic reason codes and human-readable reason text.

Relative signals cannot promote a stock above `LOW` when its own movement and
user-visible change are negligible. This prevents market context from being
mistaken for stock-specific news.

## Data Reliability

- Freshness is explicit: `live`, `delayed`, `market_closed`, `stale`, or
  `no_data`.
- Every observation keeps both the source-attributed timestamp and ingestion
  time, so delayed data is distinguishable from a broken feed.
- Snapshots are append-only. Historical observations are never rewritten.
- Missing observations, missing volume, thin history, and unavailable sector
  peers remain explicit and affect availability/confidence honestly.
- Returns use a fixed bar grid with bounded carry-forward, so gaps do not become
  artificial flat periods or straight lines through outages.
- The simulator is deterministic: the same seed, symbol, and instant produce
  the same observation.
- The engine accepts an injected clock in tests, making fixed-input output
  reproducible.

## Viewing Baseline

A new watchlist entry starts with no baseline. Adding a stock does not mark it
seen.

When the user explicitly opens its detail view, the frontend calls the existing
`POST /api/watchlist/:symbol/viewed` endpoint. The backend stores the current
viewing time in `last_viewed_at`; the engine compares future observations with
the latest logged observation at or before that time.

The page does not mark every visible row. Opening TCS marks only TCS. Opening
another stock later establishes or advances only that stock’s baseline.

## News & AI

News is supporting context below the meaningful-change experience. The app
shows provider-supplied source, headline, publication time, associated symbol
when reliable, and a link when available. It does not invent headlines,
timestamps, sources, or company associations.

The optional explanation layer receives compact structured evidence from the
engine and filtered related news. It is not involved in ranking or scoring.

AI is invoked only for an attention-worthy move with significant relevant news.
Without that context, Jabse shows at most two concise deterministic evidence
lines and does not force an AI explanation. If the provider fails, the normal
Jabse evidence and watchlist continue working.

Configure the optional OpenAI-compatible provider with `AI_API_KEY`, plus
optional `AI_ENDPOINT` and `AI_MODEL`. The core app works without them.

## Discovery

**You might want to watch** is a bounded discovery surface, not a
recommendation engine. It:

1. Starts with the active source’s known universe.
2. Removes symbols already in the user’s watchlist.
3. Excludes stale, closed, missing, or insufficient data.
4. Reuses the existing engine’s attention verdict and reasons.
5. Prefers candidates sharing sectors with watched stocks.
6. Ranks followed-sector relevance before existing meaningfulness.

The simulator remains offline and deterministic. Yahoo can use its broader
search/discovery endpoint. Adding a suggestion uses the existing watchlist API
and does not establish a viewing baseline; opening it does.

If no candidate meets the requirements, the UI says **“Nothing new stands out
right now.”**

## Architecture

```text
Data Sources
    -> Ingestion and backfill
    -> Append-only SQLite snapshot log
    -> Fixed bars and feature extraction
    -> Meaningful Change Engine
    -> Ranking, summary, alerts, discovery
    -> Express API
    -> Vanilla frontend
```

### Backend

- `sources/`: common source interface with deterministic simulator and Yahoo
  adapter.
- `ingest.js`: polling, backfill, absence/failure handling, and alert hook.
- `snapshot-log.js` and `db.js`: validated immutable observations and SQLite
  schema.
- `engine/`: bars, features, numeric safety, score, confidence, reasons, and
  surfaced-event history.
- `watchlist.js`, `summary.js`, `alerts.js`: user baselines, return summary,
  caught-up state, and alert hysteresis.
- `chart.js`, `intraday.js`, `news.js`, `discovery.js`: additive presentation
  services that do not alter engine decisions.
- `catalogue.js`: cached reference instrument catalogue used only for local
  search; it is separate from watchlist and snapshot storage.
- `api.js`: dependency-injected HTTP contract.

### Frontend

Vanilla ES modules keep the application small and transparent:

- `app.js`: polling, filters, grouping, watchlist rendering, and actions.
- `chart.js` and `sparkline.js`: chart and compact trend rendering.
- `panels.js`: intraday analysis and alerts.
- `search.js`, `discovery.js`, `news.js`, `explanation.js`: isolated additive
  product surfaces.
- `sensitivity.js`: display-only sensitivity mapping.
- `styles.css`: responsive visual system.

Expanded details and news are cached by symbol. Market polling updates the
watchlist without remounting the expanded detail or refetching news every
cycle.

## Key Engineering Decisions

1. **Personal baselines are explicit.** Only opening a stock advances its
   viewing epoch; page reads never erase the comparison users came to inspect.
2. **The engine is deterministic and explainable.** A weighted statistical
   model is easier to test and audit than an opaque model for this product.
3. **Missing is not zero.** Unavailable signals are removed from the available
   weight and remain visible in advanced analysis.
4. **Score and confidence are separate.** A meaningful event can still be
   based on stale or thin data, and users should see both facts.
5. **Source identity is canonical at boundaries.** NSE, BSE, and global
   symbols do not accidentally merge histories or market prices.
6. **News and AI are outside the decision path.** They add context only and
   cannot change scores, levels, ranking, alerts, or baselines.
7. **Progressive disclosure protects both audiences.** Normal users see a
   short answer; judges can open analysis details and the raw audit trail.

## Demo Scenarios

The deterministic demo fixture supports:

| Scenario | Demonstrates |
|---|---|
| `normal` | Quiet tape and LOW results |
| `high_volume` | MODERATE from unusual turnover on a modest move |
| `stock_outperforms` | Stock-specific movement with market and sector context |
| `market_wide` | Broad movement that relative signals correctly deflate |
| `data_delay` | Stale data, reduced confidence, and blocked alerts |
| `source_conflict` | Conflicting observations reported rather than hidden |

Time-away controls in the UI are demo overrides for the summary experience;
they do not alter stored baselines or market history.

## Setup

```bash
npm install
npm start                         # http://localhost:3000
npm test
npm run demo
npm run demo -- stock_outperforms 6h
```

Requires Node 22+. The default source is the deterministic simulator:

```bash
DATA_SOURCE=simulator npm start
DATA_SOURCE=yahoo npm start
```

Useful demo overrides:

```bash
INGEST_ENABLED=false npm start
SIM_SEED=another-seed npm start
BACKFILL_HOURS=6 npm start
```

## API Overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/api/watchlist` | Ranked engine results and evidence |
| `GET` | `/api/summary` | Since-you-were-away summary |
| `GET` | `/api/chart/:symbol` | Chart data for `since_viewed` or `1d` |
| `GET` | `/api/intraday/:symbol` | Intraday analysis |
| `GET` | `/api/symbols/search?q=` | Local/cached NSE/BSE equity catalogue search |
| `GET` | `/api/discovery` | Watchlist discovery candidates |
| `GET` | `/api/news?symbol=` | Supporting news context |
| `GET` | `/api/explanation/:symbol` | Optional contextual explanation |
| `POST` | `/api/watchlist` | Add a canonical symbol |
| `POST` | `/api/watchlist/:symbol/viewed` | Record an explicitly opened stock |
| `GET` | `/api/alerts` | Alert definitions |
| `GET` | `/api/meta` | Source and pipeline status |

Existing response contracts remain intact; additive surfaces do not replace
the engine fields consumed by the current UI and tests.

## Testing

Run the full suite with:

```bash
npm test
```

The current suite contains **243 tests** covering:

- engine scoring, levels, confidence, missing signals, floors, and determinism
- snapshot immutability, canonical symbols, freshness, and ingestion failures
- viewing baselines, summaries, caught-up state, charts, and alerts
- search discovery, provider failure, news isolation, and contextual AI rules
- watchlist discovery ranking, exclusions, baseline safety, and empty states
- sparkline transformation, colors, gaps, and insufficient history
- frontend contracts for progressive disclosure and stable expanded details

## Known Limitations

- Yahoo Finance is an unofficial, delayed endpoint without an uptime guarantee.
- The simulator’s non-featured and cross-market examples are synthetic, not
  real quotes.
- Trading holidays are not modeled separately from weekday exchange hours.
- The sector map is small and static; sector-relative analysis needs enough
  watched peers.
- News quality and availability depend on the provider.
- AI explanations are optional context, not verified causal attribution. The
  UI explicitly says when no confirmed catalyst is identified.
- Authentication is out of scope; the demo uses one development user.

## Submission Pitch

Jabse is a watchlist built around a simple question: **what meaningfully changed
since I last looked?** Instead of sorting today’s percentage movers, it stores a
personal viewing baseline for each stock and compares new observations against
what the user could actually have seen. A deterministic engine combines
stock-specific price and volume anomalies with market and sector context,
confidence, freshness, and evidence-based explanations. Compact charts,
source-aware search, watchlist discovery, alerts, and supporting news make the
result useful without turning it into a screener or trading tool. Optional AI
can summarize verified context, but never decides what matters. The surface is
simple; the reasoning underneath is auditable.
