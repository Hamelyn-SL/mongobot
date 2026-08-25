// $queryStats (MongoDB 7.0+/Atlas): métricas acumuladas por query shape — el
// pg_stat_statements de MongoDB. Los shapes ya llegan anonimizados (valores
// sustituidos por marcadores de tipo), así que el resultado es PII-free.
// mongobot excluye sus propias operaciones, igual que hace pgbot.
import type { Session } from '../connect.ts';
import { fnv1a } from '../format.ts';

export interface QueryShapeStat {
  hash: string;
  display: string; // "find ordersells {status, marketplace} sort {createdAt}"
  namespace: string;
  command: string;
  execCount: number;
  totalMicros: number;
  maxMicros: number;
  meanMs: number;
  docsReturned: number;
  docsExamined: number | null;
  keysExamined: number | null;
  examinedPerReturned: number | null;
}

function filterKeys(filter: any, depth = 0): string[] {
  if (!filter || typeof filter !== 'object' || depth > 1) return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') {
      if (Array.isArray(v)) for (const sub of v) keys.push(...filterKeys(sub, depth + 1));
    } else if (!k.startsWith('$')) {
      keys.push(k);
    }
  }
  return [...new Set(keys)];
}

function shapeDisplay(shape: any): string {
  const coll = shape?.cmdNs?.coll ?? '?';
  const cmd = shape?.command ?? '?';
  if (cmd === 'aggregate' && Array.isArray(shape.pipeline)) {
    const stages = shape.pipeline.slice(0, 4).map((st: any) => {
      const name = Object.keys(st ?? {})[0] ?? '?';
      if (name === '$match') {
        const keys = filterKeys(st[name]).slice(0, 3);
        return `$match{${keys.join(',')}}`;
      }
      return name;
    });
    const more = shape.pipeline.length > 4 ? '…' : '';
    return `aggregate ${coll} [${stages.join(', ')}${more}]`;
  }
  const keys = filterKeys(shape?.filter).slice(0, 4);
  let s = `${cmd} ${coll}`;
  if (keys.length) s += ` {${keys.join(', ')}}`;
  if (shape?.sort && Object.keys(shape.sort).length)
    s += ` sort {${Object.keys(shape.sort).join(', ')}}`;
  return s;
}

// Variantes del mismo shape lógico (mismo comando+colección+campos) se agregan:
// estabiliza medias y evita listar la misma query cinco veces.
export function aggregateShapes(
  stats: Pick<
    QueryShapeStat,
    'display' | 'namespace' | 'command' | 'execCount' | 'totalMicros' | 'maxMicros' | 'docsReturned' | 'docsExamined' | 'keysExamined'
  >[],
): QueryShapeStat[] {
  const byKey = new Map<string, QueryShapeStat>();
  for (const q of stats) {
    const key = `${q.namespace}|${q.display}`;
    const acc = byKey.get(key);
    if (!acc) {
      byKey.set(key, {
        hash: fnv1a(key),
        display: q.display,
        namespace: q.namespace,
        command: q.command ?? '?',
        execCount: q.execCount,
        totalMicros: q.totalMicros,
        maxMicros: q.maxMicros ?? 0,
        meanMs: 0,
        docsReturned: q.docsReturned,
        docsExamined: q.docsExamined,
        keysExamined: q.keysExamined ?? null,
        examinedPerReturned: null,
      });
    } else {
      acc.execCount += q.execCount;
      acc.totalMicros += q.totalMicros;
      acc.maxMicros = Math.max(acc.maxMicros, q.maxMicros ?? 0);
      acc.docsReturned += q.docsReturned;
      if (q.docsExamined !== null)
        acc.docsExamined = (acc.docsExamined ?? 0) + q.docsExamined;
      if (q.keysExamined !== null && q.keysExamined !== undefined)
        acc.keysExamined = (acc.keysExamined ?? 0) + q.keysExamined;
    }
  }
  const out = [...byKey.values()];
  for (const q of out) {
    q.meanMs = q.execCount > 0 ? q.totalMicros / q.execCount / 1000 : 0;
    q.examinedPerReturned =
      q.docsExamined !== null && q.docsReturned > 0 ? q.docsExamined / q.docsReturned : null;
  }
  out.sort((a, b) => b.totalMicros - a.totalMicros);
  return out;
}

export async function collectQueries(
  session: Session,
  limit = 500,
): Promise<QueryShapeStat[] | null> {
  if (!session.caps.queryStats) return null;
  const admin = session.client.db('admin');
  const docs = await admin
    .aggregate(
      [
        { $queryStats: {} },
        { $match: { 'key.queryShape.cmdNs.db': session.dbName } },
        { $sort: { 'metrics.totalExecMicros.sum': -1 } },
        { $limit: limit },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const out: QueryShapeStat[] = [];
  for (const d of docs) {
    const appName = d.key?.client?.application?.name;
    if (appName === 'mongobot' || appName === 'mongobot-probe') continue;
    const shape = d.key?.queryShape ?? {};
    const m = d.metrics ?? {};
    const execCount = Number(m.execCount ?? 0);
    if (execCount === 0) continue;
    const totalMicros = Number(m.totalExecMicros?.sum ?? 0);
    const docsExamined = m.docsExamined ? Number(m.docsExamined.sum) : null;
    const docsReturned = Number(m.docsReturned?.sum ?? 0);
    out.push({
      hash: d.queryShapeHash ?? fnv1a(JSON.stringify(shape)),
      display: shapeDisplay(shape),
      namespace: `${shape?.cmdNs?.db ?? '?'}.${shape?.cmdNs?.coll ?? '?'}`,
      command: shape?.command ?? '?',
      execCount,
      totalMicros,
      maxMicros: Number(m.totalExecMicros?.max ?? 0),
      meanMs: execCount > 0 ? totalMicros / execCount / 1000 : 0,
      docsReturned,
      docsExamined,
      keysExamined: m.keysExamined ? Number(m.keysExamined.sum) : null,
      examinedPerReturned:
        docsExamined !== null && docsReturned > 0 ? docsExamined / docsReturned : null,
    });
  }
  return aggregateShapes(out);
}
