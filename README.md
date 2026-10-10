# Angular Router RedirectFunction SSR OOM lab

Minimal reproduction on Angular Router and `@angular/ssr` **22.2.2** with Node **24.16.0**, using a production build served by `AngularNodeAppEngine`.

## Cause

When `redirectTo` is a function and returns a string, the Router parses that string and applies the same `:name` substitution it uses for a static `redirectTo` ([`apply_redirects.ts`](https://github.com/angular/angular/blob/v22.2.2/packages/router/src/apply_redirects.ts#L87-L168)). `createQueryParams()` replaces every query value that starts with `:` with the request's value of that name:

```ts
const copySourceValue = typeof v === "string" && v[0] === ":";
if (copySourceValue) {
  const sourceName = v.substring(1);
  res[k] = actualParams[sourceName];
}
```

`createSegments()` does the same for `:name` segments. A static string is written by the developer, but a function builds its string from request data, so request bytes that spell `:name` become references.

The output is references × length of the referenced value, and both are paid from the same request. The `Location` header grows with the square of the request, about **requestBytes² / 8**, in a single redirect. A returned `UrlTree` skips this step.

[`scripts/router-only.mjs`](scripts/router-only.mjs) runs the same steps in plain Node, with no server and no `@angular/ssr`:

| Step                     |  16,000 B request |
| ------------------------ | ----------------: |
| `parse(request)`         |        1 ms, 0 MB |
| `parse(redirect string)` |      2 ms, 0.9 MB |
| `createQueryParams()`    |      1 ms, 0.5 MB |
| `serialize()`            | **170 ms, 69 MB** |

The substitution is cheap because its 1,342 query parameters point at the same string. The memory goes to `serializeQueryParams()` in [`url_tree.ts`](https://github.com/angular/angular/blob/v22.2.2/packages/router/src/url_tree.ts), which holds every serialized value and the joined 32 MB string at the same time. All of this is `@angular/router`. `@angular/ssr` runs it once per request in a worker with a fixed heap and writes the result as a `Location` header.

## Route

[`src/app/app.routes.ts`](src/app/app.routes.ts) is Angular's [conditional redirect example](https://angular.dev/guide/routing/redirecting-routes#conditional-redirects), which interpolates `params['location']` in every branch. The only change is `pathMatch: 'full'` on the redirect route, which the guide already uses on the `''` route of the same snippet. The lab also counts redirect calls and uses `RenderMode.Server`. It has no guard, resolver, catch-all, matrix parameter, backend call, or artificial delay.

The redirect only amplifies when the Router can recognize its destination. At 16,000 B with a 256 MiB heap:

| Config                                        | `Location`            | V8 OOM                    |
| --------------------------------------------- | --------------------- | ------------------------- |
| Guide, unchanged                              | 302 with 25 B, or 404 | no, 16 concurrent survive |
| Guide + `pathMatch: 'full'` (this lab)        | **32,112,927 B**      | **3 concurrent**          |
| Guide + `{ path: '**', component: NotFound }` | 32,172,897 B          | 3 concurrent              |

Without `pathMatch: 'full'` the redirect route prefix-matches its own destinations. The second hop rebuilds the string from a snapshot whose query keys are `0`, `1`, … instead of `meal`, takes an hour branch with no query, and the large query is dropped. The chain stops at the 32-hop limit from #69722 with a 25-byte `Location`. A path that matches nothing answers 404 in about 130 ms.

The `**` route is left commented in `app.routes.ts`. Uncomment it to use the `catchAll` head in [`scripts/payload.mjs`](scripts/payload.mjs). A `**` with a `redirectTo`, or with another component, amplifies the same.

## Input

[`scripts/payload.mjs`](scripts/payload.mjs) builds the request:

```text
/restaurant/a%2Fmenu%2Flunch%3F0=:z&1=:z& … &hq=:z&/menu?z===========…====&meal=x
```

The function returns `` `/restaurant/${location}/menu/${meal}` ``, and the decoded `location` is `a/menu/lunch?0=:z&1=:z&…`:

- `%2Fmenu%2Flunch` lands the redirect's path on `menu/lunch`, a destination route.
- `%3F` opens a query, and each `<key>=:z` after it is a reference to the request's own `z` parameter. `SEGMENT_RE` allows a raw `&` inside a path segment, so a reference costs about 6 bytes. Keys are distinct because a repeated key becomes an array, and only strings are substituted.
- `z` is `=` repeated. `encodeUriQuery()` writes `=` back as `%3D`, so one request byte becomes three.
- `&meal=x` only pins the branch, so the result does not depend on the hour.

At 16,000 B that is 1,341 references (7,973 B) pointing at 7,981 B of `=`. The control is the same request with `@z` instead of `:z`, which is not substituted.

Three bytes out per byte in is the ceiling. [`scripts/byte-scan.mjs`](scripts/byte-scan.mjs) sent every byte from `0x01` to `0xFF` except space, `#`, `%` and `&` ([`evidence/byte-scan.json`](evidence/byte-scan.json)): 160 got `400` from Node's HTTP parser (all outside `0x21`–`0x7E`), 75 serialize as one byte and 16 as three (`"'+/<=>?[\]^`` ` ``{|}`). Numeric reference keys reached 27.2 MB and `:location` path references with a matrix-parameter value 23.9 MB, both less than this generator at the same size.

With `c` bytes per reference and `e` bytes out per fill byte, a request of `B` bytes produces at most `e·B²/(4c)`. At `e` = 3 and `c` = 5.95 the 16,000 B result is within 0.5% of that, so the only lever left is the ingress size limit.

## Results

### One request

Fresh worker per case, default heap, median of 3 runs ([`evidence/ablation-8000.json`](evidence/ablation-8000.json), [`evidence/ablation-16000.json`](evidence/ablation-16000.json)). "Fixed" is the same build with the proposed fix: when `redirectTo` is a function, `posParams` is passed as `null`, so its string keeps `:name` segments and query values as written ([`scripts/ablation.mjs`](scripts/ablation.mjs)).

| Request            | References | Stock `Location` |   Stock time | Fixed `Location` | Fixed time |
| ------------------ | ---------: | ---------------: | -----------: | ---------------: | ---------: |
| 8,000 B candidate  |        675 |  **8,056,107 B** |   **742 ms** |          4,032 B |      41 ms |
| 8,000 B control    |        675 |          4,032 B |        30 ms |          4,032 B |      38 ms |
| 16,000 B candidate |      1,341 | **32,112,927 B** | **3,899 ms** |          8,046 B |      44 ms |
| 16,000 B control   |      1,341 |          8,046 B |        44 ms |          8,046 B |      44 ms |

That is 1,007x and 2,007x the request. Every case made one `redirectTo` call, and `?meal=lunch` returned the same 31-byte `Location` on both builds. With the fix the candidate is exactly the size of its control.

### Concurrent requests

Fewest concurrent candidate requests that exhaust the heap. Every case starts a fresh worker and replays the equal-size control at the same concurrency. The control always returned 302 on a live worker.

| Heap    | Request  | Scan | Direct | Nginx |
| ------- | -------- | ---: | -----: | ----: |
| 256 MiB | 8,000 B  |   12 |     12 |    12 |
| 256 MiB | 16,000 B |    3 |      3 |     3 |
| 512 MiB | 8,000 B  |   22 |     22 |    22 |
| 512 MiB | 16,000 B |    5 |      7 |     5 |

- **Scan** raises the concurrency from 1 until a V8 heap-limit error ([`scripts/threshold.mjs`](scripts/threshold.mjs)).
- **Direct** reached the OOM in 3 of 3 fresh runs over Node's HTTP client, with a `/health` probe ([`scripts/validate.mjs`](scripts/validate.mjs)).
- **Nginx** is HTTP/2 to Nginx 1.30.5 and HTTP/1.1 to Angular in an Alpine container ([`scripts/validate-proxy.mjs`](scripts/validate-proxy.mjs)).

512 MiB with 16,000 B is on the boundary: the scan and Nginx reached the OOM at 5, but direct runs needed 7 to reach it 3 of 3.

Direct workers exited with code 134 and `JavaScript heap out of memory`. The container exited with code 139 and `OOMKilled=false`, so V8 hit its own limit.

One request is not enough. At 256 MiB a single 16,000 B request returns its 32 MB `Location` in about 3.7 s and the worker survives. Behind Nginx the same request gets a 502, because Nginx will not relay a 32 MB header through its 32 KiB upstream buffer, but Angular has already built it and the worker reports about 141 MB of heap in use right after.

Holding connections open without reading the reply does not reach the limit either: 12 at 256 MiB and 14 at 512 MiB, all served, with no OOM. The finished header is collected while the connection stays open, so what exhausts the heap is concurrent serialization.

## See it by hand

[`scripts/curl-urls.mjs`](scripts/curl-urls.mjs) writes the request targets into curl config files, because they contain `&`, `?`, `$`, `'` and `*`.

```powershell
npm.cmd ci
npm.cmd run build
```

Terminal A, the worker:

```powershell
node --max-old-space-size=256 dist/angular-router-redirectfunction-ssr-oom-lab/server/server.mjs
# Angular SSR listening on http://127.0.0.1:4000
```

Terminal B. Use `curl.exe`, because Windows PowerShell aliases `curl` to `Invoke-WebRequest`. curl refuses headers over about 100 KB, so use an 800-byte request to see the `Location`:

```powershell
node scripts/curl-urls.mjs 800 1 4000
curl.exe -Z -s -K dist/curl-candidate.txt -o NUL -w "candidate: HTTP %{http_code}  header=%{size_header} B  %{time_total}s`n"
curl.exe -Z -s -K dist/curl-control.txt   -o NUL -w "control:   HTTP %{http_code}  header=%{size_header} B  %{time_total}s`n"
```

```text
candidate: HTTP 302  header=85325 B  0.106900s
control:   HTTP 302  header=650 B  0.017084s
```

Then twelve concurrent 8,000-byte requests, control first:

```powershell
node scripts/curl-urls.mjs 8000 12 4000
curl.exe -Z -s -K dist/curl-control.txt   -o NUL -w "%{http_code} header=%{size_header}B %{time_total}s`n"
curl.exe -Z -s -K dist/curl-candidate.txt -o NUL -w "%{http_code} header=%{size_header}B %{time_total}s`n"
```

The control answers `302 header=4266B` twelve times and the worker stays up. For the candidate curl exits with `100` (`CURLE_TOO_LARGE`) because it will not read an 8 MB header, but Angular has already built it, and Terminal A prints:

```text
FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
```

With 11 requests the worker survives. At 16,000 B three are enough.

## Reproduce the recorded evidence

```powershell
npm.cmd ci
npm.cmd run build
node --expose-gc scripts/router-only.mjs 16000  # no server, cost of each Router step
node scripts/byte-scan.mjs                      # bytes out per byte in, for every byte value
node scripts/ablation.mjs 8000                  # one request: stock vs fixed, candidate vs control
node scripts/ablation.mjs 16000
node scripts/threshold.mjs 256 8000             # fewest concurrent requests that reach a V8 OOM
node scripts/threshold.mjs 256 16000
node scripts/threshold.mjs 512 8000
node scripts/threshold.mjs 512 16000
node scripts/validate.mjs 256 8000 12           # fixed concurrency, with a /health probe
node scripts/validate.mjs 256 16000 3
node scripts/validate.mjs 512 8000 22
node scripts/validate.mjs 512 16000 7
docker compose build app
node scripts/validate-proxy.mjs 256 8000 12     # through Nginx
node scripts/validate-proxy.mjs 256 16000 3
node scripts/validate-proxy.mjs 512 8000 22
node scripts/validate-proxy.mjs 512 16000 5
```

Each script starts a fresh worker per case and checks equal request sizes, a harmless control and one redirect call per request. The OOM scripts also require a V8 heap-limit error, and the proxy runs require `OOMKilled=false` and stop their containers afterwards. All traffic stays on `127.0.0.1`, and the proxy publishes only port 8080. Results and worker logs are saved in [`evidence/`](evidence/).
