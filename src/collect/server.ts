// serverStatus muestreado dos veces (gap --interval) para tener rates instantáneos,
// igual que pgbot samplea sus counters. Todo son contadores del propio servidor.
import type { Session } from '../connect.ts';

export interface ServerSample {
  ts: number;
  uptime: number;
  host: string;
  version: string;
  connections: { current: number; available: number; active: number; totalCreated: number };
  opcounters: Record<string, number>;
  scannedKeys: number;
  scannedObjects: number;
  collectionScans: number;
  docsReturned: number;
  cachePagesRequested: number;
  cachePagesRead: number;
  cacheBytesCurrent: number;
  cacheBytesMax: number;
  cacheBytesDirty: number;
  cursorsOpen: number;
  cursorsTimedOut: number;
  assertsUser: number;
  assertsRegular: number;
  queueReaders: number;
  queueWriters: number;
  memResidentMB: number;
}

export interface ServerMetrics {
  sample: ServerSample; // segunda muestra (la actual)
  intervalSec: number;
  rates: {
    opsPerSec: number;
    collScansPerSec: number;
    scannedObjectsPerSec: number;
    docsReturnedPerSec: number;
    scanRatio: number | null; // docs examinados por doc devuelto en el intervalo
    cacheHit: number | null; // 1 - pages read / pages requested en el intervalo
  };
}

function toSample(s: any): ServerSample {
  const wt = s.wiredTiger?.cache ?? {};
  const qe = s.metrics?.queryExecutor ?? {};
  return {
    ts: Date.now(),
    uptime: s.uptime ?? 0,
    host: s.host ?? '',
    version: s.version ?? '',
    connections: {
      current: s.connections?.current ?? 0,
      available: s.connections?.available ?? 0,
      active: s.connections?.active ?? 0,
      totalCreated: s.connections?.totalCreated ?? 0,
    },
    opcounters: s.opcounters ?? {},
    scannedKeys: qe.scanned ?? 0,
    scannedObjects: qe.scannedObjects ?? 0,
    collectionScans: qe.collectionScans?.total ?? 0,
    docsReturned: s.metrics?.document?.returned ?? 0,
    cachePagesRequested: wt['pages requested from the cache'] ?? 0,
    cachePagesRead: wt['pages read into cache'] ?? 0,
    cacheBytesCurrent: wt['bytes currently in the cache'] ?? 0,
    cacheBytesMax: wt['maximum bytes configured'] ?? 0,
    cacheBytesDirty: wt['tracked dirty bytes in the cache'] ?? 0,
    cursorsOpen: s.metrics?.cursor?.open?.total ?? 0,
    cursorsTimedOut: s.metrics?.cursor?.timedOut ?? 0,
    assertsUser: s.asserts?.user ?? 0,
    assertsRegular: s.asserts?.regular ?? 0,
    queueReaders: s.globalLock?.currentQueue?.readers ?? 0,
    queueWriters: s.globalLock?.currentQueue?.writers ?? 0,
    memResidentMB: s.mem?.resident ?? 0,
  };
}

const delta = (a: number, b: number) => Math.max(0, b - a);

export async function collectServer(
  session: Session,
  intervalMs = 1000,
): Promise<ServerMetrics | null> {
  if (!session.caps.serverStatus) return null;
  const admin = session.client.db('admin');
  const s1 = toSample(await admin.command({ serverStatus: 1 }));
  await new Promise((r) => setTimeout(r, intervalMs));
  const s2 = toSample(await admin.command({ serverStatus: 1 }));

  const sec = Math.max(0.2, (s2.ts - s1.ts) / 1000);
  const ops = Object.keys(s2.opcounters).reduce(
    (acc, k) => acc + delta(s1.opcounters[k] ?? 0, s2.opcounters[k] ?? 0),
    0,
  );
  const scannedObjs = delta(s1.scannedObjects, s2.scannedObjects);
  const returned = delta(s1.docsReturned, s2.docsReturned);
  const pagesReq = delta(s1.cachePagesRequested, s2.cachePagesRequested);
  const pagesRead = delta(s1.cachePagesRead, s2.cachePagesRead);

  return {
    sample: s2,
    intervalSec: sec,
    rates: {
      opsPerSec: ops / sec,
      collScansPerSec: delta(s1.collectionScans, s2.collectionScans) / sec,
      scannedObjectsPerSec: scannedObjs / sec,
      docsReturnedPerSec: returned / sec,
      scanRatio: returned > 50 ? scannedObjs / returned : null,
      cacheHit: pagesReq > 1000 ? 1 - pagesRead / pagesReq : null,
    },
  };
}
