#!/usr/bin/env node
// mongobot — in-database observability for MongoDB, pgbot-style.
// Read-only: solo comandos de diagnóstico; jamás escribe en la base de datos.
import { connect, missingCapsHint, type Session } from './connect.ts';
import { collectServer } from './collect/server.ts';
import { collectCollections } from './collect/collections.ts';
import { collectIndexes } from './collect/indexes.ts';
import { collectQueries } from './collect/queries.ts';
import { collectRepl } from './collect/repl.ts';
import { collectAtlas, type AtlasInfo } from './collect/atlas.ts';
import { analyze } from './findings.ts';
import { buildSnapshot, saveSnapshot, loadBaseline } from './baseline.ts';
import { renderInspect, renderHeader, toJson, exitCodeFor } from './report.ts';
import { c, humanBytes, humanMs, humanNum, humanDur, padTable, pct, times } from './format.ts';

const VERSION = '0.2.0';

const HELP = `mongobot ${VERSION} — in-database observability for MongoDB

Usage: mongobot <command> [connection-string] [flags]

The connection is taken from the argument, then $MONGODB_URI, then $MONGO_URL.

Commands
  inspect      findings-first health report (default)
  queries      top query shapes by total execution time ($queryStats)
  collections  largest collections: size, docs, fragmentation, index weight
  indexes      unused indexes on this node, with sizes and caveats
  advise       Atlas Performance Advisor suggestions crossed with $queryStats
  why          explain regressions since the local baseline
  snapshot     store a baseline snapshot and exit
  help         this text

Atlas layer (optional): set ATLAS_CLIENT_ID/ATLAS_CLIENT_SECRET (service
account) or ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY (API key) to add host CPU and
disk, Performance Advisor index suggestions, and cluster events. Optionally
ATLAS_PROJECT_ID to skip project discovery.

Flags
  --db <name>       target database (default: URI path, else largest)
  --json            machine-readable output (versioned contract)
  --limit <n>       rows for list commands (default 20)
  --fail-on <s>     exit-code gate: critical | warn | none (default warn)
  --no-store        do not write a baseline snapshot
  --no-color        plain output
Exit codes: 0 clean · 1 warning · 2 critical · 3 connection failure · 64 usage`;

interface Flags {
  db?: string;
  json: boolean;
  limit: number;
  failOn: string;
  noStore: boolean;
  uri?: string;
}

function parseArgs(argv: string[]): { cmd: string; flags: Flags } {
  const flags: Flags = { json: false, limit: 20, failOn: 'warn', noStore: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--no-store') flags.noStore = true;
    else if (a === '--no-color') {
      /* leído por format.ts */
    } else if (a === '--db') flags.db = argv[++i];
    else if (a === '--limit') flags.limit = parseInt(argv[++i], 10) || 20;
    else if (a === '--fail-on') flags.failOn = argv[++i];
    else if (a === '--help' || a === '-h') positional.unshift('help');
    else if (a === '--version' || a === '-v') {
      console.log(`mongobot ${VERSION}`);
      process.exit(0);
    } else if (a.startsWith('--')) {
      process.stderr.write(`unknown flag ${a}\n`);
      process.exit(64);
    } else positional.push(a);
  }
  const known = ['inspect', 'queries', 'collections', 'indexes', 'advise', 'why', 'snapshot', 'help'];
  let cmd = 'inspect';
  if (positional[0] && known.includes(positional[0])) cmd = positional.shift()!;
  flags.uri = positional[0];
  return { cmd, flags };
}

async function collectAll(session: Session) {
  const [server, collections, repl, queries, atlas] = await Promise.all([
    collectServer(session),
    collectCollections(session),
    collectRepl(session),
    collectQueries(session),
    collectAtlas(session.host).catch((e) => {
      process.stderr.write(c.dim(`atlas layer unavailable: ${e.message}\n`));
      return null;
    }),
  ]);
  const indexes = await collectIndexes(session, collections);
  return { server, collections, indexes, queries, repl, atlas };
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (cmd === 'help') {
    console.log(HELP);
    return;
  }

  const session = await connect(flags.uri, flags.db);
  const hint = missingCapsHint(session.caps);
  if (hint && !flags.json) process.stderr.write(c.yellow(hint) + '\n\n');

  try {
    if (cmd === 'inspect' || cmd === 'snapshot' || cmd === 'why') {
      const data = await collectAll(session);
      const baseline = loadBaseline(session.host, session.dbName);
      const snap = buildSnapshot({
        host: session.host,
        db: session.dbName,
        version: session.caps.version,
        ...data,
      });

      if (cmd === 'snapshot') {
        const file = saveSnapshot(snap);
        console.log(`baseline stored: ${file}`);
        return;
      }

      const analysis = analyze({ ...data, baseline });

      if (cmd === 'why') {
        const shown = renderWhy(session, analysis, baseline !== null);
        if (!flags.noStore) saveSnapshot(snap);
        // why solo responde por lo que muestra: las regresiones
        process.exitCode = exitCodeFor({ ...analysis, findings: shown }, flags.failOn);
        return;
      }
      if (flags.json) {
        console.log(toJson(session, analysis, data.atlas));
      } else {
        console.log(renderInspect(session, analysis, data.atlas));
      }
      if (!flags.noStore) saveSnapshot(snap);
      process.exitCode = exitCodeFor(analysis, flags.failOn);
      return;
    }

    if (cmd === 'queries') await cmdQueries(session, flags);
    else if (cmd === 'collections') await cmdCollections(session, flags);
    else if (cmd === 'indexes') await cmdIndexes(session, flags);
    else if (cmd === 'advise') await cmdAdvise(session, flags);
  } finally {
    await session.client.close();
  }
}

function renderWhy(session: Session, analysis: ReturnType<typeof analyze>, hadBaseline: boolean) {
  console.log(renderHeader(session, analysis.windowText));
  console.log('');
  if (!hadBaseline) {
    console.log(
      'no baseline yet — mongobot compares against its own history.\n' +
        'This run stored one; run `mongobot why` again later (or after the next `inspect`).',
    );
    return [];
  }
  const regressions = analysis.findings.filter(
    (f) =>
      f.id.startsWith('query-slower-') ||
      f.id === 'collscans-surged' ||
      f.id.startsWith('collection-grew-'),
  );
  if (analysis.coldWindow) {
    console.log(
      'baseline is under 10 minutes old — counter noise still dominates, so regressions are suppressed.\n' +
        'Try again once the window matures.',
    );
    return [];
  }
  if (!regressions.length) {
    console.log(c.green('nothing regressed against the baseline — no slower queries, no scan surges, no unusual growth.'));
    return [];
  }
  for (const f of regressions) {
    const color = f.severity === 'critical' ? c.red : f.severity === 'warning' ? c.yellow : c.cyan;
    console.log(color(f.title));
    for (const ch of f.chain ?? []) console.log(`↳ ${ch}`);
    if (f.confidence !== undefined) console.log(`↳ confidence ${(f.confidence * 100).toFixed(0)}%`);
    if (f.detail) console.log(c.dim(f.detail));
    console.log('');
  }
  console.log(c.dim("Computed from MongoDB's own counters across your history. No AI guessing."));
  return regressions;
}

async function cmdQueries(session: Session, flags: Flags) {
  const queries = await collectQueries(session);
  if (!queries) {
    process.stderr.write('$queryStats unavailable (needs MongoDB 7.0+ and clusterMonitor).\n');
    process.exit(1);
  }
  console.log(renderHeader(session, `${queries.length} shapes`));
  console.log('');
  const total = queries.reduce((acc, q) => acc + q.totalMicros, 0);
  if (flags.json) {
    console.log(JSON.stringify(queries.slice(0, flags.limit), null, 2));
    return;
  }
  const rows = [['total', 'share', 'calls', 'mean', 'ex/ret', 'query'].map((h) => c.dim(h))];
  for (const q of queries.slice(0, flags.limit)) {
    rows.push([
      humanDur(q.totalMicros / 1e6),
      pct(total ? q.totalMicros / total : 0),
      humanNum(q.execCount),
      humanMs(q.meanMs),
      q.examinedPerReturned === null ? '—' : humanNum(q.examinedPerReturned),
      q.display.slice(0, 70),
    ]);
  }
  console.log(padTable(rows));
  console.log('');
  console.log(c.dim('ex/ret = docs examined per doc returned — high values mean missing indexes.'));
}

async function cmdCollections(session: Session, flags: Flags) {
  const cols = await collectCollections(session);
  console.log(renderHeader(session, `${cols.length} collections`));
  console.log('');
  if (flags.json) {
    console.log(JSON.stringify(cols.slice(0, flags.limit), null, 2));
    return;
  }
  const rows = [['size', 'docs', 'avg', 'frag', 'indexes', 'time', 'collection'].map((h) => c.dim(h))];
  for (const col of cols.slice(0, flags.limit)) {
    const frag = col.storageSize > 0 ? col.freeStorageSize / col.storageSize : 0;
    rows.push([
      humanBytes(col.storageSize + col.totalIndexSize),
      humanNum(col.count),
      humanBytes(col.avgObjSize),
      frag >= 0.3 ? c.yellow(pct(frag, 0)) : pct(frag, 0),
      `${col.nindexes} (${humanBytes(col.totalIndexSize)})`,
      col.topTotalMicros !== undefined ? humanDur(col.topTotalMicros / 1e6) : '—',
      col.name,
    ]);
  }
  console.log(padTable(rows));
  console.log('');
  console.log(
    c.dim('size = storage+indexes on disk · frag = reclaimable share · time = cumulative op time on this node since restart'),
  );
}

async function cmdIndexes(session: Session, flags: Flags) {
  const cols = await collectCollections(session);
  const indexes = await collectIndexes(session, cols);
  if (!indexes.length) {
    process.stderr.write('$indexStats unavailable (needs clusterMonitor).\n');
    process.exit(1);
  }
  const unused = indexes
    .filter((ix) => ix.ops === 0 && !ix.isId)
    .sort((a, b) => b.sizeBytes - a.sizeBytes);
  console.log(
    renderHeader(session, `${indexes.length} indexes · ${unused.length} unused on this node`),
  );
  console.log('');
  if (flags.json) {
    console.log(JSON.stringify(unused.slice(0, flags.limit), null, 2));
    return;
  }
  const rows = [['size', 'reads', 'flags', 'index'].map((h) => c.dim(h))];
  for (const ix of unused.slice(0, flags.limit)) {
    const flagsCol =
      [ix.unique ? 'unique' : '', ix.ttl ? 'ttl' : '', ix.hidden ? 'hidden' : '']
        .filter(Boolean)
        .join(',') || '—';
    rows.push([
      humanBytes(ix.sizeBytes),
      String(ix.ops),
      flagsCol,
      `${ix.collection}.${ix.name} ${c.dim(ix.keyJson)}`,
    ]);
  }
  console.log(padTable(rows));
  console.log('');
  console.log(
    c.yellow(
      'caveat: read counts are per-node since restart — a secondary or a rare monthly job may still need these. unique/ttl indexes enforce behavior regardless of reads.',
    ),
  );
}

// Cruce del Performance Advisor de Atlas con lo que $queryStats e $indexStats
// ya nos dicen: qué crear (con evidencia de ambos lados) y qué revisar.
async function cmdAdvise(session: Session, flags: Flags) {
  const atlas: AtlasInfo | null = await collectAtlas(session.host).catch((e) => {
    process.stderr.write(`atlas layer failed: ${e.message}\n`);
    return null;
  });
  if (!atlas) {
    process.stderr.write(
      'advise needs the Atlas layer. Set ATLAS_CLIENT_ID/ATLAS_CLIENT_SECRET (service account)\n' +
        'or ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY (API key), optionally ATLAS_PROJECT_ID.\n',
    );
    process.exit(64);
  }
  const queries = await collectQueries(session);
  console.log(
    renderHeader(
      session,
      `${atlas.clusterName}${atlas.tier ? ' · ' + atlas.tier : ''} · advisor ${atlas.suggestedIndexes.length} suggestions`,
    ),
  );
  console.log('');
  if (flags.json) {
    console.log(JSON.stringify({ atlas, note: 'suggestedIndexes crossed with $queryStats' }, null, 2));
    return;
  }
  if (!atlas.suggestedIndexes.length) {
    console.log(c.green('Atlas Performance Advisor has no index suggestions right now.'));
  } else {
    console.log(c.bold('CREATE — suggested by Atlas Performance Advisor'));
    for (const s of atlas.suggestedIndexes.slice(0, flags.limit)) {
      console.log(c.yellow(`● ${s.namespace}: ${s.indexJson}`));
      const parts = [`serves ${s.shapeCount} slow shape${s.shapeCount === 1 ? '' : 's'}`];
      if (s.avgQueryMs) parts.push(`avg ${humanMs(s.avgQueryMs)}`);
      const match = (queries ?? []).find((q) => q.namespace === s.namespace);
      if (match)
        parts.push(`$queryStats sees: ${match.display.slice(0, 60)} (${humanMs(match.meanMs)} mean)`);
      console.log('  ' + c.dim(parts.join(' · ')));
    }
  }
  if (atlas.slowNamespaces.length) {
    console.log('');
    console.log(c.bold('SLOW NAMESPACES (Atlas)'));
    console.log('  ' + atlas.slowNamespaces.join(' · '));
  }
  if (atlas.events.length) {
    console.log('');
    console.log(c.bold('CLUSTER EVENTS (48h)'));
    for (const ev of atlas.events.slice(0, 8))
      console.log(`  ${c.dim(ev.created.slice(0, 16) + 'Z')}  ${ev.summary}`);
  }
  if (atlas.errors.length) {
    console.log('');
    console.log(c.dim('partial collectors: ' + atlas.errors.join(' · ')));
  }
  console.log('');
  console.log(c.dim('review unused indexes with: mongobot indexes'));
}

main().catch((e) => {
  process.stderr.write(`mongobot: ${e?.message ?? e}\n`);
  process.exit(3);
});
