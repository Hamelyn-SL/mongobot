// Motor de findings. Cada finding se computa de contadores del servidor con
// umbrales explícitos — nada de heurística opaca ni IA: mismo input, mismo output.
import type { ServerMetrics } from './collect/server.ts';
import type { CollectionInfo } from './collect/collections.ts';
import type { IndexInfo } from './collect/indexes.ts';
import { aggregateShapes, type QueryShapeStat } from './collect/queries.ts';
import type { ReplInfo } from './collect/repl.ts';
import type { AtlasInfo } from './collect/atlas.ts';
import type { Snapshot } from './baseline.ts';
import { humanBytes, humanMs, humanNum, pct, times, humanDur } from './format.ts';

export type Severity = 'critical' | 'warning' | 'note';

export interface Finding {
  id: string;
  severity: Severity;
  title: string; // frase con los números dentro, estilo pgbot
  detail?: string;
  caveat?: string;
  confidence?: number; // 0..1, solo en findings de regresión
  chain?: string[]; // mecanismo ← antecedente, para `why`
  impact?: number; // µs de exec añadidos en la ventana (ordena regresiones)
}

export interface Good {
  subsystem: string;
  value: string;
}

export interface Analysis {
  findings: Finding[];
  good: Good[];
  score: number;
  windowText: string;
  coldWindow: boolean; // hay baseline pero es demasiado joven para rates
}

const T = {
  connWarn: 0.8,
  connCrit: 0.95,
  dirtyWarn: 0.05,
  dirtyCrit: 0.2,
  cacheHitWarn: 0.9,
  scanRatioWarn: 100,
  collScansNote: 10,
  collScansWarn: 100,
  unusedIdxMinUptimeH: 24,
  unusedIdxWarnBytes: 1 << 30,
  fragNoteRatio: 0.3,
  fragNoteBytes: 5 * (1 << 30),
  slowMeanMs: 250,
  slowMinCalls: 100,
  ineffRatio: 100,
  ineffMinReturned: 1000,
  lagWarnSec: 10,
  lagCritSec: 60,
  oplogWarnH: 24,
  oplogCritH: 6,
  queueWarn: 10,
  queueCrit: 25,
  regressionFactor: 2,
  regressionMinCalls: 100,
  regressionMinMeanMs: 20,
  regressionMinWindowMicros: 5e6, // la regresión debe pesar ≥5s de exec en la ventana
  regressionCritFactor: 5,
  regressionCritMeanMs: 250,
  regressionCritWindowMicros: 60e6,
  coldWindowMs: 10 * 60 * 1000, // baseline más joven: rates aún no son señal
  idxStoppedWindowMs: 30 * 60 * 1000,
  idxStoppedMinRatePerMin: 1,
  maxRegressionFindings: 8,
  diskWarnPct: 80,
  diskCritPct: 90,
  cpuWarnPct: 75,
  cpuCritPct: 90,
  maxSuggestedIndexFindings: 4,
} as const;

export function analyze(input: {
  server: ServerMetrics | null;
  collections: CollectionInfo[];
  indexes: IndexInfo[];
  queries: QueryShapeStat[] | null;
  repl: ReplInfo | null;
  baseline: Snapshot | null;
  atlas?: AtlasInfo | null;
}): Analysis {
  const f: Finding[] = [];
  const good: Good[] = [];
  const { server, collections, indexes, queries, repl, baseline } = input;
  const atlas = input.atlas ?? null;

  // ---- conexiones ----
  if (server) {
    const cn = server.sample.connections;
    const limit = cn.current + cn.available;
    const usage = limit > 0 ? cn.current / limit : 0;
    if (usage >= T.connCrit)
      f.push({
        id: 'connections-critical',
        severity: 'critical',
        title: `connection usage at ${pct(usage, 0)} (${cn.current}/${humanNum(limit)})`,
      });
    else if (usage >= T.connWarn)
      f.push({
        id: 'connections-high',
        severity: 'warning',
        title: `connection usage reached ${pct(usage, 0)} (${cn.current}/${humanNum(limit)})`,
      });
    else
      good.push({
        subsystem: 'connections',
        value: `${pct(usage, 1)} used (${cn.current}/${humanNum(limit)})`,
      });

    // ---- cache WiredTiger ----
    const s = server.sample;
    if (s.cacheBytesMax > 0) {
      const dirty = s.cacheBytesDirty / s.cacheBytesMax;
      if (dirty >= T.dirtyCrit)
        f.push({
          id: 'cache-dirty-critical',
          severity: 'critical',
          title: `WiredTiger dirty cache at ${pct(dirty)} — eviction pressure`,
        });
      else if (dirty >= T.dirtyWarn)
        f.push({
          id: 'cache-dirty',
          severity: 'warning',
          title: `WiredTiger dirty cache at ${pct(dirty)} (healthy < ${pct(T.dirtyWarn, 0)})`,
        });
    }
    const hit = server.rates.cacheHit;
    if (hit !== null) {
      if (hit < T.cacheHitWarn)
        f.push({
          id: 'cache-hit-low',
          severity: 'warning',
          title: `cache hit ratio ${pct(hit)} — working set may exceed cache (${humanBytes(s.cacheBytesMax)})`,
        });
      else good.push({ subsystem: 'cache hit ratio', value: pct(hit) });
    }

    // ---- queue ----
    const queue = s.queueReaders + s.queueWriters;
    if (queue >= T.queueCrit)
      f.push({
        id: 'queue-critical',
        severity: 'critical',
        title: `${queue} operations queued on the global lock right now`,
      });
    else if (queue >= T.queueWarn)
      f.push({
        id: 'queue-high',
        severity: 'warning',
        title: `${queue} operations queued on the global lock right now`,
      });
    else good.push({ subsystem: 'lock queue', value: 'empty' });

    // ---- eficiencia de scans (instantánea) ----
    const ratio = server.rates.scanRatio;
    if (ratio !== null) {
      if (ratio > T.scanRatioWarn)
        f.push({
          id: 'scan-ratio-high',
          severity: 'warning',
          title: `reading ${humanNum(ratio)} docs per document returned right now`,
          detail: `${humanNum(server.rates.scannedObjectsPerSec)} docs/s examined vs ${humanNum(server.rates.docsReturnedPerSec)}/s returned over a ${server.intervalSec.toFixed(1)}s sample`,
        });
      else
        good.push({
          subsystem: 'scan efficiency',
          value: `${humanNum(ratio)} docs examined per doc returned`,
        });
    }
    const cs = server.rates.collScansPerSec;
    if (cs >= T.collScansWarn)
      f.push({
        id: 'collscans-high',
        severity: 'warning',
        title: `collection scans running at ${humanNum(cs)}/s`,
      });
    else if (cs >= T.collScansNote)
      f.push({
        id: 'collscans-elevated',
        severity: 'note',
        title: `collection scans at ${humanNum(cs)}/s during the sample`,
      });
  }

  // ---- índices sin uso ----
  const uptimeH = (server?.sample.uptime ?? 0) / 3600;
  if (indexes.length && uptimeH < T.unusedIdxMinUptimeH) {
    f.push({
      id: 'index-window-short',
      severity: 'note',
      title: `index usage counters only ${uptimeH.toFixed(0)}h old on this node — unused-index analysis needs ${T.unusedIdxMinUptimeH}h`,
      detail: 'mongobot indexes shows the current per-node state anyway',
    });
  }
  if (indexes.length && uptimeH >= T.unusedIdxMinUptimeH) {
    const unused = indexes
      .filter((ix) => ix.ops === 0 && !ix.isId && !ix.ttl)
      .sort((a, b) => b.sizeBytes - a.sizeBytes);
    const totalBytes = unused.reduce((acc, ix) => acc + ix.sizeBytes, 0);
    if (unused.length) {
      const uniqueCount = unused.filter((u) => u.unique).length;
      f.push({
        id: 'unused-indexes',
        severity: totalBytes >= T.unusedIdxWarnBytes ? 'warning' : 'note',
        title: `${unused.length} unused indexes consume ${humanBytes(totalBytes)}`,
        detail: unused
          .slice(0, 5)
          .map((ix) => `${ix.collection}.${ix.name} ${humanBytes(ix.sizeBytes)}${ix.unique ? ' (unique)' : ''}`)
          .join(' · '),
        caveat:
          `zero reads on this node since ${humanDur(uptimeH * 3600)} ago; a secondary may still use them` +
          (uniqueCount ? `; ${uniqueCount} enforce unique constraints — do not drop for size alone` : ''),
      });
    } else {
      good.push({ subsystem: 'indexes', value: `all ${indexes.length} indexes in use on this node` });
    }
  }

  // ---- fragmentación ----
  const frag = collections
    .filter(
      (col) =>
        col.storageSize > 0 &&
        col.freeStorageSize / col.storageSize >= T.fragNoteRatio &&
        col.freeStorageSize >= T.fragNoteBytes,
    )
    .sort((a, b) => b.freeStorageSize - a.freeStorageSize);
  if (frag.length) {
    const total = frag.reduce((acc, col) => acc + col.freeStorageSize, 0);
    f.push({
      id: 'fragmentation',
      severity: 'note',
      title: `${humanBytes(total)} reclaimable disk in ${frag.length} fragmented collections`,
      detail: frag
        .slice(0, 4)
        .map((col) => `${col.name} ${humanBytes(col.freeStorageSize)} free of ${humanBytes(col.storageSize)}`)
        .join(' · '),
      caveat: 'space is reused by new writes; `compact` returns it to the OS (blocks writes per node)',
    });
  }

  // ---- queries ($queryStats) ----
  if (queries && queries.length) {
    const slow = queries
      .filter((q) => q.meanMs >= T.slowMeanMs && q.execCount >= T.slowMinCalls)
      .sort((a, b) => b.totalMicros - a.totalMicros);
    for (const q of slow.slice(0, 3)) {
      f.push({
        id: `slow-query-${q.hash}`,
        severity: 'warning',
        title: `${q.display} averages ${humanMs(q.meanMs)} over ${humanNum(q.execCount)} calls`,
        detail:
          q.examinedPerReturned !== null
            ? `examines ${humanNum(q.examinedPerReturned)} docs per doc returned`
            : undefined,
      });
    }
    const inefficient = queries
      .filter(
        (q) =>
          q.examinedPerReturned !== null &&
          q.examinedPerReturned >= T.ineffRatio &&
          q.docsReturned >= T.ineffMinReturned &&
          !slow.slice(0, 3).some((sq) => sq.hash === q.hash),
      )
      .sort((a, b) => (b.docsExamined ?? 0) - (a.docsExamined ?? 0));
    for (const q of inefficient.slice(0, 2)) {
      f.push({
        id: `inefficient-query-${q.hash}`,
        severity: 'warning',
        title: `${q.display} examines ${humanNum(q.examinedPerReturned!)} docs per doc returned`,
        detail: `likely missing or unusable index on ${q.namespace}`,
      });
    }
    if (!slow.length && !inefficient.length)
      good.push({
        subsystem: 'query shapes',
        value: `top ${Math.min(queries.length, 500)} shapes all under ${humanMs(T.slowMeanMs)} mean`,
      });
  }

  // ---- replicación ----
  if (repl) {
    const sick = repl.members.filter((m) => !m.healthy);
    for (const m of sick)
      f.push({
        id: `repl-member-${m.name}`,
        severity: 'critical',
        title: `replica member ${m.name} unhealthy (${m.state})`,
      });
    if (repl.maxLagSec !== null) {
      if (repl.maxLagSec >= T.lagCritSec)
        f.push({
          id: 'repl-lag-critical',
          severity: 'critical',
          title: `replication lag at ${humanDur(repl.maxLagSec)}`,
        });
      else if (repl.maxLagSec >= T.lagWarnSec)
        f.push({
          id: 'repl-lag',
          severity: 'warning',
          title: `replication lag at ${humanDur(repl.maxLagSec)}`,
        });
      else if (!sick.length)
        good.push({
          subsystem: 'replication',
          value: `healthy, lag ${repl.maxLagSec.toFixed(0)}s (${repl.members.length} members)`,
        });
    }
    if (repl.oplogWindowHours !== null) {
      if (repl.oplogWindowHours < T.oplogCritH)
        f.push({
          id: 'oplog-window-critical',
          severity: 'critical',
          title: `oplog window down to ${repl.oplogWindowHours.toFixed(1)}h — a resyncing node has that long to catch up`,
        });
      else if (repl.oplogWindowHours < T.oplogWarnH)
        f.push({
          id: 'oplog-window',
          severity: 'warning',
          title: `oplog window at ${repl.oplogWindowHours.toFixed(1)}h (comfortable ≥ ${T.oplogWarnH}h)`,
        });
      else
        good.push({
          subsystem: 'oplog window',
          value: `${humanDur(repl.oplogWindowHours * 3600)}`,
        });
    }
  }

  // ---- capa Atlas: host y Performance Advisor ----
  if (atlas) {
    if (atlas.diskPercentUsed !== null) {
      if (atlas.diskPercentUsed >= T.diskCritPct)
        f.push({
          id: 'disk-space-critical',
          severity: 'critical',
          title: `data disk at ${atlas.diskPercentUsed.toFixed(0)}% of ${atlas.diskSizeGB ?? '?'}GB on the primary`,
        });
      else if (atlas.diskPercentUsed >= T.diskWarnPct)
        f.push({
          id: 'disk-space-high',
          severity: 'warning',
          title: `data disk at ${atlas.diskPercentUsed.toFixed(0)}% of ${atlas.diskSizeGB ?? '?'}GB on the primary`,
        });
      else
        good.push({
          subsystem: 'disk',
          value: `${atlas.diskPercentUsed.toFixed(0)}% of ${atlas.diskSizeGB ?? '?'}GB used`,
        });
    }
    if (atlas.cpuPercent !== null) {
      if (atlas.cpuPercent >= T.cpuCritPct)
        f.push({
          id: 'cpu-critical',
          severity: 'critical',
          title: `primary CPU at ${atlas.cpuPercent.toFixed(0)}% (normalized, 15m avg)`,
        });
      else if (atlas.cpuPercent >= T.cpuWarnPct)
        f.push({
          id: 'cpu-high',
          severity: 'warning',
          title: `primary CPU at ${atlas.cpuPercent.toFixed(0)}% (normalized, 15m avg)`,
        });
      else
        good.push({ subsystem: 'host CPU', value: `${atlas.cpuPercent.toFixed(0)}% (15m avg)` });
    }
    for (const s of atlas.suggestedIndexes.slice(0, T.maxSuggestedIndexFindings)) {
      const chain: string[] = [];
      const match = (queries ?? []).find(
        (q) => q.namespace === s.namespace && (q.meanMs >= 100 || (q.examinedPerReturned ?? 0) >= 100),
      );
      if (match)
        chain.push(
          `matches the expensive $queryStats shape: ${match.display} (${humanMs(match.meanMs)} mean over ${humanNum(match.execCount)} calls)`,
        );
      f.push({
        id: `atlas-suggested-index-${s.namespace}-${s.indexJson}`,
        severity: 'warning',
        title: `Atlas Performance Advisor suggests index ${s.indexJson} on ${s.namespace}`,
        detail: `would serve ${s.shapeCount} slow query shape${s.shapeCount === 1 ? '' : 's'}${s.avgQueryMs ? ` averaging ${humanMs(s.avgQueryMs)}` : ''}`,
        chain,
      });
    }
    if (atlas.suggestedIndexes.length === 0 && !atlas.errors.some((e) => e.startsWith('performance-advisor')))
      good.push({ subsystem: 'index advisor', value: 'no suggestions from Atlas' });
    const lastEvent = atlas.events[0];
    if (lastEvent) {
      f.push({
        id: `atlas-event-${lastEvent.type}`,
        severity: 'note',
        title: `cluster event ${humanDur((Date.now() - new Date(lastEvent.created).getTime()) / 1000)} ago: ${lastEvent.summary}`,
        detail: atlas.events.length > 1 ? `${atlas.events.length} relevant events in 48h` : undefined,
      });
    }
  }

  // ---- regresiones vs baseline ----
  if (baseline) f.push(...regressions(input, baseline, atlas));

  // ---- score ----
  const weights: Record<Severity, number> = { critical: 15, warning: 5, note: 1 };
  const score = Math.max(
    0,
    Math.round(100 - f.reduce((acc, x) => acc + weights[x.severity], 0)),
  );

  const order: Record<Severity, number> = { critical: 0, warning: 1, note: 2 };
  f.sort((a, b) => order[a.severity] - order[b.severity]);

  const windowText = baseline
    ? `baseline ${humanDur((Date.now() - baseline.ts) / 1000)} ago`
    : server
      ? `uptime ${humanDur(server.sample.uptime)}`
      : 'no window';
  const coldWindow = baseline !== null && Date.now() - baseline.ts < T.coldWindowMs;

  return { findings: f, good, score, windowText, coldWindow };
}

// Regresiones deterministas contra el baseline: síntoma ← mecanismo ← antecedente.
function regressions(
  input: {
    server: ServerMetrics | null;
    collections: CollectionInfo[];
    indexes: IndexInfo[];
    queries: QueryShapeStat[] | null;
  },
  base: Snapshot,
  atlas: AtlasInfo | null = null,
): Finding[] {
  const out: Finding[] = [];
  const { server, collections, indexes, queries } = input;
  const sameEpoch = !!server && server.sample.uptime > base.uptime; // sin restart entre medias
  const windowMs = Date.now() - base.ts;
  const windowSec = Math.max(1, windowMs / 1000);

  const baseCols = new Map(base.collections.map((col) => [col.name, col]));
  const baseIdx = new Map(base.indexes.map((ix) => [`${ix.collection}.${ix.name}`, ix]));
  // Snapshots antiguos pueden traer shapes sin agregar: re-agregarlos es idempotente.
  const baseQ = new Map(
    aggregateShapes(base.queries.map((q) => ({ ...q, command: '?', maxMicros: 0, keysExamined: null }))).map(
      (q) => [q.hash, q],
    ),
  );

  // crecimiento de colecciones (independiente de restarts)
  for (const col of collections) {
    const prev = baseCols.get(col.name);
    if (!prev || prev.storageSize < 1 << 30) continue;
    const growth = (col.storageSize - prev.storageSize) / prev.storageSize;
    if (growth >= 0.25 && col.storageSize - prev.storageSize >= 1 << 30) {
      out.push({
        id: `collection-grew-${col.name}`,
        severity: 'note',
        title: `${col.name} grew ${pct(growth, 0)} (${humanBytes(prev.storageSize)} → ${humanBytes(col.storageSize)}) since baseline`,
      });
    }
  }

  if (!sameEpoch) return out; // contadores reseteados: no comparamos rates
  if (windowMs < T.coldWindowMs) return out; // ventana fría: la varianza natural aún domina

  // queries que se ralentizaron: mean de la VENTANA (delta) vs mean del baseline acumulado
  const qRegressions: Finding[] = [];
  if (queries) {
    for (const q of queries) {
      const prev = baseQ.get(q.hash);
      if (!prev) continue;
      const dCount = q.execCount - prev.execCount;
      const dMicros = q.totalMicros - prev.totalMicros;
      if (dCount < T.regressionMinCalls || dMicros < T.regressionMinWindowMicros) continue;
      const windowMean = dMicros / dCount / 1000;
      const baseMean = prev.execCount > 0 ? prev.totalMicros / prev.execCount / 1000 : 0;
      if (baseMean <= 0) continue;
      const factor = windowMean / baseMean;
      if (factor < T.regressionFactor || windowMean < T.regressionMinMeanMs) continue;

      // mecanismo: ¿lee más docs por resultado que antes?
      const chain: string[] = [];
      let confidence = 0.5;
      const dExam =
        q.docsExamined !== null && prev.docsExamined !== null
          ? q.docsExamined - prev.docsExamined
          : null;
      const dRet = q.docsReturned - prev.docsReturned;
      if (dExam !== null && dRet > 0) {
        const windowRatio = dExam / dRet;
        const baseRatio =
          prev.docsReturned > 0 && prev.docsExamined !== null
            ? prev.docsExamined / prev.docsReturned
            : null;
        if (baseRatio !== null && baseRatio > 0 && windowRatio / baseRatio >= 2) {
          chain.push(
            `because it now examines ${humanNum(windowRatio)} docs per doc returned (was ${humanNum(baseRatio)})`,
          );
          confidence += 0.2;
        }
      }
      // antecedente: la colección creció / un índice dejó de usarse
      const collName = q.namespace.split('.').slice(1).join('.');
      const colNow = collections.find((x) => x.name === collName);
      const colPrev = baseCols.get(collName);
      if (colNow && colPrev && colPrev.count > 0) {
        const growth = (colNow.count - colPrev.count) / colPrev.count;
        if (growth >= 0.1) {
          chain.push(`after ${collName} grew ${pct(growth, 0)} (${humanNum(colPrev.count)} → ${humanNum(colNow.count)} docs)`);
          confidence += 0.15;
        }
      }
      if (windowMs >= T.idxStoppedWindowMs) {
        for (const ix of indexes.filter((x) => x.collection === collName)) {
          const prevIx = baseIdx.get(`${ix.collection}.${ix.name}`);
          const histRatePerMin = prevIx ? prevIx.ops / Math.max(1, base.uptime / 60) : 0;
          if (
            prevIx &&
            histRatePerMin >= T.idxStoppedMinRatePerMin &&
            ix.ops === prevIx.ops
          ) {
            chain.push(`index ${ix.name} stopped being read in this window`);
            confidence += 0.15;
            break;
          }
        }
      }
      // antecedente de infraestructura: elección/restart dentro de la ventana
      const infraEvent = (atlas?.events ?? []).find(
        (ev) => new Date(ev.created).getTime() >= base.ts,
      );
      if (infraEvent) {
        chain.push(
          `after cluster event: ${infraEvent.summary} (${new Date(infraEvent.created).toISOString().slice(11, 16)}Z)`,
        );
        confidence += 0.1;
      }

      qRegressions.push({
        id: `query-slower-${q.hash}`,
        severity:
          factor >= T.regressionCritFactor &&
          windowMean >= T.regressionCritMeanMs &&
          dMicros >= T.regressionCritWindowMicros
            ? 'critical'
            : 'warning',
        title: `${q.display} slowed ${times(factor)} — ${humanMs(baseMean)} → ${humanMs(windowMean)}/call`,
        detail: `${humanNum(dCount)} calls in the last ${humanDur(windowSec)} (${humanDur(dMicros / 1e6)} exec time)`,
        confidence: Math.min(0.95, confidence),
        chain,
        impact: dMicros,
      });
    }
    // top por impacto real (tiempo de ejecución añadido en la ventana)
    qRegressions.sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0));
    const kept = qRegressions.slice(0, T.maxRegressionFindings);
    out.push(...kept);
    if (qRegressions.length > kept.length)
      out.push({
        id: 'query-slower-more',
        severity: 'note',
        title: `${qRegressions.length - kept.length} more query regressions below the impact cutoff`,
      });
  }

  // collscans de la ventana vs media desde el arranque
  if (server && base.server) {
    const dScans = server.sample.collectionScans - base.server.collectionScans;
    const windowRate = dScans / windowSec;
    const baseRate = base.server.collectionScans / Math.max(1, base.uptime);
    if (windowRate >= 1 && baseRate >= 0 && windowRate / Math.max(0.01, baseRate) >= 5) {
      out.push({
        id: 'collscans-surged',
        severity: 'warning',
        title: `collection scans surged ${humanNum(baseRate)} → ${humanNum(windowRate)}/s since baseline`,
      });
    }
  }

  return out;
}

export { T as thresholds };
