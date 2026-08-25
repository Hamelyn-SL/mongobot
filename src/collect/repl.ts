// Replicación: lag por miembro y ventana de oplog (el margen de recuperación
// de un secundario caído — el pariente Mongo del wraparound de pgbot).
import type { Session } from '../connect.ts';

export interface ReplInfo {
  setName: string;
  members: { name: string; state: string; healthy: boolean; lagSec: number | null }[];
  maxLagSec: number | null;
  oplogWindowHours: number | null;
}

export async function collectRepl(session: Session): Promise<ReplInfo | null> {
  if (!session.caps.replSetGetStatus) return null;
  const admin = session.client.db('admin');
  const st = await admin.command({ replSetGetStatus: 1 });
  const primary = (st.members ?? []).find((m: any) => m.stateStr === 'PRIMARY');
  const primaryOptime = primary?.optimeDate ? new Date(primary.optimeDate).getTime() : null;

  const members = (st.members ?? []).map((m: any) => {
    const opt = m.optimeDate ? new Date(m.optimeDate).getTime() : null;
    const lagSec =
      m.stateStr === 'SECONDARY' && primaryOptime && opt
        ? Math.max(0, (primaryOptime - opt) / 1000)
        : m.stateStr === 'PRIMARY'
          ? 0
          : null;
    return {
      name: m.name,
      state: m.stateStr,
      healthy: m.health === 1,
      lagSec,
    };
  });
  const lags = members.map((m: any) => m.lagSec).filter((x: any) => x !== null) as number[];

  let oplogWindowHours: number | null = null;
  if (session.caps.oplog) {
    try {
      const oplog = session.client.db('local').collection('oplog.rs');
      const [first] = await oplog
        .find({}, { projection: { ts: 1 }, sort: { $natural: 1 }, limit: 1 })
        .toArray();
      const [last] = await oplog
        .find({}, { projection: { ts: 1 }, sort: { $natural: -1 }, limit: 1 })
        .toArray();
      if (first?.ts && last?.ts) {
        const span = last.ts.getHighBits() - first.ts.getHighBits();
        oplogWindowHours = span / 3600;
      }
    } catch {
      /* sin acceso a local */
    }
  }

  return {
    setName: st.set ?? '?',
    members,
    maxLagSec: lags.length ? Math.max(...lags) : null,
    oplogWindowHours,
  };
}
