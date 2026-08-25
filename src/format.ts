// Formateo humano de números y colores ANSI (sin dependencias).

const wantColor =
  process.env.NO_COLOR === undefined &&
  process.argv.indexOf('--no-color') === -1 &&
  process.stdout.isTTY !== false;

const wrap = (code: string) => (s: string) =>
  wantColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  red: wrap('31'),
  yellow: wrap('33'),
  green: wrap('32'),
  cyan: wrap('36'),
  dim: wrap('2'),
  bold: wrap('1'),
};

export function humanBytes(n: number): string {
  if (!isFinite(n)) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

export function humanNum(n: number): string {
  if (!isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n * 10) / 10);
}

export function humanMs(ms: number): string {
  if (!isFinite(ms)) return '—';
  if (ms >= 60_000) return (ms / 60_000).toFixed(1) + 'm';
  if (ms >= 1000) return (ms / 1000).toFixed(2) + 's';
  if (ms >= 10) return ms.toFixed(0) + 'ms';
  if (ms >= 1) return ms.toFixed(1) + 'ms';
  return ms.toFixed(2) + 'ms';
}

export function humanDur(seconds: number): string {
  if (!isFinite(seconds)) return '—';
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? (s % 60) + 's' : ''}`;
  if (s < 86400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h${m ? m + 'm' : ''}`;
  }
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return `${d}d${h ? h + 'h' : ''}`;
}

export function pct(x: number, digits = 1): string {
  if (!isFinite(x)) return '—';
  return (x * 100).toFixed(digits) + '%';
}

// Ratio compacto para "3.2×"
export function times(x: number): string {
  if (!isFinite(x)) return '—';
  return (x >= 10 ? x.toFixed(0) : x.toFixed(1)) + '×';
}

export function padTable(rows: string[][], indent = '  '): string {
  if (rows.length === 0) return '';
  const widths: number[] = [];
  for (const row of rows)
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, stripAnsi(cell).length);
    });
  return rows
    .map(
      (row) =>
        indent +
        row
          .map((cell, i) =>
            i === row.length - 1 ? cell : cell + ' '.repeat(widths[i] - stripAnsi(cell).length),
          )
          .join('  '),
    )
    .join('\n');
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// Hash FNV-1a para identificar shapes de query de forma estable.
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
