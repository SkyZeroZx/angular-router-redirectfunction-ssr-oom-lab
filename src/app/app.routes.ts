import { Component } from '@angular/core';
import { Routes } from '@angular/router';

@Component({ template: '<p>Menu</p>' })
class Menu {}

const lab = globalThis as typeof globalThis & { redirectCalls?: number };

export const routes: Routes = [
  {
    path: 'restaurant/:location/menu',
    pathMatch: 'full',
    redirectTo: (snapshot) => {
      lab.redirectCalls = (lab.redirectCalls ?? 0) + 1;
      const location = snapshot.params['location'];
      const currentHour = new Date().getHours();

      if (snapshot.queryParams['meal']) {
        return `/restaurant/${location}/menu/${snapshot.queryParams['meal']}`;
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
  { path: 'restaurant/:location/menu/breakfast', component: Menu },
  { path: 'restaurant/:location/menu/lunch', component: Menu },
  { path: 'restaurant/:location/menu/dinner', component: Menu },
  { path: '**', component: Menu },
];
