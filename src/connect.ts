// Conexión y detección de capacidades. mongobot es read-only por contrato:
// solo ejecuta comandos de lectura/diagnóstico, nunca escrituras.
import { MongoClient } from 'mongodb';

export interface Caps {
  serverStatus: boolean;
  top: boolean;
  indexStats: boolean;
  queryStats: boolean;
  replSetGetStatus: boolean;
  oplog: boolean;
  version: string;
  user: string;
  roles: string[];
}

export interface Session {
  client: MongoClient;
  dbName: string;
  host: string;
  caps: Caps;
}

export function resolveUri(argUri?: string): string {
  const uri = argUri || process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) {
    process.stderr.write(
      'no connection string. Pass it as an argument or set $MONGODB_URI / $MONGO_URL.\n',
    );
    process.exit(64);
  }
  return uri;
}

export async function connect(argUri?: string, dbFlag?: string): Promise<Session> {
  const uri = resolveUri(argUri);
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
    appName: 'mongobot',
    maxPoolSize: 4,
    retryWrites: false,
  });
  try {
    await client.connect();
  } catch (e: any) {
    process.stderr.write(`cannot connect: ${e.message}\n`);
    process.exit(3);
  }

  const admin = client.db('admin');
  const can = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return true;
    } catch {
      return false;
    }
  };

  const [build, connStatus] = await Promise.all([
    admin.command({ buildInfo: 1 }),
    admin.command({ connectionStatus: 1 }).catch(() => null),
  ]);

  // DB objetivo: flag > path del URI > la mayor DB de usuario si hay listDatabases.
  let dbName = dbFlag || dbFromUri(uri);
  if (!dbName) {
    try {
      const l = await admin.command({ listDatabases: 1, nameOnly: false });
      const userDbs = (l.databases || []).filter(
        (d: any) => !['admin', 'local', 'config'].includes(d.name),
      );
      userDbs.sort((a: any, b: any) => (b.sizeOnDisk || 0) - (a.sizeOnDisk || 0));
      dbName = userDbs[0]?.name;
    } catch {
      /* sin permiso de listDatabases */
    }
  }
  if (!dbName) {
    process.stderr.write('cannot determine target database. Use --db <name> or a URI with a /db path.\n');
    process.exit(64);
  }
  const db = client.db(dbName);

  const someCollection = async () => {
    const cols = await db
      .listCollections({ type: 'collection' }, { nameOnly: true })
      .toArray();
    return cols.find((x) => !x.name.startsWith('system.'))?.name;
  };
  const probeCol = await someCollection().catch(() => undefined);

  const caps: Caps = {
    version: build.version,
    user: connStatus?.authInfo?.authenticatedUsers?.[0]?.user ?? '?',
    roles: (connStatus?.authInfo?.authenticatedUserRoles || []).map(
      (r: any) => `${r.role}@${r.db}`,
    ),
    serverStatus: await can(() => admin.command({ serverStatus: 1 })),
    top: await can(() => admin.command({ top: 1 })),
    indexStats: probeCol
      ? await can(() => db.collection(probeCol).aggregate([{ $indexStats: {} }]).toArray())
      : false,
    queryStats: await can(() =>
      admin.aggregate([{ $queryStats: {} }, { $limit: 1 }]).toArray(),
    ),
    replSetGetStatus: await can(() => admin.command({ replSetGetStatus: 1 })),
    oplog: await can(() =>
      client.db('local').collection('oplog.rs').findOne({}, { projection: { ts: 1 } }),
    ),
  };

  const host = hostFromUri(uri);
  return { client, dbName, host, caps };
}

export function missingCapsHint(caps: Caps): string | null {
  const missing: string[] = [];
  if (!caps.serverStatus) missing.push('serverStatus');
  if (!caps.top) missing.push('top');
  if (!caps.indexStats) missing.push('$indexStats');
  if (!caps.queryStats) missing.push('$queryStats');
  if (missing.length === 0) return null;
  return (
    `limited visibility: no ${missing.join(', ')} (current roles: ${caps.roles.join(', ') || 'none'}).\n` +
    `mongobot needs a user holding clusterMonitor. Create one (never done by mongobot itself):\n` +
    `  atlas dbusers create --username mongobot_ro --role clusterMonitor@admin,readAnyDatabase@admin\n` +
    `or in mongosh as admin:\n` +
    `  db.getSiblingDB("admin").createUser({user:"mongobot_ro", pwd:"…", roles:["clusterMonitor","readAnyDatabase"]})`
  );
}

function dbFromUri(uri: string): string | undefined {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function hostFromUri(uri: string): string {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/);
  return m ? m[1] : 'unknown-host';
}
