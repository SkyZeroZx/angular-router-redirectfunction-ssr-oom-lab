// Differential fuzz of the proposed router fix, with no server and no @angular/ssr.
//
//   node scripts/fuzz-fix.mjs 20000 1
//
// Loads @angular/router twice, stock and with the fix applied to a copy of its fesm bundle,
// and navigates both through random route configs and URLs (count and seed are the two
// arguments). Three properties:
//
//   static   a static `redirectTo` string ends on the same URL, or the same error, on both;
//   literal  a function's string with no `:name` parts ends the same on both, and with the
//            fix an absolute string ends where stock ends for the same string as a UrlTree;
//   bounded  with the fix, a function's result is never more than 3x its own length plus
//            the request's. Stock has to break this at least once, or the fuzzer is too weak.
import '@angular/compiler';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { provideLocationMocks } from '@angular/common/testing';
import {
  createEnvironmentInjector, ErrorHandler, Injector, provideZonelessChangeDetection,
  ɵConsole as Console, ɵINJECTOR_SCOPE as INJECTOR_SCOPE,
} from '@angular/core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const iterations = Number(process.argv[2] ?? 20000);
const seed = Number(process.argv[3] ?? 1);
assert(iterations >= 1 && Number.isInteger(seed), 'usage: node scripts/fuzz-fix.mjs <count> <seed>');

function patchOnce(source, from, to, label) {
  assert.equal(source.split(from).length, 2, `expected one ${label} site`);
  return source.replace(from, to);
}

const stockFesm = join(root, 'node_modules', '@angular', 'router', 'fesm2022');
const fixedFesm = join(root, 'dist', 'router-fixed', 'fesm2022');
rmSync(dirname(fixedFesm), { recursive: true, force: true });
cpSync(stockFesm, fixedFesm, { recursive: true });
const chunk = join(fixedFesm, '_router-chunk.mjs');
let src = readFileSync(chunk, 'utf8');
src = patchOnce(src,
  'this.urlSerializer.parse(redirect), segments, posParams);',
  "this.urlSerializer.parse(redirect), segments, typeof redirectTo === 'string' ? posParams : null);",
  'applyRedirectCommands');
src = patchOnce(src,
  'return new UrlTree(newRoot, this.createQueryParams(urlTree.queryParams, this.urlTree.queryParams), urlTree.fragment);',
  'return new UrlTree(newRoot, posParams === null ? urlTree.queryParams : this.createQueryParams(urlTree.queryParams, this.urlTree.queryParams), urlTree.fragment);',
  'applyRedirectCreateUrlTree');
src = patchOnce(src,
  "return redirectToSegments.map(s => s.path[0] === ':' ?",
  "return redirectToSegments.map(s => posParams !== null && s.path[0] === ':' ?",
  'createSegments');
writeFileSync(chunk, src);

const stock = await import('@angular/router');
const fixed = await import(pathToFileURL(join(fixedFesm, 'router.mjs')).href);
assert.notEqual(stock.Router, fixed.Router, 'both imports resolved to the same module');
const serializer = new stock.DefaultUrlSerializer();

async function navigate(lib, routes, url) {
  const injector = createEnvironmentInjector([
    { provide: INJECTOR_SCOPE, useValue: 'root' },
    { provide: Console, useValue: { log() {}, warn() {} } },
    provideZonelessChangeDetection(),
    provideLocationMocks(),
    { provide: ErrorHandler, useValue: { handleError() {} } },
    { provide: lib.TitleStrategy, useValue: { updateTitle() {} } },
    lib.provideRouter(routes),
  ], Injector.NULL);
  try {
    const router = injector.get(lib.Router);
    return (await router.navigateByUrl(url)) ? { url: router.url } : { cancelled: true };
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  } finally {
    injector.destroy();
  }
}

// mulberry32
let state = seed >>> 0;
function rand() {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (n) => Math.floor(rand() * n);
const pick = (a) => a[int(a.length)];
const times = (n, f) => Array.from({ length: n }, f);

const SEGMENTS = ['a', 'b', 'c', 'x', 'menu', 'lunch', '%3Aa', ':a', 'a%2Fb', 'a%3Fq=:z', 'a%3F0=:z%261=:z', '__proto__', '0'];
const KEYS = ['q', 'z', 'meal', 'k', '0', '__proto__', 'constructor'];
const CHARS = ['=', ':', 'a', 'z', '%26', '%3D', '/', '?', '%2F', ':z', ':q', '@', '%28', '%29', '-', '%3A'];
const TEMPLATE_SEGMENTS = ['a', 'b', 'x', 'menu', ':id', ':p', ':missing', '{id}', '{p}', '{q}', 'lit{id}'];
const TEMPLATE_VALUES = ['1', ':q', ':z', ':meal', ':nope', ':0', ':__proto__', 'lit', '{q}', '{z}', '{id}'];
const REDIRECT_PATHS = ['p/:id', 'p/:id/:p', ':id', 'p', 'p/:id/menu'];

const value = () => times(int(6), () => pick(CHARS)).join('');
const matrix = () => (rand() < 0.3 ? `;${pick(KEYS)}=${value()}` : '');

// A request aimed at the redirect route, so most cases reach `applyRedirectCommands`.
function request(path, payload) {
  const segments = path.split('/').map((p) => (p[0] === ':' ? pick(SEGMENTS) : p) + matrix());
  if (payload) segments[segments.length > 1 ? 1 : 0] = `a%3F${times(payload.refs, (_, i) => `${i}=:z`).join('&')}&`;
  if (rand() < 0.3) segments.push(pick(SEGMENTS));
  const query = times(int(4), () => `${pick(KEYS)}=${value()}`);
  if (payload) query.push(`z=${'='.repeat(payload.fill)}`);
  return '/' + segments.join('/') + (query.length ? '?' + query.join('&') : '') + (rand() < 0.2 ? '#f' : '');
}

// A redirect string with `:name` parts and `{name}` holes that a function fills from the snapshot.
function template(fn) {
  const absolute = rand() < 0.8;
  let t = (absolute ? '/' : '') + times(1 + int(3), () => pick(TEMPLATE_SEGMENTS)).join('/');
  if (fn && rand() < 0.4) t = (absolute ? '/' : '') + 'p/{id}/menu';
  if (absolute && rand() < 0.15) t += '(aux:b)';
  const query = times(int(4), () => `${pick(KEYS)}=${pick(TEMPLATE_VALUES)}`);
  if (query.length) t += '?' + query.join('&');
  if (rand() < 0.1) t += '#g';
  return fn ? t : t.replace(/\{(\w+)\}/g, ':$1');
}

function routes(redirectPath, redirectTo) {
  const config = [
    { path: redirectPath, pathMatch: rand() < 0.7 ? 'full' : 'prefix', redirectTo },
    { path: 'a', children: [] },
    { path: 'a/b', children: [] },
    { path: 'x', children: [] },
    { path: 'p/:id/menu/:meal', children: [] },
    { path: 'b', outlet: 'aux', children: [] },
    ...(rand() < 0.8 ? [{ path: '**', children: [] }] : []),
  ];
  config.toString = () => `${redirectPath} ${config[0].pathMatch}${config.length > 6 ? ' with **' : ''}`;
  return config;
}

// True when the redirect string has a segment or query value the Router would treat as `:name`.
function hasPlaceholder(s) {
  let tree;
  try { tree = serializer.parse(s); } catch { return true; }
  const walk = (g) => g.segments.some((x) => x.path[0] === ':') || Object.values(g.children).some(walk);
  const values = Object.values(tree.queryParams).flat();
  return walk(tree.root) || values.some((v) => typeof v === 'string' && v[0] === ':');
}

const tally = {
  static: 0, staticErrors: 0, literalSame: 0, literalExact: 0, bounded: 0,
  stockOverBound: 0, stockMaxRatio: 0, fixedMaxRatio: 0,
};
const started = performance.now();
for (let i = 0; i < iterations; i++) {
  const redirectPath = pick(REDIRECT_PATHS);
  const payload = rand() < 0.2 ? { refs: 1 + int(100), fill: 1 + int(1000) } : null;
  const url = request(redirectPath, payload);
  const where = `case ${i}, seed ${seed}: ${url.slice(0, 160)}`;

  if (rand() < 0.4) {
    const redirectTo = template(false);
    const config = routes(redirectPath, redirectTo);
    const [a, b] = [await navigate(stock, config, url), await navigate(fixed, config, url)];
    assert.deepEqual(b, a, `static: ${where} [${config}] -> ${redirectTo}`);
    tally.static++;
    if (a.error) tally.staticErrors++;
    continue;
  }

  const tpl = template(true);
  const returned = [];
  const redirectTo = (snapshot) => {
    const s = tpl.replace(/\{(\w+)\}/g, (_, k) => String(
      Object.hasOwn(snapshot.params, k) ? snapshot.params[k] : snapshot.queryParams[k] ?? ''));
    returned.push(s);
    return s;
  };
  const config = routes(redirectPath, redirectTo);
  const a = await navigate(stock, config, url);
  const stockReturned = returned.splice(0);
  const b = await navigate(fixed, config, url);
  if (!returned.length) continue;
  const s = returned[0];

  if (stockReturned.length === 1 && returned.length === 1 && !hasPlaceholder(s)) {
    assert.deepEqual(b, a, `literal: ${where} [${config}] -> ${s}`);
    tally.literalSame++;
  }
  // Stock already skips the substitution for a UrlTree, so `parse(s)` is the literal reading of `s`.
  // Matrix parameters are left out because a string reuses matched segments and a UrlTree does not.
  if (returned.length === 1 && s[0] === '/' && !url.includes(';')) {
    let calls = 0;
    const asTree = config.map((r, j) => (j === 0 ? { ...r, redirectTo: () => (calls++, serializer.parse(s)) } : r));
    const c = await navigate(stock, asTree, url);
    if (calls === 1) {
      assert.deepEqual(b, c, `literal: ${where} [${config}] -> ${s}`);
      tally.literalExact++;
    }
  }
  // What the Router was given: every string the function returned, plus the request.
  const input = (calls) => calls.reduce((n, r) => n + r.length, 0) + url.length;
  if (b.url) {
    const budget = 3 * input(returned) + 64;
    assert(b.url.length <= budget, `bounded: ${where} [${config}] -> ${b.url.length} B for a ${budget} B budget`);
    tally.fixedMaxRatio = Math.max(tally.fixedMaxRatio, b.url.length / input(returned));
    tally.bounded++;
  }
  if (a.url && stockReturned.length) {
    tally.stockMaxRatio = Math.max(tally.stockMaxRatio, a.url.length / input(stockReturned));
    if (a.url.length > 3 * input(stockReturned) + 64) tally.stockOverBound++;
  }
}

assert(tally.stockOverBound > 0, 'stock never exceeded the bound: the generator is too weak to test the fix');
const result = {
  node: process.version, angular: '22.2.2', iterations, seed,
  seconds: Math.round((performance.now() - started) / 1000), ...tally,
  stockMaxRatio: Math.round(tally.stockMaxRatio), fixedMaxRatio: +tally.fixedMaxRatio.toFixed(2),
};
mkdirSync(join(root, 'evidence'), { recursive: true });
writeFileSync(join(root, 'evidence', `fuzz-fix-${seed}.json`), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
console.log(`PASS: ${iterations} cases, stock over the bound ${tally.stockOverBound} times (up to ${result.stockMaxRatio}x), fixed up to ${result.fixedMaxRatio}x`);
