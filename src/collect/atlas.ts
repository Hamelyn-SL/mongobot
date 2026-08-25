// Capa Atlas Admin API: lo que el servidor no puede contarte por la conexión
// (CPU y disco del host, Performance Advisor, eventos del cluster). Igual que
// el resto de mongobot: solo GETs, y sin credenciales degrada en silencio.
//
// Auth, en orden: ATLAS_CLIENT_ID/ATLAS_CLIENT_SECRET (service account OAuth)
// o ATLAS_PUBLIC_KEY/ATLAS_PRIVATE_KEY (API key, HTTP digest).
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const BASE = 'https://cloud.mongodb.com';
const MEDIA = 'application/vnd.atlas.2023-01-01+json';

export interface AtlasSuggestedIndex {
  namespace: string;
  indexJson: string; // [{"field":1},...] legible
  weight: number; // mejora estimada por Atlas
  shapeCount: number;
  avgQueryMs: number | null;
}

export interface AtlasEvent {
  type: string;
  created: string; // ISO
  summary: string;
}

export interface AtlasInfo {
  groupId: string;
  clusterName: string;
  tier: string | null;
  mongoVersion: string | null;
  diskSizeGB: number | null;
  primaryProcess: string | null;
  cpuPercent: number | null; // media normalizada 15min del primario
  diskPercentUsed: number | null; // partición de datos del primario
  diskIops: number | null;
  suggestedIndexes: AtlasSuggestedIndex[];
  slowNamespaces: string[];
  events: AtlasEvent[]; // últimos, filtrados a los que importan
  errors: string[]; // colectores parciales que fallaron
}

type Auth =
  | { kind: 'oauth'; token: string }
  | { kind: 'digest'; user: string; pass: string };

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

async function digestFetch(auth: { user: string; pass: string }, url: string): Promise<Response> {
  const probe = await fetch(url, { headers: { accept: MEDIA } });
  if (probe.status !== 401) return probe;
  const chal = probe.headers.get('www-authenticate') ?? '';
  const param = (k: string) => chal.match(new RegExp(`${k}="?([^",]+)"?`))?.[1];
  const realm = param('realm') ?? '';
  const nonce = param('nonce') ?? '';
  const qop = param('qop') ?? 'auth';
  const uri = new URL(url).pathname + new URL(url).search;
  const cnonce = randomBytes(8).toString('hex');
  const nc = '00000001';
  const ha1 = md5(`${auth.user}:${realm}:${auth.pass}`);
  const ha2 = md5(`GET:${uri}`);
  const response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  const header =
    `Digest username="${auth.user}", realm="${realm}", nonce="${nonce}", uri="${uri}", ` +
    `qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
  return fetch(url, { headers: { accept: MEDIA, authorization: header } });
}

async function resolveAuth(): Promise<Auth | null> {
  const { ATLAS_CLIENT_ID, ATLAS_CLIENT_SECRET, ATLAS_PUBLIC_KEY, ATLAS_PRIVATE_KEY } =
    process.env;
  if (ATLAS_CLIENT_ID && ATLAS_CLIENT_SECRET) {
    const basic = Buffer.from(`${ATLAS_CLIENT_ID}:${ATLAS_CLIENT_SECRET}`).toString('base64');
    const r = await fetch(`${BASE}/api/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`atlas oauth failed: HTTP ${r.status}`);
    const body: any = await r.json();
    return { kind: 'oauth', token: body.access_token };
  }
  if (ATLAS_PUBLIC_KEY && ATLAS_PRIVATE_KEY)
    return { kind: 'digest', user: ATLAS_PUBLIC_KEY, pass: ATLAS_PRIVATE_KEY };
  return null;
}

async function get(auth: Auth, path: string, timeoutMs = 20_000): Promise<any> {
  const url = `${BASE}${path}`;
  const r =
    auth.kind === 'oauth'
      ? await fetch(url, {
          headers: { accept: MEDIA, authorization: `Bearer ${auth.token}` },
          signal: AbortSignal.timeout(timeoutMs),
        })
      : await digestFetch(auth, url);
  if (!r.ok) throw new Error(`GET ${path} -> HTTP ${r.status}`);
  return r.json();
}

// --- discovery con caché: host del URI -> {groupId, clusterName, hosts} ---
interface Discovery {
  groupId: string;
  clusterName: string;
  hosts: string[]; // hostnames reales de los nodos de ESTE cluster
  cachedAt: number;
}

function clusterHosts(cl: any): string[] {
  const std: string = cl.connectionStrings?.standard ?? '';
  const m = std.match(/^mongodb:\/\/([^/?]+)/);
  if (!m) return [];
  return m[1].split(',').map((h: string) => h.split(':')[0]);
}

function cacheFile(): string {
  const base =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.trim() !== ''
      ? process.env.XDG_STATE_HOME
      : join(homedir(), '.local', 'state');
  return join(base, 'mongobot', 'atlas-discovery.json');
}

function readCache(): Record<string, Discovery> {
  try {
    return JSON.parse(readFileSync(cacheFile(), 'utf8'));
  } catch {
    return {};
  }
}

async function discover(auth: Auth, srvHost: string): Promise<Discovery> {
  const cache = readCache();
  const hit = cache[srvHost];
  if (hit && hit.hosts?.length && Date.now() - hit.cachedAt < 24 * 3600 * 1000) return hit;

  const envGid = process.env.ATLAS_PROJECT_ID;
  const groups = envGid
    ? [{ id: envGid }]
    : ((await get(auth, '/api/atlas/v2/groups?itemsPerPage=100')).results ?? []);
  for (const g of groups) {
    const clusters = (await get(auth, `/api/atlas/v2/groups/${g.id}/clusters?itemsPerPage=100`))
      .results ?? [];
    for (const cl of clusters) {
      const srv: string = cl.connectionStrings?.standardSrv ?? '';
      if (srv.includes(srvHost)) {
        const d = {
          groupId: g.id,
          clusterName: cl.name,
          hosts: clusterHosts(cl),
          cachedAt: Date.now(),
        };
        cache[srvHost] = d;
        mkdirSync(join(cacheFile(), '..'), { recursive: true });
        writeFileSync(cacheFile(), JSON.stringify(cache));
        return d;
      }
    }
  }
  throw new Error(`no Atlas cluster matches host ${srvHost} across accessible projects`);
}

const latest = (series: any[], name: string): number | null => {
  const m = series.find((x: any) => x.name === name);
  const pts = (m?.dataPoints ?? []).filter((p: any) => p.value !== null);
  return pts.length ? pts[pts.length - 1].value : null;
};
const avg = (series: any[], name: string): number | null => {
  const m = series.find((x: any) => x.name === name);
  const pts = (m?.dataPoints ?? []).filter((p: any) => p.value !== null);
  return pts.length ? pts.reduce((a: number, p: any) => a + p.value, 0) / pts.length : null;
};

const RELEVANT_EVENTS = [
  'PRIMARY_ELECTED',
  'HOST_DOWN',
  'HOST_UP',
  'HOST_RESTARTED',
  'CLUSTER_INSTANCE_REPLACED',
  'CLUSTER_INSTANCE_RESTARTED',
  'COMPUTE_AUTO_SCALE_INITIATED',
  'DISK_AUTO_SCALE_INITIATED',
  'CLUSTER_MONGOS_IS_MISSING',
  'OUTSIDE_METRIC_THRESHOLD',
];

export async function collectAtlas(srvHost: string): Promise<AtlasInfo | null> {
  const auth = await resolveAuth();
  if (!auth) return null;

  const { groupId, clusterName, hosts } = await discover(auth, srvHost);
  const hostSet = new Set(hosts.map((h) => h.toLowerCase()));
  const info: AtlasInfo = {
    groupId,
    clusterName,
    tier: null,
    mongoVersion: null,
    diskSizeGB: null,
    primaryProcess: null,
    cpuPercent: null,
    diskPercentUsed: null,
    diskIops: null,
    suggestedIndexes: [],
    slowNamespaces: [],
    events: [],
    errors: [],
  };
  const attempt = async (label: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e: any) {
      info.errors.push(`${label}: ${String(e.message).slice(0, 120)}`);
    }
  };

  await attempt('cluster', async () => {
    const cl = await get(auth, `/api/atlas/v2/groups/${groupId}/clusters/${clusterName}`);
    info.tier =
      cl.replicationSpecs?.[0]?.regionConfigs?.[0]?.electableSpecs?.instanceSize ??
      cl.providerSettings?.instanceSizeName ??
      null;
    info.mongoVersion = cl.mongoDBVersion ?? null;
    info.diskSizeGB = cl.diskSizeGB ?? null;
  });

  let primary: string | null = null;
  await attempt('processes', async () => {
    const procs = (await get(auth, `/api/atlas/v2/groups/${groupId}/processes?itemsPerPage=100`))
      .results ?? [];
    // un proyecto puede alojar varios clusters: quedarse SOLO con los nodos del
    // cluster resuelto por el SRV. El connection string trae los hostnames
    // legacy; en processes ese nombre viaja en userAlias (id trae el moderno).
    const mine = hostSet.size
      ? procs.filter(
          (p: any) =>
            hostSet.has(String(p.userAlias ?? '').toLowerCase()) ||
            hostSet.has(String(p.hostname ?? (p.id ?? '').split(':')[0]).toLowerCase()),
        )
      : procs;
    // los eventos y measurements usan el hostname moderno: añadirlo al set
    for (const p of mine) hostSet.add(String((p.id ?? '').split(':')[0]).toLowerCase());
    const prim = mine.find((p: any) => p.typeName === 'REPLICA_PRIMARY') ?? mine[0];
    primary = prim ? prim.id : null;
    info.primaryProcess = primary;
    if (!primary) throw new Error(`no process matches cluster hosts (${hosts.length} known)`);
  });

  if (primary) {
    await attempt('cpu', async () => {
      const r = await get(
        auth,
        `/api/atlas/v2/groups/${groupId}/processes/${primary}/measurements?granularity=PT1M&period=PT15M` +
          `&m=SYSTEM_NORMALIZED_CPU_USER&m=SYSTEM_NORMALIZED_CPU_KERNEL&m=SYSTEM_NORMALIZED_CPU_IOWAIT`,
      );
      const u = avg(r.measurements ?? [], 'SYSTEM_NORMALIZED_CPU_USER') ?? 0;
      const k = avg(r.measurements ?? [], 'SYSTEM_NORMALIZED_CPU_KERNEL') ?? 0;
      info.cpuPercent = u + k;
    });
    await attempt('disk', async () => {
      const disks = (await get(
        auth,
        `/api/atlas/v2/groups/${groupId}/processes/${primary}/disks?itemsPerPage=10`,
      )).results ?? [];
      const part = disks.find((d: any) => d.partitionName === 'data') ?? disks[0];
      if (!part) return;
      const r = await get(
        auth,
        `/api/atlas/v2/groups/${groupId}/processes/${primary}/disks/${part.partitionName}/measurements?granularity=PT1M&period=PT15M`,
      );
      const s = r.measurements ?? [];
      info.diskPercentUsed =
        latest(s, 'DISK_PARTITION_SPACE_PERCENT_USED') ??
        latest(s, 'DISK_PARTITION_SPACE_USED_PERCENT');
      const read = avg(s, 'DISK_PARTITION_IOPS_READ') ?? 0;
      const write = avg(s, 'DISK_PARTITION_IOPS_WRITE') ?? 0;
      info.diskIops = read + write || (avg(s, 'DISK_PARTITION_IOPS_TOTAL') ?? null);
    });
    await attempt('performance-advisor', async () => {
      // el PA analiza logs al vuelo: en un cluster cargado puede tardar
      const r = await get(
        auth,
        `/api/atlas/v2/groups/${groupId}/processes/${primary}/performanceAdvisor/suggestedIndexes`,
        90_000,
      );
      const shapes = new Map<string, any>((r.shapes ?? []).map((s: any) => [s.id, s]));
      info.suggestedIndexes = (r.suggestedIndexes ?? []).map((s: any) => {
        const impacted = (s.impact ?? []).map((id: string) => shapes.get(id)).filter(Boolean);
        const avgMs = impacted.length
          ? impacted.reduce((a: number, sh: any) => a + (sh.avgMs ?? 0), 0) / impacted.length
          : null;
        return {
          namespace: s.namespace,
          indexJson: JSON.stringify((s.index ?? []).reduce((acc: any, f: any) => Object.assign(acc, f), {})),
          weight: s.weight ?? 0,
          shapeCount: (s.impact ?? []).length,
          avgQueryMs: avgMs,
        };
      });
      info.suggestedIndexes.sort((a, b) => b.weight - a.weight);
    });
    await attempt('slow-namespaces', async () => {
      const r = await get(
        auth,
        `/api/atlas/v2/groups/${groupId}/processes/${primary}/performanceAdvisor/namespaces`,
      );
      info.slowNamespaces = (r.namespaces ?? []).map((n: any) => n.namespace).slice(0, 10);
    });
  }

  await attempt('events', async () => {
    const minDate = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const r = await get(
      auth,
      `/api/atlas/v2/groups/${groupId}/events?minDate=${encodeURIComponent(minDate)}&itemsPerPage=200`,
    );
    info.events = (r.results ?? [])
      .filter((e: any) => RELEVANT_EVENTS.includes(e.eventTypeName))
      .filter(
        (e: any) => !e.hostname || !hostSet.size || hostSet.has(String(e.hostname).toLowerCase()),
      )
      .map((e: any) => ({
        type: e.eventTypeName,
        created: e.created,
        summary: [
          e.eventTypeName.toLowerCase().replace(/_/g, ' '),
          e.metricName ?? e.raw?.metricName ?? '',
          e.hostname ?? '',
        ]
          .filter(Boolean)
          .join(' · '),
      }))
      .slice(0, 20);
  });

  return info;
}
