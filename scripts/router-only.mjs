// Reproduction with no server, no HTTP and no @angular/ssr: the Router's own URL
// serializer, driven by hand through the three steps apply_redirects.ts takes.
//
//   node --expose-gc scripts/router-only.mjs 16000
//
// It shows that the substitution is free and the serializer is the cost, which is why
// the package that owns this is `router` and not `ssr`. --expose-gc only steadies the
// heap readings; the script runs without it.
import '../node_modules/@angular/compiler/fesm2022/compiler.mjs';
import { DefaultUrlSerializer, UrlTree } from '../node_modules/@angular/router/fesm2022/router.mjs';
import { payload } from './payload.mjs';

const size = Number(process.argv[2] ?? 16000);
const ser = new DefaultUrlSerializer();
const mb = (n) => (n / 1e6).toFixed(1) + ' MB';
const heap = () => process.memoryUsage().heapUsed;
const mark = (label, before, t0) =>
  console.log(
    '  ' + label.padEnd(44),
    'heapUsed ' + mb(heap()).padStart(9),
    '(delta ' + mb(heap() - before).padStart(9) + ')',
    Math.round(performance.now() - t0) + ' ms',
  );

// What @angular/ssr hands the Router: new URL() normalizes the raw target first.
const target = payload(size, false).path;
const u = new URL(target, 'http://127.0.0.1');
const requestUrl = u.pathname + u.search;
console.log(`request target ${Buffer.byteLength(target)} B -> after new URL() ${Buffer.byteLength(requestUrl)} B\n`);

if (global.gc) global.gc();
let h = heap();
let t = performance.now();

// step 1: parse the incoming URL
const actual = ser.parse(requestUrl);
mark('1. parse(request)', h, t);

// the application's redirect function, verbatim from the guide
const segments = actual.root.children['primary'].segments;
const location = segments[1].path;
const redirect = `/restaurant/${location}/menu/${actual.queryParams['meal']}`;
console.log('  redirect function returned ' + Buffer.byteLength(redirect) + ' B\n');

if (global.gc) global.gc();
h = heap();
t = performance.now();

// step 2: parse that returned string
const rt = ser.parse(redirect);
mark('2. parse(redirect string)', h, t);

if (global.gc) global.gc();
h = heap();
t = performance.now();

// step 3: createQueryParams, the substitution itself
const res = {};
for (const [k, v] of Object.entries(rt.queryParams)) {
  res[k] = typeof v === 'string' && v[0] === ':' ? actual.queryParams[v.substring(1)] : v;
}
const substituted = new UrlTree(rt.root, res, rt.fragment);
mark('3. createQueryParams (the substitution)', h, t);
console.log('     ' + Object.keys(res).length + ' query params, each pointing at the SAME string\n');

if (global.gc) global.gc();
h = heap();
t = performance.now();

// step 4: serialize the tree into the string that becomes the Location header
const out = ser.serialize(substituted);
mark('4. serialize(tree)  <-- the cost', h, t);
console.log('\nserialized Location: ' + Buffer.byteLength(out).toLocaleString() + ' B');
console.log('amplification: ' + Math.round(Buffer.byteLength(out) / Buffer.byteLength(target)) + 'x the request');
