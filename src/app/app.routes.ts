import { Component, inject } from "@angular/core";
import { Router, Routes } from "@angular/router";

@Component({ template: "<p>Menu</p>" })
class Menu {}

@Component({ template: "<p>Not found</p>" })
class NotFound {}

// Redirect calls, in total and per case, so the scripts can assert one call per request.
type Lab = typeof globalThis & {
  redirectCalls?: number;
  redirectCallsByCase?: Record<string, number>;
};
const lab = globalThis as Lab;

function count(name: string): void {
  lab.redirectCalls = (lab.redirectCalls ?? 0) + 1;
  lab.redirectCallsByCase ??= {};
  lab.redirectCallsByCase[name] = (lab.redirectCallsByCase[name] ?? 0) + 1;
}

// Fresh objects per case, since the Router stores state on Route objects.
const destinations = (): Routes => [
  { path: "restaurant/:location/menu/breakfast", component: Menu },
  { path: "restaurant/:location/menu/lunch", component: Menu },
  { path: "restaurant/:location/menu/dinner", component: Menu },
];

// Forwards the request's query string, every key and value through `encodeURIComponent`.
function forwardQuery(queryParams: Record<string, unknown>): string {
  return Object.entries(queryParams)
    .map(
      ([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`,
    )
    .join("&");
}

// The same with no encoder.
function forwardQueryRaw(queryParams: Record<string, unknown>): string {
  return Object.entries(queryParams)
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

export const routes: Routes = [
  // case-doc: the guide's conditional redirect example verbatim, plus `pathMatch: 'full'`
  // (https://angular.dev/guide/routing/redirecting-routes#conditional-redirects).
  // Without it the route prefix-matches its own destinations and the query is dropped.
  {
    path: "restaurant/:location/menu",
    pathMatch: "full",
    redirectTo: (snapshot) => {
      count("case-doc");
      const location = snapshot.params["location"];
      const currentHour = new Date().getHours();

      if (snapshot.queryParams["meal"]) {
        return `/restaurant/${location}/menu/${snapshot.queryParams["meal"]}`;
      }
      if (currentHour >= 5 && currentHour < 11) {
        return `/restaurant/${location}/menu/breakfast`;
      } else if (currentHour >= 11 && currentHour < 17) {
        return `/restaurant/${location}/menu/lunch`;
      } else {
        return `/restaurant/${location}/menu/dinner`;
      }
    },
  },
  ...destinations(),

  // The four cases below forward the request's query string and differ only in how the
  // redirect is built.

  // case-rawquery: no suggestion applied.
  {
    path: "case-rawquery",
    children: [
      {
        path: "restaurant/:location/menu",
        pathMatch: "full",
        redirectTo: (snapshot) => {
          count("case-rawquery");
          const location = snapshot.params["location"];
          const qs = forwardQueryRaw(snapshot.queryParams);
          return `/case-rawquery/restaurant/${location}/menu/breakfast?${qs}`;
        },
      },
      ...destinations(),
    ],
  },

  // case-keeplocation: `:location` kept as a placeholder.
  {
    path: "case-keeplocation",
    children: [
      {
        path: "restaurant/:location/menu",
        pathMatch: "full",
        redirectTo: (snapshot) => {
          count("case-keeplocation");
          const qs = forwardQuery(snapshot.queryParams);
          return `/case-keeplocation/restaurant/:location/menu/breakfast?${qs}`;
        },
      },
      ...destinations(),
    ],
  },

  // case-encode: `encodeURIComponent` on every interpolated value.
  {
    path: "case-encode",
    children: [
      {
        path: "restaurant/:location/menu",
        pathMatch: "full",
        redirectTo: (snapshot) => {
          count("case-encode");
          const location = encodeURIComponent(snapshot.params["location"]);
          const qs = forwardQuery(snapshot.queryParams);
          return `/case-encode/restaurant/${location}/menu/breakfast?${qs}`;
        },
      },
      ...destinations(),
    ],
  },

  // case-urltree: a `UrlTree` from `Router#createUrlTree`, so there is no string to
  // substitute in.
  {
    path: "case-urltree",
    children: [
      {
        path: "restaurant/:location/menu",
        pathMatch: "full",
        redirectTo: (snapshot) => {
          count("case-urltree");
          return inject(Router).createUrlTree(
            [
              "/case-urltree",
              "restaurant",
              snapshot.params["location"],
              "menu",
              "breakfast",
            ],
            { queryParams: snapshot.queryParams },
          );
        },
      },
      ...destinations(),
    ],
  },

  { path: "", redirectTo: "/restaurant/downtown/menu", pathMatch: "full" },

  // Uncomment to use the `catchAll` head in scripts/payload.mjs.
  // { path: "**", component: NotFound },
];
