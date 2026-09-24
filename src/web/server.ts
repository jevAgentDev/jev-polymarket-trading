import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { loadDotEnv } from "../loadEnv.js";
import { loadConfig } from "../config.js";
import { WindowSession } from "../session.js";
import type { TickSnapshot } from "../domain.js";

loadDotEnv();

const port = Number(process.env.WEB_PORT ?? 80);
const host = process.env.WEB_HOST ?? "0.0.0.0";
const webRoot = resolve("web");
const clients = new Set<ServerResponse>();
let latest: TickSnapshot | null = null;

const cfg = loadConfig(
  {
    ...process.env,
    LIVE_TRADING: "0",
    POLYMARKET_SOURCE: process.env.WEB_MARKET_SOURCE ?? "live",
    TICK_MS: process.env.TICK_MS ?? "5000",
  },
  { stubJudge: true, fixedSpot: false, stubConfidence: 0.91, stubSide: "UP" },
);
const session = await WindowSession.open(cfg);

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

function broadcast(snapshot: TickSnapshot): void {
  latest = snapshot;
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of clients) client.write(payload);
}

const loop = session.run(broadcast);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, mode: "dry-run", connected: latest != null });
  }
  if (url.pathname === "/api/snapshot") return sendJson(res, 200, latest);
  if (url.pathname === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(": connected\n\n");
    if (latest) res.write(`data: ${JSON.stringify(latest)}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  if (!/^(index\.html|styles\.css|app\.js)$/.test(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  try {
    const body = await readFile(resolve(webRoot, file));
    res.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(500).end("Web asset unavailable");
  }
});

server.listen(port, host, () => {
  console.log(`[web] JEV paper terminal listening on http://${host}:${port}`);
});

async function shutdown(): Promise<void> {
  loop.stop();
  await session.close();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
