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

### Which code owns it

All of it is `@angular/router`. [`scripts/router-only.mjs`](scripts/router-only.mjs) walks the same three steps by hand in plain Node, with no server, no HTTP and no `@angular/ssr`, and splits the cost:

| Step                                     |    16,000 B request |
| ---------------------------------------- | ------------------: |
| `parse(request)`                         |         1 ms, 0 MB  |
| `parse(redirect string)`                 |       2 ms, 0.9 MB  |
| `createQueryParams()` — the substitution |    **1 ms, 0.5 MB** |
| `DefaultUrlSerializer.serialize()`       | **183 ms, 69.2 MB** |

The substitution is free: the 1,342 query parameters it writes all point at the **same** string, so nothing is copied. The bytes are born in `serializeQueryParams()` in [`url_tree.ts`](https://github.com/angular/angular/blob/v22.2.2/packages/router/src/url_tree.ts), which holds the per-reference strings and the string they are joined into at the same time — 69.2 MB for a 32,112,891-byte result, a ratio of 2.2.

So the defect is the decision in `apply_redirects.ts` to treat a function's return value as a `:name` template, and the memory is spent in the serializer that later turns that tree into bytes. `@angular/ssr` contributes nothing to the amplification; it only runs the Router once per request inside a worker with a fixed heap, and turns the tree into a `Location` header, which is what makes it an availability problem rather than one slow navigation. It does add wall-clock: 183 ms in the Router against about 3.7 s end to end, the difference being `Headers` validation and Node's own header buffer copying 32 MB.

## Route

[`src/app/app.routes.ts`](src/app/app.routes.ts) is Angular's [conditional redirect example](https://angular.dev/guide/routing/redirecting-routes#conditional-redirects), which interpolates `params['location']` into the string it returns in every branch. The lab changes **one** thing: `pathMatch: 'full'` on the redirect route. It also adds a call counter, and the server routes use `RenderMode.Server`. It has no guard, resolver, catch-all route, matrix parameter, backend call, or artificial delay.

That one property is the guide's own advice for redirect routes, and the guide already uses it on the `''` route in the same snippet. Without it the redirect route prefix-matches its own destinations, which is a latent 32-hop chain — so adding it is the correction, and the correction is what makes this reachable.

It is not the only way in. Measured at 16,000 B on a 256 MiB heap, with the payload head that each config requires:

| Changed in the guide's config        | Payload head  |       `Location` | `redirectTo` calls |                    V8 OOM |
| ------------------------------------ | ------------- | ---------------: | -----------------: | ------------------------: |
| nothing                              | `destination` |        302, 25 B |                 32 | no, 16 concurrent survive |
| nothing                              | `catchAll`    |   404, no header |                  1 | no, 16 concurrent survive |
| **`pathMatch: 'full'`** (this lab)   | `destination` | **32,112,927 B** |                  1 |          **3 concurrent** |
| `pathMatch: 'full'`                  | `meal`        |   24,096,702 B   |                  1 |                   not run |
| `pathMatch: 'full'` + `:meal` dest.  | `destination` |   32,112,927 B   |                  1 |                   not run |
| added `**` with a `NotFound`         | `catchAll`    |   32,172,897 B   |                  1 |            3 concurrent   |
| added `**` with a `redirectTo`       | `catchAll`    |   32,172,885 B   |                  1 |                   not run |

The rule across the table is that the redirect's destination has to be recognizable at all. Either the redirect route is `pathMatch: 'full'` so the attacker can land the path on a real destination, or some catch-all matches it — and the catch-all does not have to be terminal, since a `**` carrying a `redirectTo` amplifies the same as one carrying a component. The guide's config has neither, so on it no head produces an amplified header: the two heads differ only in where the redirect's path lands ([`scripts/payload.mjs`](scripts/payload.mjs)), and `catchAll` leaves it at `/restaurant/x?…`, two segments nothing matches, while `destination` carries `%2Fmenu%2Flunch` so it becomes `/restaurant/a/menu/lunch?…`, which only wins once the redirect route stops prefix-matching it.

Without `pathMatch: 'full'` the chain is what kills the amplification, not a size limit: hop 2 rebuilds the string from a snapshot whose query keys are `0`, `1`, … rather than `meal`, so it takes the hour branch and returns a string with no query at all, `createQueryParams()` sees an empty query, and the giant one is dropped. The chain then prefix-matches its own output to the 32-hop cap from #69722 and answers with a 25-byte `Location`.

The catch-all row is left in [`src/app/app.routes.ts`](src/app/app.routes.ts) as a commented `{ path: "**", component: NotFound }`. Uncommenting it makes the `catchAll` head work as well, and which component it carries makes no difference: `NotFound` and `Menu` both produce 32,172,897 B, because recognition only cares that something matches.

This also bounds the mechanism: the cost is the serialization, not the substitution. A destination that is not routable is answered 404 in about 130 ms with no amplification at all, and 16 concurrent such requests leave the worker alive.

## Input

[`scripts/payload.mjs`](scripts/payload.mjs) builds the request. The references go in the `location` path segment and the value they point at goes in a one-character query parameter. The segment also carries an encoded `/menu/lunch`, so the redirect's path stays on a destination route:

```text
/restaurant/a%2Fmenu%2Flunch%3F0=:z&1=:z& … &hq=:z&/menu?z===========…====&meal=x
```

At a 16,000-byte target that is:

| Part                           | Bytes | Role                                                   |
| ------------------------------ | ----: | ------------------------------------------------------ |
| `/restaurant/`                 |    12 | fixed by the route                                     |
| `a%2Fmenu%2Flunch`             |    16 | the `:location` segment, carrying `/` so the redirect path lands on `menu/lunch` |
| `%3F`                          |     3 | opens a query inside that segment                      |
| `0=:z&1=:z& … &hq=:z&`        | 7,973 | 1,341 references, 5.95 bytes each                      |
| `/menu?z=`                     |     8 | closes the route, names the referenced parameter       |
| `=` repeated                   | 7,981 | the value every reference points at                    |
| `&meal=x`                      |     7 | pins the branch so the destination is hour-independent |

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
| **8,000 B** candidate  |        675 |  **8,056,107 B** |   **662 ms** |          4,032 B |      27 ms |            **1,007x** |
| 8,000 B control        |        675 |          4,032 B |        28 ms |          4,032 B |      27 ms |                    1x |
| **16,000 B** candidate |      1,341 | **32,112,927 B** | **3,660 ms** |          8,046 B |      46 ms |            **2,007x** |
| 16,000 B control       |      1,341 |          8,046 B |        44 ms |          8,046 B |      44 ms |                    1x |

Every case made exactly one `redirectTo` call. `?meal=lunch` returned `302` to `/restaurant/downtown/menu/lunch`, 31 bytes, identically on both builds. On the fixed build the candidate collapses to exactly the size of its own control at both request sizes, so skipping the two `:` branches for function results removes the amplification rather than reducing it, and the stronger payload does not route around the fix.

### Fewest requests that exhaust the heap

Three instruments, all with a fresh worker per case and an equal-size control replayed at the same concurrency:

- **Scan** — walks the concurrency up from 1 and stops at the first step with a V8 heap-limit signature in stderr ([`scripts/threshold.mjs`](scripts/threshold.mjs), `evidence/threshold-*.json`). Every figure below was reached twice, in two independent scans, with the same result.
- **Direct, 3/3** — the lowest concurrency that reached the OOM in three consecutive fresh runs, over Node's own HTTP client and with a `/health` probe alongside ([`scripts/validate.mjs`](scripts/validate.mjs), `evidence/direct-*.json`).
- **Behind Nginx** — HTTP/2 to Nginx 1.30.5, HTTP/1.1 to Angular in an Alpine container ([`scripts/validate-proxy.mjs`](scripts/validate-proxy.mjs), `evidence/proxy-*.json`).

| Heap        | Request      | Scan | Direct, 3/3 | Behind Nginx |
| ----------- | ------------ | ---: | ----------: | -----------: |
| **256 MiB** | **8,000 B**  |   12 |          12 |           12 |
| **256 MiB** | **16,000 B** |    3 |           3 |            3 |
| **512 MiB** | **8,000 B**  |   22 |          22 |           22 |
| **512 MiB** | **16,000 B** |    5 |           7 |            5 |

Direct workers exited with code 134 and `JavaScript heap out of memory`; the container exited with code 139 while Docker reported `OOMKilled=false`, so V8 reached its own limit and the container was not reaped. The control answered every request on a live worker in every case.

Three of the four profiles give the same figure on every instrument. 512 MiB with 16,000 B requests sits on a boundary instead: the scan reached an OOM at 5 twice and Nginx reproduced 5 in three runs, while three consecutive direct runs over Node's own client needed 7, with 5 and 6 each failing two of three. Treat 5 as the lowest demonstrated figure for that profile and 7 as the dependable one.

Every request below the threshold is answered, so the heap is not exhausted by a single response: at 256 MiB a lone 16,000 B request returns its 32,112,927-byte `Location` in 2.3 s and the worker survives. Behind the proxy that single request answered 502, because Nginx will not relay a 32 MB header, and `/stats` straight afterwards reported the worker's heap at **141,703,088 bytes** against a 32,112,927-byte `Location` — the shape `serializeQueryParams()` implies, with the per-reference strings and the string they are joined into both live at the peak.

What exhausts the heap is therefore concurrent _serialization_, not held connections. Opening connections that send the payload and never read the reply, one at a time and leaving every one open, did not reach the limit: 14 of them at 512 MiB and 12 at 256 MiB, with `redirectCalls` confirming each one was served and no OOM either time. `heapUsed` sawtooths — 111 MB, 143 MB, 176 MB, back to 111 MB at 256 MiB — so the finished header is garbage the collector reclaims while the connection stays open, not a retained cost per connection. The request counts above cannot be traded for patience.

## See it by hand

Two terminals, no harness. `scripts/curl-urls.mjs` writes the request target into a curl config file because the target contains `&`, `?`, `$`, `'` and `*`, which a shell would either split or expand.

```powershell
npm.cmd ci
npm.cmd run build
```

Terminal A, the worker, which prints the port it is on and is where the OOM shows up:

```powershell
node --max-old-space-size=256 dist/angular-router-redirectfunction-ssr-oom-lab/server/server.mjs
# Angular SSR listening on http://127.0.0.1:4000
```

Terminal B. It has to be `curl.exe`: Windows PowerShell aliases `curl` to `Invoke-WebRequest`. curl refuses a header over about 100 KB, so to *see* a `Location` use 800 bytes, which amplifies to 85 KB:

```powershell
node scripts/curl-urls.mjs 800 1 4000
curl.exe -Z -s -K dist/curl-candidate.txt -o NUL -w "candidate: HTTP %{http_code}  header=%{size_header} B  %{time_total}s`n"
curl.exe -Z -s -K dist/curl-control.txt   -o NUL -w "control:   HTTP %{http_code}  header=%{size_header} B  %{time_total}s`n"
```

```text
candidate: HTTP 302  header=85325 B  0.106900s
control:   HTTP 302  header=650 B  0.017084s
```

Now the OOM, 8 KB twelve times over. `-Z` runs them in parallel. The control first, which has to survive:

```powershell
node scripts/curl-urls.mjs 8000 12 4000
curl.exe -Z -s -K dist/curl-control.txt   -o NUL -w "%{http_code} header=%{size_header}B %{time_total}s`n"
curl.exe -Z -s -K dist/curl-candidate.txt -o NUL -w "%{http_code} header=%{size_header}B %{time_total}s`n"
```

The control answers twelve times with `302 header=4266B` and the worker stays up. The candidate makes curl exit **100** (`CURLE_TOO_LARGE`), because it will not read an 8 MB `Location`, and Terminal A prints:

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

Those curl errors are the expected outcome, not a failed attempt: Angular has already built the header, which is what exhausts the heap. The proof is Terminal A. Eleven concurrent requests survive and twelve do not, so `node scripts/curl-urls.mjs 8000 11 4000` shows the boundary. For 16 KB it takes three.

## Reproduce the recorded evidence

```powershell
npm.cmd ci
npm.cmd run build
node scripts/router-only.mjs 16000   # no server: which Router call spends the memory
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
