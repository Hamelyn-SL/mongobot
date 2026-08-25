// $indexStats por colección. accesses.ops cuenta desde el arranque del nodo (o la
// creación del índice) y es por-nodo: un secundario puede estar usando un índice
// que aquí aparece a cero. Ese caveat viaja con el finding, como hace pgbot.
import type { Session } from '../connect.ts';
import type { CollectionInfo } from './collections.ts';

export interface IndexInfo {
  collection: string;
  name: string;
  keyJson: string;
  ops: number;
  sinceMs: number; // epoch de accesses.since
  sizeBytes: number;
  unique: boolean;
  ttl: boolean;
  hidden: boolean;
  isId: boolean;
}

export async function collectIndexes(
  session: Session,
  collections: CollectionInfo[],
): Promise<IndexInfo[]> {
  if (!session.caps.indexStats) return [];
  const db = session.client.db(session.dbName);
  const out: IndexInfo[] = [];
  const batch = 8;
  for (let i = 0; i < collections.length; i += batch) {
    const chunk = collections.slice(i, i + batch);
    const results = await Promise.all(
      chunk.map(async (col) => {
        try {
          const stats = await db
            .collection(col.name)
            .aggregate([{ $indexStats: {} }])
            .toArray();
          return stats.map((s: any) => ({
            collection: col.name,
            name: s.name,
            keyJson: JSON.stringify(s.key ?? {}),
            ops: Number(s.accesses?.ops ?? 0),
            sinceMs: s.accesses?.since ? new Date(s.accesses.since).getTime() : 0,
            sizeBytes: col.indexSizes[s.name] ?? 0,
            unique: !!s.spec?.unique,
            ttl: s.spec?.expireAfterSeconds !== undefined,
            hidden: !!s.spec?.hidden,
            isId: s.name === '_id_',
          }));
        } catch {
          return [] as IndexInfo[];
        }
      }),
    );
    for (const r of results) out.push(...r);
  }
  return out;
}
