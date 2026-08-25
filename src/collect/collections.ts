// $collStats por colección (+ tiempos acumulados de `top` cuando hay permiso).
// Fragmentación = bytes reutilizables dentro del fichero WiredTiger: espacio ya
// pagado en disco que solo `compact` devuelve.
import type { Session } from '../connect.ts';

export interface CollectionInfo {
  name: string;
  count: number;
  dataSize: number; // sin comprimir
  storageSize: number; // en disco
  freeStorageSize: number; // reutilizable (fragmentación)
  totalIndexSize: number;
  avgObjSize: number;
  nindexes: number;
  indexSizes: Record<string, number>;
  capped: boolean;
  // acumulados de `top` (µs y ops desde el arranque del nodo)
  topTotalMicros?: number;
  topTotalCount?: number;
  topReadMicros?: number;
  topWriteMicros?: number;
}

export async function collectCollections(session: Session): Promise<CollectionInfo[]> {
  const db = session.client.db(session.dbName);
  const names = (await db.listCollections({ type: 'collection' }, { nameOnly: true }).toArray())
    .map((x) => x.name)
    .filter((n) => !n.startsWith('system.'));

  const out: CollectionInfo[] = [];
  const batch = 8;
  for (let i = 0; i < names.length; i += batch) {
    const chunk = names.slice(i, i + batch);
    const results = await Promise.all(
      chunk.map(async (name) => {
        try {
          const r = await db
            .collection(name)
            .aggregate([{ $collStats: { storageStats: {} } }])
            .toArray();
          const st = r[0]?.storageStats;
          if (!st) return null;
          const free =
            st.freeStorageSize ??
            st.wiredTiger?.['block-manager']?.['file bytes available for reuse'] ??
            0;
          return {
            name,
            count: st.count ?? 0,
            dataSize: st.size ?? 0,
            storageSize: st.storageSize ?? 0,
            freeStorageSize: free,
            totalIndexSize: st.totalIndexSize ?? 0,
            avgObjSize: st.avgObjSize ?? 0,
            nindexes: st.nindexes ?? 0,
            indexSizes: st.indexSizes ?? {},
            capped: !!st.capped,
          } as CollectionInfo;
        } catch {
          return null; // vistas y colecciones sin permiso se omiten
        }
      }),
    );
    for (const r of results) if (r) out.push(r);
  }

  if (session.caps.top) {
    try {
      const t = await session.client.db('admin').command({ top: 1 });
      const totals = t.totals ?? {};
      const prefix = session.dbName + '.';
      const byName = new Map(out.map((x) => [x.name, x]));
      for (const [ns, v] of Object.entries<any>(totals)) {
        if (!ns.startsWith(prefix)) continue;
        const col = byName.get(ns.slice(prefix.length));
        if (!col) continue;
        col.topTotalMicros = v.total?.time ?? 0;
        col.topTotalCount = v.total?.count ?? 0;
        col.topReadMicros = v.readLock?.time ?? 0;
        col.topWriteMicros = v.writeLock?.time ?? 0;
      }
    } catch {
      /* top es per-node; si falla seguimos sin él */
    }
  }

  out.sort((a, b) => b.storageSize + b.totalIndexSize - (a.storageSize + a.totalIndexSize));
  return out;
}
