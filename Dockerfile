FROM node:24.16.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY angular.json tsconfig.json tsconfig.app.json ./
COPY src ./src
RUN npm run build
# The same app again, with the proposed router fix applied to @angular/router.
COPY scripts/router-fix.mjs ./scripts/
RUN node scripts/router-fix.mjs \
 && rm -rf .angular/cache \
 && npm run build -- --output-path dist/angular-router-redirectfunction-ssr-oom-lab-fixed \
 && ! cmp -s dist/angular-router-redirectfunction-ssr-oom-lab/server/main.server.mjs \
             dist/angular-router-redirectfunction-ssr-oom-lab-fixed/server/main.server.mjs

FROM node:24.16.0-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh ./
# off serves the stock build, on the build with the router fix.
ENV ROUTER_FIX=off
ENTRYPOINT ["sh", "docker-entrypoint.sh"]
