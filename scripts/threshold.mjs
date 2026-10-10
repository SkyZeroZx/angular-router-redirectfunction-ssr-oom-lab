// Smallest number of concurrent requests that reaches a V8 OOM on a fresh worker.
//
//   node scripts/threshold.mjs 256 16000
//
// Walks the concurrency up from 1, one fresh worker per step, and stops at the first
// step whose stderr carries a V8 heap-limit signature. The equal-size control is then
// replayed at that same concurrency on another fresh worker, which has to survive.
// Requests go over a raw socket and the response header is counted as it streams, so
// the harness never holds a multi-megabyte `Location` of its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload, queryPayload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const heapMiB = Number(process.argv[2] ?? 256);
const targetBytes = Number(process.argv[3] ?? 16000);
const maxConcurrency = Number(process.argv[4] ?? 24);
// Which route group to aim at. `case-doc` is the guide's own snippet and the original
// report's request; the others are the suggestion cases, which need the query generator.
// See scripts/cases.mjs for what each one is.
const caseName = process.argv[5] ?? 'case-doc';
assert([128, 256, 512].includes(heapMiB), 'heap must be 128, 256 or 512 MiB');
assert(targetBytes >= 1000 && targetBytes <= 16000, 'request target must be 1000..16000 bytes');
assert(/^case-[a-z]+$/.test(caseName), 'case must look like case-<name>');
const server = join(root, 'dist', 'angular-router-redirectfunction-ssr-oom-lab', 'server', 'server.mjs');

const build = (control) => caseName === 'case-doc'
  ? payload(targetBytes, control)
  : queryPayload(targetBytes, control, caseName);
const candidate = build(false);
const control = build(true);
assert.equal(Buffer.byteLength(candidate.path), Buffer.byteLength(control.path));

async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

// Streaming request: counts the Location bytes without ever retaining them.
function request(port, path, timeoutMs = 300000) {
  return new Promise((resolve) => {
    const start = performance.now();
    let status = null;
    let pending = '';
    let draining = false;
    let locationBytes = 0;
    let locationHead = '';
    let settled = false;
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`, 'latin1');
    });
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      pending += chunk.toString('latin1');
      while (true) {
        const nl = pending.indexOf('\n');
        if (nl < 0) break;
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        // Tail of a Location line whose bulk was already counted below.
        if (draining) {
          locationBytes += line.replace(/\r$/, '').length;
          draining = false;
          continue;
        }
        if (status === null) { status = Number(line.split(' ')[1]); continue; }
        if (/^location:/i.test(line)) {
          locationBytes += line.replace(/\r$/, '').length - 'Location: '.length;
          locationHead ||= line.slice(10, 70);
        }
        if (line === '\r' || line === '') { socket.destroy(); return; }
      }
      // A multi-megabyte Location arrives as one very long line: count and discard it.
      if (pending.length > 1 << 16) {
        if (!draining && /^location:/i.test(pending)) {
          draining = true;
          locationHead ||= pending.slice(10, 70);
          locationBytes -= 'Location: '.length;
        }
        if (draining) { locationBytes += pending.length; pending = ''; }
      }
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve({ status, ms: Math.round(performance.now() - start), locationBytes, locationHead });
    };
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ error: error.code ?? error.message, ms: Math.round(performance.now() - start) });
    });
  });
}

async function stats(port) {
  const raw = await new Promise((resolve) => {
    let body = '';
    const s = net.connect(port, '127.0.0.1', () => s.write('GET /stats HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    s.setTimeout(10000, () => s.destroy());
    s.on('data', (chunk) => { body += chunk.toString('latin1'); });
    s.on('close', () => resolve(body));
    s.on('error', () => resolve(''));
  });
  try { return JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)); } catch { return null; }
}

async function trial(controlMode, concurrency) {
  const port = await freePort();
  const child = spawn(process.execPath, [`--max-old-space-size=${heapMiB}`, server], {
    cwd: root,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  let stderr = '';
  let exit = null;
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-5000); });
  child.on('exit', (code, signal) => { exit = { code, signal }; });
  try {
    const deadline = performance.now() + 15000;
    let ready = false;
    while (performance.now() < deadline && !exit) {
      if ((await request(port, '/health', 5000)).status === 200) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(ready, 'SSR worker did not start: ' + stderr);
    const path = controlMode ? control.path : candidate.path;
    const started = performance.now();
    const responses = await Promise.all(
      Array.from({ length: concurrency }, () => request(port, path)),
    );
    const totalMs = Math.round(performance.now() - started);
    if (!exit) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    return {
      control: controlMode, concurrency, totalMs, exit,
      v8Oom: /Reached heap limit|JavaScript heap out of memory/.test(stderr),
      ok302: responses.filter((r) => r.status === 302).length,
      locationBytes: Math.max(0, ...responses.map((r) => r.locationBytes ?? 0)),
      locationHead: responses.find((r) => r.locationBytes)?.locationHead ?? '',
      slowestMs: Math.max(...responses.map((r) => r.ms)),
      redirectCalls: exit ? null : (await stats(port))?.redirectCalls ?? null,
      stderrTail: stderr.slice(-800),
    };
  } finally {
    if (!exit) child.kill();
  }
}

const result = {
  platform: process.platform, node: process.version, angular: '22.2.2',
  heapMiB, targetBytes, caseName,
  requestBytes: Buffer.byteLength(candidate.path),
  refs: candidate.refs, fillBytes: candidate.fillBytes,
  steps: [], minOomConcurrency: null, controlAtThreshold: null,
};
mkdirSync(join(root, 'evidence'), { recursive: true });
const suffix = caseName === 'case-doc' ? '' : `-${caseName}`;
const file = join(root, 'evidence', `threshold-${heapMiB}-${targetBytes}${suffix}.json`);
const save = () => writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

for (let n = 1; n <= maxConcurrency; n++) {
  const step = await trial(false, n);
  result.steps.push(step);
  console.log(`n=${String(n).padStart(2)} oom=${step.v8Oom} exit=${JSON.stringify(step.exit)} 302=${step.ok302}/${n} location=${step.locationBytes} slowest=${step.slowestMs}ms calls=${step.redirectCalls}`);
  save();
  if (step.v8Oom) { result.minOomConcurrency = n; break; }
}
assert(result.minOomConcurrency, `no V8 OOM up to ${maxConcurrency} concurrent requests`);
result.controlAtThreshold = await trial(true, result.minOomConcurrency);
save();
const c = result.controlAtThreshold;
console.log(`control n=${c.concurrency}: oom=${c.v8Oom} 302=${c.ok302}/${c.concurrency} location=${c.locationBytes} calls=${c.redirectCalls} ${c.totalMs}ms`);
assert.equal(c.v8Oom, false, 'equal-size control also OOMed');
assert.equal(c.ok302, c.concurrency, 'equal-size control did not answer every request');
assert.equal(c.redirectCalls, c.concurrency, 'control made more than one redirect call per request');
console.log(`PASS ${caseName} ${heapMiB} MiB / ${targetBytes} B: V8 OOM at ${result.minOomConcurrency} concurrent request(s); control survives ${c.concurrency}`);
console.log(file);
