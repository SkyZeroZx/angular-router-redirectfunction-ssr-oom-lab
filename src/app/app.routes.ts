import { Component } from "@angular/core";
import { Routes } from "@angular/router";

@Component({ template: "<p>Menu</p>" })
class Menu {}

@Component({ template: "<p>Not found</p>" })
class NotFound {}

const lab = globalThis as typeof globalThis & { redirectCalls?: number };

export const routes: Routes = [
  {
    path: "restaurant/:location/menu",
    // The guide omits this. Without it the route prefix-matches its own destinations,
    // the redirect re-enters the function and the query is dropped.
    pathMatch: "full",
    redirectTo: (snapshot) => {
      lab.redirectCalls = (lab.redirectCalls ?? 0) + 1;
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
  { path: "restaurant/:location/menu/breakfast", component: Menu },
  { path: "restaurant/:location/menu/lunch", component: Menu },
  { path: "restaurant/:location/menu/dinner", component: Menu },
  { path: "", redirectTo: "/restaurant/downtown/menu", pathMatch: "full" },

  // The usual Angular 404 route, and the second way in. Uncomment it and the `catchAll`
  // head in scripts/payload.mjs amplifies too, because the redirect's two-segment
  // destination then has something to match. Commented out by default so the config
  // stays the guide's four routes plus pathMatch.
  // { path: "**", component: NotFound },
];
