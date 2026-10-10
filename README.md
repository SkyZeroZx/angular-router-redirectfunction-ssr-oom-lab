# Angular Router RedirectFunction SSR OOM lab

Minimal reproduction on Angular Router and `@angular/ssr` **22.2.2** with Node **24.16.0**: a production AOT build served by `AngularNodeAppEngine`.

## Cause

When `redirectTo` is a function and returns a **string**, the Router reads that string with the template rules of a static `redirectTo` string. From [`apply_redirects.ts`](https://github.com/angular/angular/blob/v22.2.2/packages/router/src/apply_redirects.ts#L87-L168):

```ts
const redirect = await getRedirectResult(redirectTo, currentSnapshot, injector);
if (redirect instanceof UrlTree) {
  throw new AbsoluteRedirect(redirect);
}

const newTree = this.applyRedirectCreateUrlTree(
  redirect,
  this.urlSerializer.parse(redirect),
  segments,
  posParams,
);
```

`createQueryParams()` replaces every query value that starts with `:` with the request's value of that name. `createSegments()` replaces every `:name` segment with the matched `UrlSegment`, the same object each time. A function builds its string from request data, so request bytes that spell a placeholder become references, and the serialized output is

```text
output  =  references  x  serialized length of the referenced value
```

Both factors are paid for out of the same request. Spending half the request on references and half on the value they point at maximises the product, so the output grows with the **square** of the request: this lab measures a `Location` header of about **requestBytes² / 8**. It takes one redirect and no loop.

`UrlTree` results skip this step, and a static `redirectTo` string is written by the developer.

## Route

[`src/app/app.routes.ts`](src/app/app.routes.ts) is Angular's [conditional redirect example](https://angular.dev/guide/routing/redirecting-routes#conditional-redirects). It returns a string that contains the request's `meal` query value, and the `location` path parameter in every branch. The guide's route has no `pathMatch`, so its destinations match the redirect route again and form the redirect chain from #69722. This lab adds `pathMatch: 'full'` to rule that chain out: each request makes exactly one `redirectTo` call. It also adds a call counter, and the server routes use `RenderMode.Server`. It has no guard, resolver, matrix parameter, backend call, or artificial delay.

## Input

[`scripts/payload.mjs`](scripts/payload.mjs) builds the request. The references go in the `location` path segment and the value they point at goes in a one-character query parameter:

```text
/restaurant/x%3F0=:z&1=:z&2=:z& … &hs=:z&/menu?z==============…=====&meal=x
```

At a 16,000-byte target that is:

| Part                   | Bytes | Role                                                   |
| ---------------------- | ----: | ------------------------------------------------------ |
| `/restaurant/x`        |    13 | the segment the route matches as `:location`           |
| `%3F`                  |     3 | opens a query inside that segment                      |
| `0=:z&1=:z& … &hs=:z&` | 7,985 | 1,343 references, 5.95 bytes each                      |
| `/menu?z=`             |     8 | closes the route, names the referenced parameter       |
| `=` repeated           | 7,984 | the value every reference points at                    |
| `&meal=x`              |     7 | pins the branch so the destination is hour-independent |

The redirect function returns `` `/restaurant/${location}/menu/${meal}` ``, so the decoded `location` decides how that string parses. `%3F` opens a query, and every `<key>=:z` after it becomes one reference to the request's own `z` parameter. The equal-size control is the same request with `@z` in place of `:z`: `createQueryParams()` only substitutes a value whose first character is `:`, so nothing is copied and only that one character differs.

Three choices set the size of the output:

| Lever                                | Choice                      | Why                                                                                                                                                                                                                       |
| ------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the references live            | the `location` path segment | `SEGMENT_RE` is `/^[^\/()?;#]+/`, so a raw `&` is legal inside a path segment and `new URL()` leaves it there. One reference costs `&k=:z`, **5 bytes**. Inside a query value `&` has to be written `%26`, which costs 7. |
| What the references point at         | a one-character query name  | `createQueryParams()` looks the name up in the request's own query parameters, so `:z` is the shortest reference that resolves.                                                                                           |
| What the referenced value is made of | `=` repeated                | `=` is one byte in a query value (`QUERY_PARAM_VALUE_RE` is `/^[^&#]+/`) and `encodeUriQuery()` writes it back as `%3D`, so **one request byte is serialized as three**.                                                  |

Keys are distinct because `parseQueryParam()` collapses a repeated key into an array and `createQueryParams()` only substitutes string values. They are drawn shortest first from the 73 characters that are RFC 3986 `pchar`, legal in a query-parameter name, and legal unencoded in a path segment, which keeps the average reference at 5.95 bytes.

Every byte of the request is a character RFC 3986 allows in the position it occupies; the only percent-escape in the whole target is the single `%3F`. Four other options were measured and are **not** used, because each one produces less:

- **Non-ASCII fill.** A raw `0x80`–`0xFF` byte would serialize as six bytes rather than three, because Node reads the target as Latin-1 and `new URL()` re-encodes the character as UTF-8. llhttp answers `400` to every byte below `0x21` and above `0x7E`, so it never reaches Angular.
- **`@ : $ , ;` fill.** `encodeUriString()` un-escapes `%40`, `%3A`, `%24` and `%2C`, and `encodeUriQuery()` adds `%3B`, so these five characters stay one byte out. Three bytes per request byte is the ceiling.
- **Numeric reference keys.** `createQueryParams()` assigns with a plain `res[k] = …`, and so does `parseQueryParam()`; neither uses the `setUrlDerivedKey()` guard that the same file applies to matrix parameters and outlet names, so array-index keys do reach V8's elements backing store from here. They cost more bytes per reference than short alphanumeric keys, and the backing store they buy is a few hundred kilobytes, so they lower the total: dense keys gave 27.2 MB and keys spaced by V8's 1024-element gap gave 19.4 MB, against 32.2 MB for this generator at the same request size.
- **Path references with a matrix-parameter value.** `findPosParam()` returns the matched `UrlSegment` whole, parameters included, so `:location` segments in the redirect each re-serialize a `;m=<fill>` hanging off the request's own location segment. But `/` is not legal unencoded inside a segment, so a reference costs `%2F:location`, 12 bytes against 5. Measured at its own optimum (three quarters of the request spent on references, as the arithmetic predicts) it reaches 23,921,020 B, **74.4%** of the query route at the same request size.

[`scripts/byte-scan.mjs`](scripts/byte-scan.mjs) measures the first two bounds: it sends every byte value from `0x01` to `0xFF` except the four that have structural meaning in a request target (space, `#`, `%`, `&`) and divides the growth of the `Location` header by the number of bytes sent ([`evidence/byte-scan.json`](evidence/byte-scan.json)). Of the 251 byte values it tries, **160 answer `400`** — every one of them outside `0x21`–`0x7E` — **75 serialize as one byte** (`!$()*,-.:;@`, the alphanumerics, `_~`) and **16 reach the ceiling of three** (`"'+/<=>?[\]^`` ` ``{|}`).

Those two bounds pin the mechanism down. With `c` bytes per reference and `e` output bytes per fill byte, the best a request of `B` bytes can do is `e·B²/(4c)`, and at `c` = 5.95 and `e` = 3 that is `0.126·B²`. The measured output is **within 0.03% of it** at both sizes, so the payload itself has no headroom left; the remaining lever is the ingress size limit, and the output is quadratic in it.

## Results

### One request

Fresh worker per case, default heap, median of 3 runs ([`evidence/ablation-8000.json`](evidence/ablation-8000.json), [`evidence/ablation-16000.json`](evidence/ablation-16000.json)). "Fixed" is the same build with the two `:` branches skipped when `redirectTo` is a function ([`scripts/ablation.mjs`](scripts/ablation.mjs)).

| Request                | References | Stock `Location` |   Stock time | Fixed `Location` | Fixed time | Bytes out per byte in |
| ---------------------- | ---------: | ---------------: | -----------: | ---------------: | ---------: | --------------------: |
| **8,000 B** candidate  |        676 |  **8,086,283 B** |   **690 ms** |          4,027 B |      28 ms |            **1,011x** |
| 8,000 B control        |        676 |          4,027 B |        29 ms |          4,027 B |      28 ms |                    1x |
| **16,000 B** candidate |      1,343 | **32,172,897 B** | **4,317 ms** |          8,047 B |      47 ms |            **2,011x** |
| 16,000 B control       |      1,343 |          8,047 B |        46 ms |          8,047 B |      46 ms |                    1x |

Every case made exactly one `redirectTo` call. `?meal=lunch` returned `302` to `/restaurant/downtown/menu/lunch`, 31 bytes, identically on both builds. On the fixed build the candidate collapses to exactly the size of its own control at both request sizes, so skipping the two `:` branches for function results removes the amplification rather than reducing it, and the stronger payload does not route around the fix.

### Fewest requests that exhaust the heap

Three instruments, all with a fresh worker per case and an equal-size control replayed at the same concurrency:

- **Scan** — walks the concurrency up from 1 and stops at the first step with a V8 heap-limit signature in stderr ([`scripts/threshold.mjs`](scripts/threshold.mjs), `evidence/threshold-*.json`). Every figure below was reached twice, in two independent scans, with the same result.
- **Direct, 3/3** — the lowest concurrency that reached the OOM in three consecutive fresh runs, over Node's own HTTP client and with a `/health` probe alongside ([`scripts/validate.mjs`](scripts/validate.mjs), `evidence/direct-*.json`).
- **Behind Nginx** — HTTP/2 to Nginx 1.30.5, HTTP/1.1 to Angular in an Alpine container ([`scripts/validate-proxy.mjs`](scripts/validate-proxy.mjs), `evidence/proxy-*.json`).

| Heap        | Request      | Scan | Direct, 3/3 | Behind Nginx |
| ----------- | ------------ | ---: | ----------: | -----------: |
| **256 MiB** | **8,000 B**  |   12 |          12 |   12 (1 run) |
| **256 MiB** | **16,000 B** |    3 |           3 |   3 (3 runs) |
| **512 MiB** | **8,000 B**  |   22 |          22 |   22 (1 run) |
| **512 MiB** | **16,000 B** |    5 |           7 |   5 (3 runs) |

Direct workers exited with code 134 and `JavaScript heap out of memory`; the container exited with code 139 while Docker reported `OOMKilled=false`, so V8 reached its own limit and the container was not reaped. The control answered every request on a live worker in every case.

Three of the four profiles give the same figure on every instrument. 512 MiB with 16,000 B requests sits on a boundary instead: the scan reached an OOM at 5 twice and Nginx reproduced 5 in three runs, while three consecutive direct runs over Node's own client needed 7, with 5 and 6 each failing two of three. Treat 5 as the lowest demonstrated figure for that profile and 7 as the dependable one.

Every request below the threshold is answered, so the heap is not exhausted by a single response: at 256 MiB a lone 16,000 B request returns its 32,172,897-byte `Location` in 2.8 s and the worker survives. Behind the proxy that single request answered 502, because Nginx will not relay a 32 MB header, and `/stats` straight afterwards reported the worker's heap at **141,703,088 bytes** against a 32,172,897-byte `Location` — the shape `serializeQueryParams()` implies, with the per-reference strings and the string they are joined into both live at the peak.

What exhausts the heap is therefore concurrent _serialization_, not held connections. Opening connections that send the payload and never read the reply, one at a time and leaving every one open, did not reach the limit: 14 of them at 512 MiB and 12 at 256 MiB, with `redirectCalls` confirming each one was served and no OOM either time. `heapUsed` sawtooths — 111 MB, 143 MB, 176 MB, back to 111 MB at 256 MiB — so the finished header is garbage the collector reclaims while the connection stays open, not a retained cost per connection. The request counts above cannot be traded for patience.

## Reproduce on Windows

```powershell
npm.cmd ci
npm.cmd run build
node scripts/byte-scan.mjs           # output bytes per request byte, for every byte value
node scripts/ablation.mjs 16000      # one request each: stock vs fixed, candidate vs control
node scripts/ablation.mjs 8000
node scripts/threshold.mjs 256 16000 # fewest concurrent requests that reach a V8 OOM
node scripts/threshold.mjs 512 16000
node scripts/threshold.mjs 256 8000
node scripts/threshold.mjs 512 8000
node scripts/validate.mjs 256 16000 3        # fixed concurrency, with the /health probe
node scripts/validate.mjs 512 16000 7        # 7, not 5: 5 only OOMs in 1 of 3 runs here
node scripts/validate.mjs 256 8000 12
node scripts/validate.mjs 512 8000 22
docker compose build app
node scripts/validate-proxy.mjs 256 16000 3   # HTTP/2 to Nginx 1.30.5, HTTP/1.1 to Angular
node scripts/validate-proxy.mjs 512 16000 5
node scripts/validate-proxy.mjs 256 8000 12
node scripts/validate-proxy.mjs 512 8000 22
```

Every script starts a fresh worker per case and asserts equal request sizes, a harmless control and one redirect call per request; the OOM scripts also require a V8 heap-limit signature. Proxy runs additionally require Docker `OOMKilled=false` and stop their containers afterwards. All traffic stays on `127.0.0.1`, and the proxy publishes only port 8080. Results and worker logs are saved in [`evidence/`](evidence/).
