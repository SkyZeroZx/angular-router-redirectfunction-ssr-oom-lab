// Causal check for the proposed router fix. Copies the production build and applies it: when
// `redirectTo` is a function, `posParams` is passed as null, so its string keeps `:name` segments
// and query values as written. Compares both builds with single requests on fresh workers: a
// normal redirect, the candidate and its control.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const name = 'angular-router-redirectfunction-ssr-oom-lab';
const stockDir = join(root, 'dist', name);
const fixedDir = join(root, 'dist', name + '-fixed');

function patchOnce(source, pattern, replace, label) {
  const matches = source.match(new RegExp(pattern.source, 'g')) ?? [];
  assert.equal(matches.length, 1, `expected one ${label} site, found ${matches.length}`);
  return source.replace(pattern, replace);
}

rmSync(fixedDir, { recursive: true, force: true });
cpSync(stockDir, fixedDir, { recursive: true });
const mainFile = join(fixedDir, 'server', 'main.server.mjs');
let src = readFileSync(mainFile, 'utf8');
// ApplyRedirects.applyRedirectCommands: posParams only for a static redirectTo.
src = patchOnce(src,
  /(applyRedirectCommands\((\w+),(\w+),(\w+),\w+,\w+\)\{let (\w+)=await \w+\(\3,\w+,\w+\);if\(\5 instanceof \w+\)throw new \w+\(\5\);let \w+=this\.applyRedirectCreateUrlTree\(\5,this\.urlSerializer\.parse\(\5\),\2,)\4\)/,
  '$1typeof $3=="string"?$4:null)', 'applyRedirectCommands');
// ApplyRedirects.applyRedirectCreateUrlTree: no ':name' query copy without posParams.
src = patchOnce(src,
  /(applyRedirectCreateUrlTree\(\w+,(\w+),\w+,(\w+)\)\{let \w+=this\.createSegmentGroup\(\w+,\2\.root,\w+,\3\);return new \w+\(\w+,)(this\.createQueryParams\(\2\.queryParams,this\.urlTree\.queryParams\))/,
  '$1$3===null?$2.queryParams:$4', 'applyRedirectCreateUrlTree');
// ApplyRedirects.createSegments: no ':name' segment lookup without posParams.
src = patchOnce(src, /(createSegments\(\w+,\w+,\w+,(\w+)\)\{return \w+\.map\((\w+)=>)(\3\.path\[0\]===":"\?)/,
  '$1$2!==null&&$4', 'createSegments');
writeFileSync(mainFile, src);

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
    const req = http.request({ hostname: '127.0.0.1', port, path, agent: false, maxHeaderSize: 256 * 1024 * 1024 }, (res) => {
      let body = '';
      res.on('data', (c) => { if (path === '/stats') body += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        ms: Math.round(performance.now() - start),
        location: res.headers.location ?? '',
        ...(path === '/stats' ? { stats: JSON.parse(body) } : {}),
      }));
    });
    req.setTimeout(120000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ error: e.code ?? e.message }));
    req.end();
  });
}

const targetBytes = Number(process.argv[2] ?? 16000);
const runs = Number(process.argv[3] ?? 3);
assert(targetBytes >= 1000 && targetBytes <= 16000, 'request target must be 1000..16000 bytes');
assert(runs >= 1 && runs <= 9, 'runs must be 1..9');

async function single(dir, path) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, 'server', 'server.mjs')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
  try {
    const deadline = performance.now() + 10000;
    while ((await get(port, '/health')).status !== 200) {
      assert(performance.now() < deadline, 'worker did not start: ' + stderr);
      await new Promise((r) => setTimeout(r, 100));
    }
    // Warm-up request on a route without the redirect, so bootstrap cost is not measured.
    assert.equal((await get(port, '/restaurant/downtown/menu/lunch')).status, 200);
    const res = await get(port, path);
    const stats = (await get(port, '/stats')).stats;
    return {
      status: res.status, ms: res.ms,
      locationBytes: Buffer.byteLength(res.location),
      locationHead: res.location.slice(0, 60),
      redirectCalls: stats?.redirectCalls ?? null,
    };
  } finally {
    child.kill();
  }
}

const candidate = payload(targetBytes, false);
const control = payload(targetBytes, true);
assert.equal(candidate.path.length, control.path.length);
const cases = {
  normal: '/restaurant/downtown/menu?meal=lunch',
  candidate: candidate.path,
  control: control.path,
};
const result = { node: process.version, angular: '22.2.2', requestBytes: candidate.path.length, refs: candidate.refs, fillBytes: candidate.fillBytes, runs, stock: {}, fixed: {} };
for (const [build, dir] of [['stock', stockDir], ['fixed', fixedDir]]) {
  for (const [label, path] of Object.entries(cases)) {
    const samples = [];
    for (let i = 0; i < runs; i++) samples.push(await single(dir, path));
    for (const key of ['status', 'locationBytes', 'locationHead', 'redirectCalls']) {
      assert(samples.every((s) => s[key] === samples[0][key]), `${build} ${label}: ${key} differs between runs`);
    }
    const ms = samples.map((s) => s.ms).sort((a, b) => a - b);
    result[build][label] = { ...samples[0], ms: ms[ms.length >> 1], msRuns: samples.map((s) => s.ms) };
    console.log(build.padEnd(5), label.padEnd(9), JSON.stringify(result[build][label]));
  }
}
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'evidence', `ablation-${targetBytes}.json`), JSON.stringify(result, null, 2) + '\n');

const { stock, fixed } = result;
assert.equal(stock.normal.status, 302);
assert.equal(fixed.normal.status, 302);
assert.equal(fixed.normal.locationHead, stock.normal.locationHead, 'fix changed a normal redirect');
for (const build of [stock, fixed]) {
  for (const c of Object.values(build)) assert.equal(c.redirectCalls, 1, 'expected one redirect-function call');
}
assert(stock.candidate.locationBytes > 100 * result.requestBytes, 'stock build did not amplify');
assert(fixed.candidate.locationBytes < 2 * result.requestBytes, 'fixed build still amplifies');
console.log(`PASS: stock ${stock.candidate.locationBytes} B Location, fixed ${fixed.candidate.locationBytes} B, control ${stock.control.locationBytes} B`);
