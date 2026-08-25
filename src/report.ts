// Render del informe: findings-first, con score y lista GOOD — el formato pgbot.
// El texto humano NO es interfaz estable; --json sí (contrato versionado).
import type { Analysis, Finding } from './findings.ts';
import type { Session } from './connect.ts';
import type { AtlasInfo } from './collect/atlas.ts';
import { c } from './format.ts';

export const JSON_SCHEMA_VERSION = '1.1.0';

function atlasLine(atlas: AtlasInfo | null | undefined): string | null {
  if (atlas === null || atlas === undefined)
    return c.dim(
      'atlas layer off — set ATLAS_CLIENT_ID/ATLAS_CLIENT_SECRET for host CPU/disk, index advice and cluster events',
    );
  const bits = [`atlas ${atlas.clusterName}`];
  if (atlas.tier) bits.push(atlas.tier);
  if (atlas.diskPercentUsed !== null) bits.push(`disk ${atlas.diskPercentUsed.toFixed(0)}%`);
  if (atlas.cpuPercent !== null) bits.push(`cpu ${atlas.cpuPercent.toFixed(0)}%`);
  bits.push(`advisor ${atlas.suggestedIndexes.length} suggestions`);
  if (atlas.errors.length) bits.push(`${atlas.errors.length} collectors degraded`);
  return c.dim(bits.join(' · '));
}

export function renderHeader(session: Session, extra: string): string {
  const parts = [
    'connected',
    session.host,
    `mongodb ${session.caps.version}`,
    `db ${session.dbName}`,
    'read-only',
    extra,
  ].filter(Boolean);
  return c.dim(parts.join(' · '));
}

function bullet(f: Finding): string {
  let s = `● ${f.title}`;
  if (f.chain?.length) s += '\n' + f.chain.map((ch) => `  ↳ ${ch}`).join('\n');
  if (f.confidence !== undefined) s += `\n  ↳ confidence ${(f.confidence * 100).toFixed(0)}%`;
  if (f.detail) s += `\n  ${c.dim(f.detail)}`;
  if (f.caveat) s += `\n  ${c.dim('caveat: ' + f.caveat)}`;
  return s;
}

export function renderInspect(
  session: Session,
  a: Analysis,
  atlas?: AtlasInfo | null,
): string {
  const lines: string[] = [];
  lines.push(renderHeader(session, a.windowText));
  const al = atlasLine(atlas);
  if (al) lines.push(al);
  lines.push('');
  const scoreColor = a.score >= 90 ? c.green : a.score >= 70 ? c.yellow : c.red;
  lines.push(c.bold(`Database health: ${scoreColor(`${a.score}/100`)}`));
  lines.push('');

  const groups: [string, (s: string) => string, Finding[]][] = [
    ['CRITICAL', c.red, a.findings.filter((f) => f.severity === 'critical')],
    ['WARNING', c.yellow, a.findings.filter((f) => f.severity === 'warning')],
    ['NOTE', c.cyan, a.findings.filter((f) => f.severity === 'note')],
  ];
  for (const [label, color, items] of groups) {
    if (!items.length) continue;
    lines.push(color(c.bold(label)));
    for (const f of items) lines.push(color(bullet(f)));
    lines.push('');
  }
  if (!a.findings.length) {
    lines.push(c.green('no findings — nothing to flag in this window'));
    lines.push('');
  }
  if (a.good.length) {
    lines.push(c.green(c.bold('GOOD')));
    for (const g of a.good) lines.push(c.green(`● ${g.subsystem} ${g.value}`));
    lines.push('');
  }
  lines.push(c.dim('Details: mongobot collections · queries · indexes   ·   Machine-readable: --json'));
  return lines.join('\n');
}

export function toJson(session: Session, a: Analysis, atlas?: AtlasInfo | null): string {
  return JSON.stringify(
    {
      schema_version: JSON_SCHEMA_VERSION,
      generated_at: new Date().toISOString(),
      host: session.host,
      database: session.dbName,
      server_version: session.caps.version,
      window: a.windowText,
      score: a.score,
      findings: a.findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        title: f.title,
        detail: f.detail ?? null,
        caveat: f.caveat ?? null,
        confidence: f.confidence ?? null,
        chain: f.chain ?? [],
      })),
      good: a.good,
      atlas: atlas
        ? {
            cluster: atlas.clusterName,
            tier: atlas.tier,
            disk_percent_used: atlas.diskPercentUsed,
            cpu_percent: atlas.cpuPercent,
            suggested_indexes: atlas.suggestedIndexes,
            slow_namespaces: atlas.slowNamespaces,
            events: atlas.events,
            degraded_collectors: atlas.errors,
          }
        : null,
    },
    null,
    2,
  );
}

export function exitCodeFor(a: Analysis, failOn: string): number {
  const hasCrit = a.findings.some((f) => f.severity === 'critical');
  const hasWarn = a.findings.some((f) => f.severity === 'warning');
  if (failOn === 'none') return 0;
  if (failOn === 'critical') return hasCrit ? 2 : 0;
  // default: warn
  return hasCrit ? 2 : hasWarn ? 1 : 0;
}
