# mongobot

[![ci](https://github.com/Hamelyn-SL/mongobot/actions/workflows/ci.yml/badge.svg)](https://github.com/Hamelyn-SL/mongobot/actions/workflows/ci.yml)

In-database observability for MongoDB — a [pgbot](https://github.com/pgrundev/pgbot) for Mongo.

One read-only CLI connects to your cluster, reads MongoDB's **own counters**
(`serverStatus`, `$queryStats`, `$indexStats`, `$collStats`, `top`,
`replSetGetStatus`) and prints a findings-first health report — plus what
changed since last time. No agent, no telemetry stack, no separate database.
Findings are deterministic: computed from counters with explicit thresholds,
no AI guessing.

```
connected · cluster0.abc12.mongodb.net · mongodb 8.3.8 · db Shop · read-only · baseline 42m ago
atlas Cluster0 · M50 · disk 52% · cpu 57% · advisor 3 suggestions

Database health: 61/100

WARNING
● aggregate products [$match{type,active}, $project, $facet] averages 341ms over 250.6k calls
  examines 8.6k docs per doc returned
● find reviews {status, retryPolicy, errorType} sort {updatedAt} examines 49.2k docs per doc returned
  likely missing or unusable index on Shop.reviews
● Atlas Performance Advisor suggests index {"status":1,"updatedAt":1,"errorType":1} on Shop.reviews
  ↳ matches the expensive $queryStats shape: find reviews {status, retryPolicy, errorType} (1.45s mean)
  would serve 2 slow query shapes averaging 2.72s

GOOD
● connections 27.2% used (4356/16.0k)
● cache hit ratio 99.9%
● replication healthy, lag 1s (3 members)
● oplog window 9d7h
● disk 52% of 874GB used
```

## Quickstart

```bash
git clone https://github.com/Hamelyn-SL/mongobot && cd mongobot
npm install

export MONGO_URL="mongodb+srv://monitor_user:…@cluster.mongodb.net/MyDb"
node src/cli.ts inspect          # Node 22.18+ runs the TypeScript directly
```

Or bundle a single distributable file (needs [Bun](https://bun.sh) as the
bundler only — the runtime is Node):

```bash
npm run build
./dist/mongobot.mjs inspect
```

The connection is taken from the argument, then `$MONGODB_URI`, then
`$MONGO_URL`. Pass it by environment, not as an argument, to keep credentials
out of `ps` and shell history.

## Commands

| Command | What it does |
|---|---|
| `inspect` | findings-first health report: score, CRITICAL / WARNING / NOTE, then a GOOD list naming what it verified (default) |
| `queries` | top query shapes by total execution time, from `$queryStats` — with each shape's share and docs-examined-per-doc-returned |
| `collections` | largest collections: on-disk size, docs, fragmentation (reclaimable %), index weight, cumulative op time |
| `indexes` | indexes with zero reads on this node, by size — and the caveat that matters before dropping anything |
| `advise` | Atlas Performance Advisor suggestions crossed with `$queryStats`, slow namespaces, cluster events |
| `why` | explain regressions since the local baseline: symptom ← mechanism ← antecedent, with numbers and confidence |
| `snapshot` | store a baseline snapshot and exit (cron it for better `why` windows) |

Flags: `--db <name>`, `--json` (versioned contract, PII-free), `--limit <n>`,
`--fail-on critical|warn|none`, `--no-store`, `--no-color`, `--version`.

Exit codes: `0` clean · `1` warning · `2` critical · `3` connection failure · `64` usage.

## It remembers

Every `inspect`/`snapshot` writes a compact local baseline under
`$XDG_STATE_HOME/mongobot/<host>-<db>/` (default `~/.local/state/mongobot/`).
From the second mature run on, mongobot reports **regressions**: a query shape
that got slower (window mean vs baseline mean), collection scans surging,
a collection that grew, an index that stopped being read — each as a causal
chain with a confidence figure:

```
aggregate products [$match{type,active}, $project, $facet] slowed 3.1× — 192ms → 587ms/call
↳ because it now examines 29.8k docs per doc returned (was 8.5k)
↳ after products grew 12% (26.8M → 30.1M docs)
↳ confidence 85%
```

Baselines younger than 10 minutes are treated as a cold window: counter noise,
not signal — regressions are suppressed until the window matures. Query-shape
variants aggregate by their logical shape, and regressions are ranked by how
much execution time they actually added in the window.

## Atlas layer (optional)

Everything above needs only the MongoDB connection. If the cluster lives in
Atlas, mongobot can **additionally** speak the Atlas Admin API and fold in what
the server itself cannot tell you — host CPU and data-disk usage, Performance
Advisor index suggestions (cross-referenced against the expensive `$queryStats`
shapes), slow namespaces, and cluster events (elections, restarts, metric-
threshold alerts) which also feed `why` as causal antecedents.

```bash
# service account (recommended):
export ATLAS_CLIENT_ID=mdb_sa_id_…
export ATLAS_CLIENT_SECRET=mdb_sa_sk_…
# or a classic API key pair (HTTP digest):
export ATLAS_PUBLIC_KEY=… ATLAS_PRIVATE_KEY=…
# optional; skips project discovery:
export ATLAS_PROJECT_ID=<groupId>

mongobot inspect    # header gains: atlas <cluster> · M50 · disk 52% · cpu 57% · advisor N suggestions
mongobot advise     # Performance Advisor suggestions crossed with $queryStats + slow namespaces + events
```

Grant the service account or key **Project Read Only** — mongobot only ever
GETs. Without credentials the layer is off and mongobot says so in one dim
line; individual Atlas collectors that fail degrade the same way (`partial
collectors: …`). A project can host several clusters: mongobot matches
processes to the cluster your SRV URI resolves to, so metrics never mix
environments.

## Read-only, by role

mongobot only ever issues diagnostic commands. The guarantee should be the
user's role, not this tool's behavior: run it as a user holding
`clusterMonitor` (for `serverStatus`, `top`, `$indexStats`, `$queryStats`,
replication state) plus `readAnyDatabase`. On Atlas:

```bash
atlas dbusers create --username mongobot_ro \
  --role clusterMonitor@admin,readAnyDatabase@admin
```

Without those roles mongobot degrades rather than fails: it reports what it
can see (`$collStats`, sizes, fragmentation, topology) and prints exactly
which role is missing.

A full run issues a few hundred cheap metadata commands (two `serverStatus`
samples 1s apart, one `$collStats`/`$indexStats` per collection batched
8-wide, one `$queryStats` scan capped at 500 shapes) and finishes in seconds.
Query shapes from `$queryStats` arrive already anonymized (values replaced by
type markers), so reports are PII-free by construction. mongobot identifies
itself as `appName=mongobot` and excludes its own operations from what it
reports.

## Caveats worth knowing

- `$indexStats` and `top` are **per-node** counters since that node's restart:
  an index unused on the primary may still serve a secondary or a monthly job.
  mongobot says so on every such finding instead of letting you drop it.
- `$queryStats` needs MongoDB 7.0+ (8.0+ for docs/keys-examined metrics).
- Unused-index analysis waits until the node has 24h of counters — a fresh
  restart would make every index look unused.
- Host metrics (CPU, disk, IOPS) live in Atlas/your provider, not in MongoDB —
  that is exactly what the optional Atlas layer is for.

## Requirements

Node 22.18+ (runs TypeScript directly). Only runtime dependency: the official
`mongodb` driver. Bun is used as the bundler for the optional single-file
build.

## License

MIT
