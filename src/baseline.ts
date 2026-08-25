// Baseline local: cada run guarda un snapshot compacto de los contadores en
// $XDG_STATE_HOME/mongobot/<host>-<db>/. A partir del segundo run, mongobot
// puede decir qué ha cambiado — sin servicios externos ni otra base de datos.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServerMetrics } from './collect/server.ts';
import type { CollectionInfo } from './collect/collections.ts';
import type { IndexInfo } from './collect/indexes.ts';
import type { QueryShapeStat } from './collect/queries.ts';
import type { ReplInfo } from './collect/repl.ts';

export interface Snapshot {
  schema: 1;
  ts: number; // epoch ms
  host: string;
  db: string;
  serverVersion: string;
  uptime: number;
  server: ServerMetrics['sample'] | null;
  collections: Pick<
    CollectionInfo,
    'name' | 'count' | 'dataSize' | 'storageSize' | 'freeStorageSize' | 'totalIndexSize' | 'topTotalMicros' | 'topTotalCount'
  >[];
  indexes: Pick<IndexInfo, 'collection' | 'name' | 'ops' | 'sizeBytes'>[];
  queries: Pick<
    QueryShapeStat,
    'hash' | 'display' | 'namespace' | 'execCount' | 'totalMicros' | 'docsExamined' | 'docsReturned'
  >[];
  repl: { maxLagSec: number | null; oplogWindowHours: number | null } | null;
}

const KEEP = 60; // snapshots retenidos por target

function stateDir(host: string, db: string): string {
  const base =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim() !== ''
      ? process.env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  const slug = `${host}-${db}`.replace(/[^a-zA-Z0-9.-]+/g, '_');
  return join(base, 'mongobot', slug);
}

export function buildSnapshot(data: {
  host: string;
  db: string;
  version: string;
  server: ServerMetrics | null;
  collections: CollectionInfo[];
  indexes: IndexInfo[];
  queries: QueryShapeStat[] | null;
  repl: ReplInfo | null;
}): Snapshot {
  return {
    schema: 1,
    ts: Date.now(),
    host: data.host,
    db: data.db,
    serverVersion: data.version,
    uptime: data.server?.sample.uptime ?? 0,
    server: data.server?.sample ?? null,
    collections: data.collections.map((col) => ({
      name: col.name,
      count: col.count,
      dataSize: col.dataSize,
      storageSize: col.storageSize,
      freeStorageSize: col.freeStorageSize,
      totalIndexSize: col.totalIndexSize,
      topTotalMicros: col.topTotalMicros,
      topTotalCount: col.topTotalCount,
    })),
    indexes: data.indexes.map((ix) => ({
      collection: ix.collection,
      name: ix.name,
      ops: ix.ops,
      sizeBytes: ix.sizeBytes,
    })),
    queries: (data.queries ?? []).slice(0, 500).map((q) => ({
      hash: q.hash,
      display: q.display,
      namespace: q.namespace,
      execCount: q.execCount,
      totalMicros: q.totalMicros,
      docsExamined: q.docsExamined,
      docsReturned: q.docsReturned,
    })),
    repl: data.repl
      ? { maxLagSec: data.repl.maxLagSec, oplogWindowHours: data.repl.oplogWindowHours }
      : null,
  };
}

export function saveSnapshot(snap: Snapshot): string {
  const dir = stateDir(snap.host, snap.db);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `snap-${new Date(snap.ts).toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify(snap));
  const all = listSnapshotFiles(snap.host, snap.db);
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) {
    rmSync(join(dir, old), { force: true });
  }
  return file;
}

export function listSnapshotFiles(host: string, db: string): string[] {
  try {
    return readdirSync(stateDir(host, db))
      .filter((f) => f.startsWith('snap-') && f.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }
}

// Baseline de referencia: el snapshot previo más cercano a `sinceMs` atrás
// (por defecto el más antiguo dentro de 26h, para comparar "ayer vs hoy";
// si no hay ninguno tan viejo, el más antiguo disponible).
export function loadBaseline(
  host: string,
  db: string,
  sinceMs = 26 * 3600 * 1000,
): Snapshot | null {
  const files = listSnapshotFiles(host, db);
  if (files.length === 0) return null;
  const dir = stateDir(host, db);
  const snaps: Snapshot[] = [];
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (s.schema === 1) snaps.push(s);
    } catch {
      /* snapshot corrupto: se ignora */
    }
  }
  if (snaps.length === 0) return null;
  const now = Date.now();
  const inWindow = snaps.filter((s) => now - s.ts <= sinceMs);
  const pick = inWindow.length ? inWindow[0] : snaps[0];
  // nunca compares un run consigo mismo
  return pick.ts >= now - 5000 ? null : pick;
}
