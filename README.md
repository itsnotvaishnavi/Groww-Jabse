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

So the unit here is not a day — it's **your** last visit. Every user has a
`last_viewed_at` per symbol, and what changed is the diff between the snapshot
they could have seen then and the newest one now. That makes the comparison
window personal, and it makes it honest: both ends of the diff are real logged
observations with timestamps you can inspect.

## Run it

```bash
npm install
npm start                 # http://localhost:3000
npm test                  # 29 tests, no network or filesystem needed
```

Requires Node 22+ (developed on 24). No API keys, no configuration, no
migration step — the schema is created on first boot and the watchlist is
seeded so the page isn't empty.

Against real NSE/BSE prices instead of the simulator:

```bash
DATA_SOURCE=yahoo npm start
```

## What's built

| # | Piece | Where |
|---|-------|-------|
| 1 | Append-only snapshot log | [db.js](backend/src/db.js), [snapshot-log.js](backend/src/snapshot-log.js) |
| 2 | Deterministic market simulator | [sources/simulator.js](backend/src/sources/simulator.js), [sources/noise.js](backend/src/sources/noise.js) |
| 3 | Watchlist CRUD | [watchlist.js](backend/src/watchlist.js) |
| 4 | Real NSE/BSE source, same interface | [sources/yahoo.js](backend/src/sources/yahoo.js) |
| 5 | Staleness & conflict handling | [freshness.js](backend/src/freshness.js) |
| — | The per-user delta | [delta.js](backend/src/delta.js) |
| — | Ingestion loop & boot backfill | [ingest.js](backend/src/ingest.js) |
| — | HTTP API and UI | [api.js](backend/src/api.js), [frontend/](frontend/) |

---

## Design decisions worth defending

### The log is append-only, and SQLite enforces it

`snapshots` has `BEFORE UPDATE` and `BEFORE DELETE` triggers that `RAISE(ABORT)`.
Event sourcing that relies on everyone remembering not to write `UPDATE` isn't
an invariant, it's a hope. A price a user has already seen can never be quietly
rewritten — the cost being that resetting means deleting the database file.

It stores **two timestamps**, which is the detail that makes the whole product
honest:

- `timestamp` — the instant the price is *about*, as attributed by the source
- `ingested_at` — the instant we *learned* it

A delayed feed makes these differ by 15–20 minutes. Collapsing them into one
column would destroy any ability to tell the user how fresh a number really is.

Append-only doesn't mean append-duplicates: a `UNIQUE(symbol, timestamp, source,
price)` index plus `INSERT OR IGNORE` collapses a source restating the same fact.
`price` is part of that key on purpose — a *different* price for an instant
already reported is a correction, and both halves of a correction are worth
keeping.

### The simulator is not a fallback — it came first

The build window is mostly a weekend. NSE and BSE are shut, real prices don't
move, and an app whose entire premise is "what changed" would have nothing to
show for 62 of its 72 hours. So the simulator was built before any real API and
the real feed was fitted to its interface, not the other way round.

**It's a noise field, not a random walk.** The obvious approach —
`price[i] = price[i-1] + noise()` — is replayable but *sequential*: pricing tick
40,000 means generating the 39,999 before it. That makes `getSnapshotAt` either
slow or a lie. Instead every quantity is a pure function of
`(seed, symbol, tick)`: hashed lattice points, quintic-smoothed, summed over
five octaves. The result is a fractal curve that looks like a price chart, is
bit-identical for a given seed, and is **O(1) addressable at any instant** —
there's a test asserting a price ten years back returns in under 50ms.

It also **fails on purpose**: ~3% of ticks are dropped and ~2% of ten-minute
blocks go dark entirely. A source that never breaks can't demonstrate that the
staleness handling works.

`test/simulator.test.js` pins the output to a **golden fingerprint**
(`e85f744cf29c017c`). If a refactor changes the simulated market — even
self-consistently — that assertion fails, because the demoed history is a
contract.

### "Old" and "stale" are not the same thing

This is the part most watchlists get wrong. On Sunday afternoon the newest real
quote for RELIANCE is Friday 15:30 IST, and that is *correct* — it's the last
traded price. Flagging it stale for 62 straight hours is crying wolf. But a
price from four minutes ago during a live session, when we poll every fifteen
seconds, is genuinely broken.

So the threshold is a function of the source's own delay and the exchange
calendar, producing five distinct states:

| State | Meaning |
|---|---|
| `live` | As current as the source can be |
| `delayed` | Within the source's own stated delay window |
| `market_closed` | Exchange shut; the last traded price is the right answer |
| `stale` | The source should have given us something newer and didn't |
| `no_data` | We have never observed this symbol |

Note the case that survives: if the newest snapshot predates the *last open
session*, the feed was broken while the market was trading — so it reports
`stale` even on a Sunday.

### `getSnapshotAt` is on the source, not just the log

It would have been defensible to keep only `getLatestSnapshot` on the source and
answer every historical question from the log, on the grounds that a log can only
know what it observed. Both are on the interface because both sources genuinely
can answer "what was the price at time T", and because a fresh clone otherwise
has no past to diff against — the product's core feature would be dead until
enough wall-clock time had passed. On boot, [ingest.js](backend/src/ingest.js)
asks the source to describe the recent past and records it.

The two are not redundant, and the distinction is load-bearing:

- `source.getSnapshotAt(T)` — what the market *was*, reconstructed on demand
- `log.asOf(T)` — what this app *observed*, and the only thing user baselines
  are computed from, because "since I last looked" must diff against what the
  user could actually have seen

### Confidence is a 0–1 score with a stated meaning

It answers *"how accurately does this row reflect what the named source
reported for that instant"* — not "is this data realistic".

| Value | Case |
|---|---|
| `1.0` | Simulator: evaluated exactly, no delay, no transport |
| `0.85` | Yahoo historical candle: settled, no longer subject to delay |
| `0.6` | Yahoo latest quote: delayed, unofficial endpoint |
| `×0.7` | Penalty when the matched candle isn't near the instant asked for |

That the simulator is synthetic is communicated by `source`, not by a deflated
confidence. A delta inherits the **weaker** of its two ends: diffing a confident
price against a shaky one produces a shaky difference.

### Sources that disagree are reported, not silently resolved

Two sources describing the same instant more than 0.5% apart is a conflict, and
the UI shows both numbers with their sources. The higher-confidence side is
*offered* as the one to believe; when confidence ties, neither is promoted.
Picking a winner is not the same as hiding the argument.

This isn't hypothetical: switch `DATA_SOURCE` from simulator to yahoo and the
log holds two series describing the same minutes at very different prices.

### The UI never shows a price without its provenance

Every row carries the freshness pill, the observation's age, its source and its
confidence. Any row expands to reveal the raw log rows behind the number —
timestamps, volumes, and when each was recorded. The brief asked for change to
be explainable and never a black box, so every figure on screen is traceable to
a logged observation.

`last_viewed_at` is stamped by an explicit "Mark seen" action, **not** as a side
effect of loading the list. If fetching the page reset the baseline, the deltas
would erase themselves on first render and could never be revisited.

---

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness only — touches no database or upstream |
| `GET` | `/ready` | Readiness: per-symbol freshness, `503` if nothing is fresh |
| `GET` | `/api/meta` | Active source, config, market state, ingestion health |
| `GET` | `/api/symbols` | Suggestion list for the add box |
| `GET` | `/api/watchlist` | Rows with latest snapshot, freshness, delta, conflicts |
| `POST` | `/api/watchlist` | Add a symbol (`201` new, `200` already present) |
| `DELETE` | `/api/watchlist/:symbol` | Remove a symbol (history is kept) |
| `POST` | `/api/watchlist/:symbol/viewed` | Stamp "I have now seen this" |
| `GET` | `/api/snapshots/:symbol` | Raw log — the audit trail behind any number |
| `POST` | `/api/ingest/tick` | Force a poll now (demo affordance) |

## Configuration

Every knob lives in [config.js](backend/src/config.js) and nothing else reads
`process.env`.

| Variable | Default | Notes |
|---|---|---|
| `DATA_SOURCE` | `simulator` | `simulator` \| `yahoo` |
| `PORT` | `3000` | |
| `DB_PATH` | `data/watchlist.sqlite` | Gitignored; regenerable |
| `SIM_SEED` | `groww-code-2026` | Same seed ⇒ same market, exactly |
| `INGEST_INTERVAL_MS` | `15000` sim / `60000` yahoo | Real feed is polled slower on purpose: it publishes nothing new faster than that |
| `BACKFILL_HOURS` | `6` | History reconstructed on boot |
| `STALENESS_INTERVALS` | `3` | Missed polls tolerated before "stale" |
| `CONFLICT_TOLERANCE_PCT` | `0.5` | Below this, disagreement is rounding |
| `SIM_GAP_PROBABILITY` | `0.03` | Set `0` for a clean demo |
| `SIM_OUTAGE_PROBABILITY` | `0.02` | Set `0` for a clean demo |
| `INGEST_ENABLED` | `true` | `false` to inspect the log without writes |

## Tests

```bash
npm test    # 29 tests
```

No network, no filesystem, no uncontrolled clock: every test runs against an
in-memory SQLite database, a stub source, and fixed timestamps. They assert the
*guarantees* rather than the behaviour — that history can't be rewritten even by
raw SQL, that a seconds-vs-milliseconds timestamp is refused, that one broken
symbol doesn't stop the others, that a weekend price isn't reported as stale,
and that the simulated market still matches its golden fingerprint.

---

## Known limitations, stated rather than hidden

- **Trading holidays are not modelled.** Market hours are weekday + session
  time. A hardcoded 2026 NSE holiday list would be invented data, and being
  wrong about it is worse than admitting the gap — so on a holiday the app
  reports "open" and will call a correctly-unchanging price stale. A real
  exchange calendar is the fix.
- **Yahoo is an unofficial endpoint** with no uptime or accuracy promise, and
  its nominal 15–20 minute delay is treated as a tolerance bound rather than a
  measured fact. Its `regularMarketVolume` fallback is day-cumulative rather
  than per-interval, which is why volume is reported as a ratio and why that
  fallback lowers confidence.
- **One hardcoded dev user**, per the brief. Every query is already scoped by
  `user_id`, so adding real auth means populating it from a session rather than
  reshaping the schema.
- **Conflict detection runs one query per symbol.** Fine for a watchlist of a
  dozen rows against an indexed table; it would need batching at a thousand.

## Deliberately not built yet

The **Meaningful Change scoring engine** — z-scores, sector-relative moves,
volume anomaly detection, ranking by relevance. That's the next phase, and
building it before the data backbone was solid would have meant tuning a formula
on top of a log I couldn't yet trust.

What's here instead is the raw, checkable difference: two timestamped
observations and the gap between them, where a user could verify every number by
hand. That's the standard the scoring layer will have to meet too — the brief's
requirement is a transparent, explainable formula, never a black box, and this
is the substrate that makes such a formula auditable.

The client can sort by "biggest change since you looked", which is a sort over
the raw delta — deliberately not a relevance score. Ranking by meaningfulness
needs to account for volatility, sector and volume before it deserves to be a
default.
