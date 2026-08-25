import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../src/findings.ts';
import { aggregateShapes } from '../src/collect/queries.ts';
import { humanBytes, humanMs, fnv1a } from '../src/format.ts';
import type { Snapshot } from '../src/baseline.ts';
import type { ServerMetrics } from '../src/collect/server.ts';

const HOUR = 3600;

function fakeServer(over: Partial<ServerMetrics['sample']> = {}): ServerMetrics {
  return {
    intervalSec: 1,
    rates: {
      opsPerSec: 100,
      collScansPerSec: 0,
      scannedObjectsPerSec: 100,
      docsReturnedPerSec: 100,
      scanRatio: 1,
      cacheHit: 0.999,
    },
    sample: {
      ts: Date.now(),
      uptime: 72 * HOUR,
      host: 'test',
      version: '8.0.0',
      connections: { current: 100, available: 900, active: 10, totalCreated: 1000 },
      opcounters: {},
      scannedKeys: 0,
      scannedObjects: 1e6,
      collectionScans: 1000,
      docsReturned: 1e6,
      cachePagesRequested: 1e6,
      cachePagesRead: 100,
      cacheBytesCurrent: 5e8,
      cacheBytesMax: 1e9,
      cacheBytesDirty: 1e7,
      cursorsOpen: 10,
      cursorsTimedOut: 0,
      assertsUser: 0,
      assertsRegular: 0,
      queueReaders: 0,
      queueWriters: 0,
      memResidentMB: 1000,
      ...over,
    },
  };
}

const emptyInput = {
  server: fakeServer(),
  collections: [],
  indexes: [],
  queries: [],
  repl: null,
  baseline: null,
};

test('healthy input yields high score and GOOD entries', () => {
  const a = analyze(emptyInput);
  assert.ok(a.score >= 95, `score was ${a.score}`);
  assert.ok(a.good.some((g) => g.subsystem === 'connections'));
});

test('connection saturation is critical', () => {
  const a = analyze({
    ...emptyInput,
    server: fakeServer({ connections: { current: 960, available: 40, active: 500, totalCreated: 0 } }),
  });
  assert.ok(a.findings.some((f) => f.id === 'connections-critical'));
  assert.ok(a.score <= 85);
});

test('unused index over 1GiB is a warning with caveat', () => {
  const a = analyze({
    ...emptyInput,
    indexes: [
      {
        collection: 'orders',
        name: 'big_1',
        keyJson: '{"big":1}',
        ops: 0,
        sinceMs: 0,
        sizeBytes: 2 * 2 ** 30,
        unique: false,
        ttl: false,
        hidden: false,
        isId: false,
      },
    ],
  });
  const f = a.findings.find((x) => x.id === 'unused-indexes');
  assert.ok(f && f.severity === 'warning' && f.caveat?.includes('secondary'));
});

test('query regression against a mature baseline builds a causal chain', () => {
  const hash = fnv1a('Shop.orders|find orders {status}');
  const now = {
    hash,
    display: 'find orders {status}',
    namespace: 'Shop.orders',
    command: 'find',
    execCount: 11_000,
    totalMicros: 1_100e6, // ventana: 1000 calls × 1s tras baseline de 10k×10ms
    maxMicros: 0,
    meanMs: 100,
    docsReturned: 110_000,
    docsExamined: 501_000_000,
    keysExamined: null,
    examinedPerReturned: 4554,
  };
  const baseline: Snapshot = {
    schema: 1,
    ts: Date.now() - HOUR * 1000, // hace 1h en ms
    host: 'test',
    db: 'Shop',
    serverVersion: '8.0.0',
    uptime: 71 * HOUR, // menor que el uptime actual: misma época
    server: fakeServer().sample,
    collections: [
      {
        name: 'orders',
        count: 1_000_000,
        dataSize: 0,
        storageSize: 2 ** 31,
        freeStorageSize: 0,
        totalIndexSize: 0,
      },
    ],
    indexes: [],
    queries: [
      {
        hash,
        display: 'find orders {status}',
        namespace: 'Shop.orders',
        execCount: 10_000,
        totalMicros: 100e6, // mean histórico 10ms
        docsExamined: 1_000_000,
        docsReturned: 100_000,
      },
    ],
    repl: null,
  };
  const a = analyze({
    ...emptyInput,
    collections: [
      {
        name: 'orders',
        count: 1_300_000, // +30%
        dataSize: 0,
        storageSize: 2 ** 31,
        freeStorageSize: 0,
        totalIndexSize: 0,
        avgObjSize: 0,
        nindexes: 1,
        indexSizes: {},
        capped: false,
      },
    ],
    queries: [now],
    baseline,
  });
  const reg = a.findings.find((f) => f.id === `query-slower-${hash}`);
  assert.ok(reg, 'expected a query-slower finding');
  assert.match(reg!.title, /slowed/);
  assert.ok(reg!.chain!.some((ch) => ch.includes('examines')), 'mechanism link');
  assert.ok(reg!.chain!.some((ch) => ch.includes('grew')), 'antecedent link');
  assert.ok(reg!.confidence! >= 0.8);
});

test('cold baseline (<10min) suppresses regressions', () => {
  const hash = fnv1a('Shop.orders|find orders {status}');
  const baseline = {
    schema: 1,
    ts: Date.now() - 15_000,
    host: 'test',
    db: 'Shop',
    serverVersion: '8.0.0',
    uptime: 71 * HOUR,
    server: fakeServer().sample,
    collections: [],
    indexes: [],
    queries: [
      {
        hash,
        display: 'find orders {status}',
        namespace: 'Shop.orders',
        execCount: 10_000,
        totalMicros: 100e6,
        docsExamined: 1_000_000,
        docsReturned: 100_000,
      },
    ],
    repl: null,
  } as Snapshot;
  const a = analyze({
    ...emptyInput,
    queries: [
      {
        hash,
        display: 'find orders {status}',
        namespace: 'Shop.orders',
        command: 'find',
        execCount: 11_000,
        totalMicros: 1_100e6,
        maxMicros: 0,
        meanMs: 100,
        docsReturned: 110_000,
        docsExamined: 501_000_000,
        keysExamined: null,
        examinedPerReturned: 4554,
      },
    ],
    baseline,
  });
  assert.ok(!a.findings.some((f) => f.id.startsWith('query-slower-')));
});

test('aggregateShapes merges variants of the same logical shape', () => {
  const mk = (execCount: number, totalMicros: number) => ({
    display: 'find x {a}',
    namespace: 'db.x',
    command: 'find',
    execCount,
    totalMicros,
    maxMicros: 0,
    docsReturned: execCount,
    docsExamined: execCount * 10,
    keysExamined: null,
  });
  const out = aggregateShapes([mk(100, 1e6), mk(300, 9e6)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].execCount, 400);
  assert.equal(out[0].totalMicros, 1e7);
  assert.ok(Math.abs(out[0].meanMs - 25) < 0.01);
  assert.equal(out[0].examinedPerReturned, 10);
});

test('atlas layer: disk critical, cpu warning, suggested index crossed with queryStats', () => {
  const a = analyze({
    ...emptyInput,
    queries: [
      {
        hash: 'x',
        display: 'find reviews {status, flag}',
        namespace: 'Shop.reviews',
        command: 'find',
        execCount: 5000,
        totalMicros: 5000 * 900_000,
        maxMicros: 0,
        meanMs: 900,
        docsReturned: 5000,
        docsExamined: 5000 * 49_000,
        keysExamined: null,
        examinedPerReturned: 49_000,
      },
    ],
    atlas: {
      groupId: 'g',
      clusterName: 'Cluster0',
      tier: 'M40',
      mongoVersion: '8.3.8',
      diskSizeGB: 500,
      primaryProcess: 'h:27017',
      cpuPercent: 82,
      diskPercentUsed: 93,
      diskIops: 1000,
      suggestedIndexes: [
        {
          namespace: 'Shop.reviews',
          indexJson: '{"status":1,"flag":1}',
          weight: 120,
          shapeCount: 3,
          avgQueryMs: 850,
        },
      ],
      slowNamespaces: ['Shop.reviews'],
      events: [],
      errors: [],
    },
  });
  assert.ok(a.findings.some((f) => f.id === 'disk-space-critical'));
  assert.ok(a.findings.some((f) => f.id === 'cpu-high'));
  const sug = a.findings.find((f) => f.id.startsWith('atlas-suggested-index-'));
  assert.ok(sug && sug.chain!.some((ch) => ch.includes('$queryStats')), 'cross-reference chain');
});

test('formatters', () => {
  assert.equal(humanBytes(2 ** 30), '1.00 GiB');
  assert.equal(humanMs(1500), '1.50s');
  assert.equal(fnv1a('x'), fnv1a('x'));
  assert.notEqual(fnv1a('x'), fnv1a('y'));
});
