# Angular Router RedirectFunction SSR OOM lab

Minimal reproduction on Angular Router **22.2.2** and Node **24.16.0**.

The route copies Angular's [conditional redirect example](https://angular.dev/guide/routing/redirecting-routes#conditional-redirects): it returns a string containing the request's `meal` query value. This lab adds `pathMatch: 'full'` to exclude a separate prefix-redirect loop. It has no guard, resolver, matrix parameter, backend call, or artificial delay.

## Input and cause

```text
Candidate meal: lunch?q0=:meal&q1=:meal&...
Control meal:   lunch?q0=@meal&q1=@meal&...
```

Both encoded request targets are **15,991 bytes**. The keys `q0`, `q1`, ... are distinct. Angular parses the function's returned string as a redirect template: every `:meal` query value becomes the complete original `meal` value. See [`apply_redirects.ts`](https://github.com/angular/angular/blob/v22.2.2/packages/router/src/apply_redirects.ts). One request produces a **13,301,741-byte `Location`** with exactly one redirect-function call. The control remains 10,316 bytes.

## Reproduce on Windows

Direct SSR worker, fresh process for control, single request, and concurrent attack:

```powershell
npm.cmd ci
npm.cmd run build
node scripts/validate.mjs 256
node scripts/validate.mjs 512
```

Proxy profile, with one HTTP/2 connection to Nginx 1.30.5 and HTTP/1.1 to Angular:

```powershell
docker compose build app
node scripts/validate-proxy.mjs 256
node scripts/validate-proxy.mjs 512
```

The validators use `--max-old-space-size=256` or `512`, start a fresh worker for each case, assert equal request sizes, verify the harmless control, and require a V8 OOM signature. Proxy runs also require Docker `OOMKilled=false`. All traffic stays on `127.0.0.1`; the proxy exposes only port 8080. The proxy validator stops its containers after each run. Results and worker logs are saved in [`evidence/`](evidence/).

## Recorded results

Windows Node direct and Docker/Linux proxy, **three fresh runs per profile**:

| Heap | Concurrent candidate requests | Direct V8 OOM | Proxy V8 OOM | Equal-size control |
| --- | ---: | ---: | ---: | ---: |
| 256 MiB | 10 | 3/3 | 3/3 | 10/10 responses in each run |
| 512 MiB | 20 | 3/3 | 3/3 | 20/20 responses in each run |

The direct worker exited with code 134; the Alpine container exited with code 139 and `OOMKilled=false`. Both emitted `JavaScript heap out of memory`. Nginx uses a 32 KiB upstream header buffer so the 10 KiB control `Location` passes. It returns 502 for the 13.3 MB candidate header, including the single candidate request. Angular still creates that header and the concurrent workload still exhausts V8. The control redirects return HTTP 302 through Nginx.
