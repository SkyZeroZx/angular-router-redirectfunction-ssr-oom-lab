// Applies the proposed router fix to @angular/router's fesm bundle, so the next `ng build`
// bundles it. The Docker image runs it between its stock and fixed builds.
//
//   node scripts/router-fix.mjs [fesm2022 dir]
//
// When `redirectTo` is a function, each `:name` in its string is substituted at most once, and
// only when the request has that parameter. Segments and query values keep separate sets. A
// static `redirectTo` string is substituted as before.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const STOCK = `    const newTree = this.applyRedirectCreateUrlTree(redirect, this.urlSerializer.parse(redirect), segments, posParams);
    if (redirect[0] === '/') {
      throw new AbsoluteRedirect(newTree);
    }
    return newTree;
  }
  applyRedirectCreateUrlTree(redirectTo, urlTree, segments, posParams) {
    const newRoot = this.createSegmentGroup(redirectTo, urlTree.root, segments, posParams);
    return new UrlTree(newRoot, this.createQueryParams(urlTree.queryParams, this.urlTree.queryParams), urlTree.fragment);
  }
  createQueryParams(redirectToParams, actualParams) {
    const res = {};
    Object.entries(redirectToParams).forEach(([k, v]) => {
      const copySourceValue = typeof v === 'string' && v[0] === ':';
      if (copySourceValue) {
        const sourceName = v.substring(1);
        res[k] = actualParams[sourceName];
      } else {
        res[k] = v;
      }
    });
    return res;
  }
  createSegmentGroup(redirectTo, group, segments, posParams) {
    const updatedSegments = this.createSegments(redirectTo, group.segments, segments, posParams);
    let children = Object.create(null);
    Object.entries(group.children).forEach(([name, child]) => {
      children[name] = this.createSegmentGroup(redirectTo, child, segments, posParams);
    });
    return new UrlSegmentGroup(updatedSegments, children);
  }
  createSegments(redirectTo, redirectToSegments, actualSegments, posParams) {
    return redirectToSegments.map(s => s.path[0] === ':' ? this.findPosParam(redirectTo, s, posParams) : this.findOrReturn(s, actualSegments));
  }
`;

const FIXED = `    const newTree = this.applyRedirectCreateUrlTree(redirect, this.urlSerializer.parse(redirect), segments, posParams,
    // A string returned by a function can contain request data, so each parameter is used once.
    typeof redirectTo === 'string' ? undefined : new Set());
    if (redirect[0] === '/') {
      throw new AbsoluteRedirect(newTree);
    }
    return newTree;
  }
  applyRedirectCreateUrlTree(redirectTo, urlTree, segments, posParams, used) {
    const newRoot = this.createSegmentGroup(redirectTo, urlTree.root, segments, posParams, used);
    return new UrlTree(newRoot, this.createQueryParams(urlTree.queryParams, this.urlTree.queryParams, used && new Set()), urlTree.fragment);
  }
  createQueryParams(redirectToParams, actualParams, used) {
    const res = {};
    Object.entries(redirectToParams).forEach(([k, v]) => {
      const sourceName = typeof v === 'string' && v[0] === ':' ? v.substring(1) : null;
      if (sourceName !== null && (!used || Object.hasOwn(actualParams, sourceName) && !used.has(sourceName))) {
        used?.add(sourceName);
        res[k] = actualParams[sourceName];
      } else {
        res[k] = v;
      }
    });
    return res;
  }
  createSegmentGroup(redirectTo, group, segments, posParams, used) {
    const updatedSegments = this.createSegments(redirectTo, group.segments, segments, posParams, used);
    let children = Object.create(null);
    Object.entries(group.children).forEach(([name, child]) => {
      children[name] = this.createSegmentGroup(redirectTo, child, segments, posParams, used);
    });
    return new UrlSegmentGroup(updatedSegments, children);
  }
  createSegments(redirectTo, redirectToSegments, actualSegments, posParams, used) {
    return redirectToSegments.map(s => {
      const name = s.path.substring(1);
      if (s.path[0] === ':' && (!used || Object.hasOwn(posParams, name) && !used.has(name))) {
        used?.add(name);
        return this.findPosParam(redirectTo, s, posParams);
      }
      return this.findOrReturn(s, actualSegments);
    });
  }
`;

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fesm = resolve(process.argv[2] ?? join(root, 'node_modules', '@angular', 'router', 'fesm2022'));
const chunk = join(fesm, '_router-chunk.mjs');
const src = readFileSync(chunk, 'utf8');
if (src.split(FIXED).length === 2) {
  console.log(`router fix already applied: ${chunk}`);
} else {
  assert.equal(src.split(STOCK).length, 2, `expected one stock ApplyRedirects block in ${chunk}`);
  writeFileSync(chunk, src.replace(STOCK, () => FIXED));
  console.log(`router fix applied: ${chunk}`);
}
