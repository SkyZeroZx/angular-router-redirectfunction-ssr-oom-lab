// Writes curl config files for a manual run, so the request target never has to
// survive shell quoting (it contains &, ?, $, ' and *).
//
//   node scripts/curl-urls.mjs 8000 12 4000
//   curl -Z -s -K dist/curl-candidate.txt -w "%{http_code} header=%{size_header}B %{time_total}s\n"
//
// Files land in dist/, which .gitignore already covers.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { payload } from './payload.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targetBytes = Number(process.argv[2] ?? 8000);
const count = Number(process.argv[3] ?? 12);
const port = Number(process.argv[4] ?? 4000);
assert(targetBytes >= 100 && targetBytes <= 16000, 'request target must be 100..16000 bytes');
assert(count >= 1 && count <= 256, 'count must be 1..256');

const out = join(root, 'dist');
mkdirSync(out, { recursive: true });

for (const [name, control] of [['candidate', false], ['control', true]]) {
  const { path, refs } = payload(targetBytes, control);
  // curl config: double quotes are literal here, no shell expansion. The generator's
  // alphabet never emits a double quote or a backslash, so no escaping is needed.
  assert(!/["\\]/.test(path), 'request target would need escaping in a curl config');
  const body = Array.from({ length: count }, () => `url = "http://127.0.0.1:${port}${path}"`).join('\n');
  const file = join(out, `curl-${name}.txt`);
  writeFileSync(file, body + '\n');
  console.log(`${file}  ${count} x ${Buffer.byteLength(path)} B target, ${refs} references`);
}
