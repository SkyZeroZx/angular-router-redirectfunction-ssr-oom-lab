// The guide's snippet against the three proposed remedies, on one build.
//
//   node scripts/cases.mjs              # 4,000, 8,000 and 16,000 byte requests
//   node scripts/cases.mjs 8000
//
// Each case in src/app/app.routes.ts gets two requests: references in the `location` path
// segment (the report's request) and references as query parameters. case-doc ignores the
// query, so it only gets the first. One fresh worker per measurement, an equal-size `@z`
// control per cell, and exactly one redirect call per request.
//
// ROUTER_FIX=on measures the scripts/router-fix.mjs build, which is not built here (see
// "Toggle the fix in Docker" in the README), and expects nothing to amplify.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload, queryPayload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = 'angular-router-redirectfunction-ssr-oom-lab';
const routerFix = process.env.ROUTER_FIX ?? 'off';
assert(['on', 'off'].includes(routerFix), 'ROUTER_FIX must be on or off');
// A directory of its own, because ablation.mjs owns `-fixed` and holds the other variant.
const dist = join(root, 'dist', routerFix === 'on' ? `${name}-routerfix` : name);
const server = join(dist, 'server', 'server.mjs');
assert(existsSync(server), `no build at ${server} - see the header of this script`);

// A larger target no longer fits Node's default 16 KiB header limit.
const CANONICAL = [4000, 8000, 16000];
const sizes = [...new Set((process.argv[2] ?? CANONICAL.join(',')).split(',').map(Number))]
  .sort((a, b) => a - b);
assert(sizes.length >= 1 && sizes.every((n) => n >= 1000 && n <= 16000),
  'sizes must be 1000..16000 bytes, comma separated');

const REQUESTS = {
  path: {
    label: 'references in the `location` path segment',
    build: (c, bytes, control) => payload(bytes, control, 'destination', c.prefix, c.meal),
  },
  query: {
    label: 'references as query parameters',
    build: (c, bytes, control) => queryPayload(bytes, control, c.name),
  },
};

// `expect` is what each request should do. A case with no entry is not reachable by it.
const CASES = [
  {
    name: 'case-doc', suggestion: 'none, the guide verbatim',
    // The report's own request, on the guide's unprefixed path.
    prefix: '', meal: 'x',
    expect: { path: true },
  },
  {
    name: 'case-rawquery', suggestion: 'none, no encoder at all',
    prefix: '/case-rawquery', meal: 'lunch',
    expect: { path: true, query: true },
  },
  {
    name: 'case-keeplocation', suggestion: '`:location` placeholder',
    prefix: '/case-keeplocation', meal: 'lunch',
    expect: { path: false, query: true },
  },
  {
    name: 'case-encode', suggestion: '`encodeURIComponent` all values',
    prefix: '/case-encode', meal: 'lunch',
    expect: { path: false, query: true },
  },
  {
    name: 'case-urltree', suggestion: '`Router#createUrlTree`',
    prefix: '/case-urltree', meal: 'lunch',
    expect: { path: false, query: false },
  },
];

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function get(port, path) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request(
      { hostname: '127.0.0.1', port, path, agent: false, maxHeaderSize: 256 * 1024 * 1024 },
      (res) => {
        let body = '';
        res.on('data', (c) => { if (path === '/stats') body += c; });
        res.on('end', () => resolve({
          status: res.statusCode,
          ms: Math.round(performance.now() - start),
          // Measured, not kept, so this harness never holds a copy of the header.
          locationBytes: Buffer.byteLength(res.headers.location ?? ''),
          locationHead: (res.headers.location ?? '').slice(0, 60),
          ...(path === '/stats' ? { stats: JSON.parse(body) } : {}),
        }));
      },
    );
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

// One request on a worker of its own, after a warm-up on the case's own benign route.
async function measure(testCase, path) {
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  try {
    const deadline = performance.now() + 15000;
    while ((await get(port, '/health')).status !== 200) {
      assert(performance.now() < deadline, 'worker did not start: ' + stderr);
      await new Promise((r) => setTimeout(r, 100));
    }
    const warm = await get(port, `${testCase.prefix}/restaurant/downtown/menu?meal=lunch`);
    const res = await get(port, path);
    const { stats } = await get(port, '/stats');
    return {
      status: res.status,
      ms: res.ms,
      locationBytes: res.locationBytes,
      locationHead: res.locationHead,
      // The warm-up redirects too, so the case under test shows 2 and every other 0.
      redirectCallsByCase: stats?.redirectCallsByCase ?? {},
      warmBenign: { status: warm.status, locationBytes: warm.locationBytes },
      heapUsedBytes: stats?.heapUsedBytes ?? null,
    };
  } finally {
    child.kill();
  }
}

const expectAmplification = (testCase, request) =>
  routerFix === 'off' && testCase.expect[request] === true;

const result = {
  platform: process.platform, node: process.version, angular: '22.2.2',
  routerFix, sizes, requests: {},
};
if (routerFix === 'on') {
  console.log('ROUTER_FIX=on: the scripts/router-fix.mjs build, so nothing should amplify');
}

for (const [request, shape] of Object.entries(REQUESTS)) {
  console.log(`\n${request}: ${shape.label}\n`);
  console.log('case                 suggestion                        request   refs      candidate      ratio   out/B^2     control');
  result.requests[request] = { label: shape.label, cases: {} };
  for (const testCase of CASES) {
    if (!(request in testCase.expect)) continue;
    result.requests[request].cases[testCase.name] = {
      suggestion: testCase.suggestion,
      amplifies: expectAmplification(testCase, request),
      sizes: {},
    };
    for (const bytes of sizes) {
      const candidate = shape.build(testCase, bytes, false);
      const control = shape.build(testCase, bytes, true);
      assert.equal(Buffer.byteLength(candidate.path), Buffer.byteLength(control.path),
        `${testCase.name}/${request}: candidate and control differ in size`);
      const requestBytes = Buffer.byteLength(candidate.path);

      const cand = await measure(testCase, candidate.path);
      const ctrl = await measure(testCase, control.path);

      for (const [label, m] of [['candidate', cand], ['control', ctrl]]) {
        assert.equal(m.status, 302,
          `${testCase.name}/${request} ${label}: expected 302, got ${m.status}`);
        assert.equal(m.warmBenign.status, 302,
          `${testCase.name}/${request} ${label}: warm-up did not redirect`);
        assert.deepEqual(m.redirectCallsByCase, { [testCase.name]: 2 },
          `${testCase.name}/${request} ${label}: unexpected redirect calls ${JSON.stringify(m.redirectCallsByCase)}`);
      }

      const ratio = cand.locationBytes / requestBytes;
      const perSquare = cand.locationBytes / (requestBytes * requestBytes);
      result.requests[request].cases[testCase.name].sizes[bytes] = {
        requestBytes, references: candidate.refs, fillBytes: candidate.fillBytes,
        candidate: cand, control: ctrl,
        ratio: Number(ratio.toFixed(2)), outPerSquare: Number(perSquare.toFixed(4)),
      };
      console.log(
        `${testCase.name.padEnd(20)} ${testCase.suggestion.padEnd(33)} ${String(requestBytes).padStart(6)} B ${String(candidate.refs).padStart(5)} ${String(cand.locationBytes).padStart(12)} B ${(ratio.toFixed(1) + 'x').padStart(9)} ${perSquare.toFixed(4).padStart(9)} ${String(ctrl.locationBytes).padStart(9)} B`,
      );
    }
  }
}

// Only the canonical sizes go to evidence/, so an exploratory run can't overwrite them.
const canonical = sizes.length === CANONICAL.length && sizes.every((n, i) => n === CANONICAL[i]);
const dir = canonical ? join(root, 'evidence') : join(root, 'dist');
mkdirSync(dir, { recursive: true });
const file = join(dir, `cases-${sizes.join('-')}${routerFix === 'on' ? '-routerfix' : ''}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

// Quadratic growth makes the output/request ratio scale with the request; linear keeps it flat.
if (sizes.length >= 2) {
  const [small, large] = [sizes[0], sizes[sizes.length - 1]];
  for (const [request] of Object.entries(REQUESTS)) {
    for (const testCase of CASES) {
      if (!(request in testCase.expect)) continue;
      const at = result.requests[request].cases[testCase.name].sizes;
      const grew = at[large].ratio / at[small].ratio;
      const requestGrew = at[large].requestBytes / at[small].requestBytes;
      const where = `${testCase.name}/${request}`;
      if (expectAmplification(testCase, request)) {
        assert(grew > 0.8 * requestGrew,
          `${where}: ratio grew ${grew.toFixed(2)}x for a ${requestGrew.toFixed(2)}x request, not quadratic`);
        assert(at[large].candidate.locationBytes > 50 * at[large].control.locationBytes,
          `${where}: candidate is not far above its control`);
      } else {
        assert(grew < 1.5,
          `${where}: ratio grew ${grew.toFixed(2)}x for a ${requestGrew.toFixed(2)}x request, not linear`);
        assert(at[large].ratio < 10, `${where}: ratio ${at[large].ratio}x is too large to call linear`);
      }
    }
  }
}

const largest = sizes[sizes.length - 1];
for (const request of Object.keys(REQUESTS)) {
  const cases = result.requests[request].cases;
  const row = (n) => `${n} ${cases[n].sizes[largest].candidate.locationBytes} B`;
  console.log(`\nPASS ${request} at ${largest} B: ${Object.keys(cases).map(row).join(', ')}`);
}
console.log(file);
