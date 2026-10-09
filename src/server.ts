import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from "@angular/ssr/node";
import express from "express";

const app = express();

const angularApp = new AngularNodeAppEngine();

let ssrRequests = 0;

app.get("/health", (_req, res) => res.sendStatus(200));

app.get("/stats", (_req, res) => {
  const lab = globalThis as typeof globalThis & { redirectCalls?: number };
  res.json({
    ssrRequests,
    redirectCalls: lab.redirectCalls ?? 0,
    heapUsedBytes: process.memoryUsage().heapUsed,
  });
});

app.use((req, res, next) => {
  ssrRequests++;
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

if (isMainModule(import.meta.url)) {
  app.listen(
    Number(process.env["PORT"] ?? 4000),
    process.env["HOST"] ?? "127.0.0.1",
  );
}

export const reqHandler = createNodeRequestHandler(app);
