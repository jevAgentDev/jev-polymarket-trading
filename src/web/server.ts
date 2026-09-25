import { createServer, type ServerResponse } from "node:http";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { AssetType, Chain, ClobClient, SignatureTypeV2 } from "@polymarket/clob-client-v2";
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
const taxWalletAddress = "0x264aeb2a2fe98a9e238d241d673dd280dc9b53ef";
const bscRpcUrl = process.env.BSC_RPC_URL ?? "https://bsc-rpc.publicnode.com";
const polygonRpcUrl = process.env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
const polymarketFunder = process.env.POLYMARKET_FUNDER?.trim();
let accountClientPromise: Promise<ClobClient> | null = null;

async function accountClient(): Promise<ClobClient> {
  if (accountClientPromise) return accountClientPromise;
  accountClientPromise = (async () => {
    const raw = process.env.WALLET_PVK?.trim();
    if (!raw || !polymarketFunder) throw new Error("Polymarket account credentials are not configured");
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
    const signer = createWalletClient({
      account: privateKeyToAccount(key),
      chain: polygon,
      transport: http(polygonRpcUrl),
    });
    const auth = new ClobClient({ host: "https://clob.polymarket.com", chain: Chain.POLYGON, signer });
    const creds = await auth.createOrDeriveApiKey();
    const signatureType = Number(process.env.SIGNATURE_TYPE ?? 3);
    const signature = signatureType === 0 ? SignatureTypeV2.EOA : signatureType === 1 ? SignatureTypeV2.POLY_PROXY : signatureType === 2 ? SignatureTypeV2.POLY_GNOSIS_SAFE : SignatureTypeV2.POLY_1271;
    return new ClobClient({
      host: "https://clob.polymarket.com",
      chain: Chain.POLYGON,
      signer,
      creds,
      signatureType: signature,
      funderAddress: polymarketFunder,
      throwOnError: true,
    });
  })();
  return accountClientPromise;
}
const decisionHistory: TickSnapshot[] = [];
const historyFile = resolve("data/jev-decisions.jsonl");

await mkdir(resolve("data"), { recursive: true });
try {
  const saved = await readFile(historyFile, "utf8");
  for (const line of saved.split("\n")) {
    if (!line.trim()) continue;
    try { decisionHistory.push(JSON.parse(line) as TickSnapshot); } catch { /* skip malformed records */ }
  }
  if (decisionHistory.length > 500) decisionHistory.splice(0, decisionHistory.length - 500);
} catch { /* history starts empty on first run */ }

const cfg = loadConfig(
  {
    ...process.env,
    LIVE_TRADING: "0",
    POLYMARKET_SOURCE: process.env.WEB_MARKET_SOURCE ?? "live",
    TICK_MS: process.env.TICK_MS ?? "5000",
  },
  { stubJudge: false, fixedSpot: false },
);
const session = await WindowSession.open(cfg);

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}

async function jsonRpc(rpcUrl: string, method: string, params: unknown[]): Promise<string> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`BSC RPC ${response.status}`);
  const payload = await response.json() as { result?: string; error?: { message?: string } };
  if (!payload.result) throw new Error(payload.error?.message ?? "BSC RPC returned no result");
  return payload.result;
}

const bscRpc = (method: string, params: unknown[]): Promise<string> => jsonRpc(bscRpcUrl, method, params);

function broadcast(snapshot: TickSnapshot): void {
  latest = snapshot;
  if (decisionHistory.at(-1)?.at !== snapshot.at) {
    decisionHistory.push(snapshot);
    if (decisionHistory.length > 500) decisionHistory.shift();
    void appendFile(historyFile, `${JSON.stringify(snapshot)}\n`, "utf8").catch((error) => console.error("[web] history write failed", error));
  }
  const payload = `data: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of clients) client.write(payload);
}

const loop = session.run(broadcast);

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      mode: "dry-run",
      judge: "jev",
      provider: "teamorouter",
      connected: latest != null,
    });
  }
  if (url.pathname === "/api/snapshot") return sendJson(res, 200, latest);
  if (url.pathname === "/api/tax-wallet") {
    try {
      const [balanceHex, nonceHex] = await Promise.all([
        bscRpc("eth_getBalance", [taxWalletAddress, "latest"]),
        bscRpc("eth_getTransactionCount", [taxWalletAddress, "latest"]),
      ]);
      const wei = BigInt(balanceHex);
      const whole = wei / 10n ** 18n;
      const fraction = (wei % 10n ** 18n).toString().padStart(18, "0").slice(0, 6);
      return sendJson(res, 200, {
        address: taxWalletAddress,
        bnbBalance: `${whole}.${fraction}`,
        transactionCount: Number(BigInt(nonceHex)),
        updatedAt: new Date().toISOString(),
        source: "bsc-rpc",
      });
    } catch (error) {
      return sendJson(res, 502, { address: taxWalletAddress, error: error instanceof Error ? error.message : "BSC RPC unavailable" });
    }
  }
  if (url.pathname === "/api/polymarket-account") {
    if (!polymarketFunder) return sendJson(res, 503, { error: "POLYMARKET_FUNDER is not configured" });
    try {
      const user = encodeURIComponent(polymarketFunder);
      const [positionsResponse, closedPositionsResponse, activityResponse, collateral] = await Promise.all([
        fetch(`https://data-api.polymarket.com/positions?user=${user}&sizeThreshold=0`),
        fetch(`https://data-api.polymarket.com/closed-positions?user=${user}&limit=50`),
        fetch(`https://data-api.polymarket.com/activity?user=${user}&limit=200`),
        accountClient().then((client) => client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })),
      ]);
      if (!positionsResponse.ok || !closedPositionsResponse.ok || !activityResponse.ok) throw new Error(`Polymarket Data API ${positionsResponse.status}/${closedPositionsResponse.status}/${activityResponse.status}`);
      const rawPositions = await positionsResponse.json() as Array<Record<string, unknown>>;
      const apiClosedPositions = await closedPositionsResponse.json() as Array<Record<string, unknown>>;
      const activity = await activityResponse.json() as Array<Record<string, unknown>>;
      // Polymarket keeps settled, unclaimed positions in /positions with redeemable=true.
      // They are historical results, not live exposure.
      const positions = rawPositions.filter((item) => item.redeemable !== true);
      const residualClosed = rawPositions.filter((item) => item.redeemable === true);
      const knownClosed = new Set(apiClosedPositions.map((item) => `${item.conditionId ?? ""}:${item.outcome ?? ""}`));
      const closedPositions = [...apiClosedPositions, ...residualClosed.filter((item) => !knownClosed.has(`${item.conditionId ?? ""}:${item.outcome ?? ""}`))];
      const usdcBalance = Number(collateral.balance) / 1e6;
      const positionValue = positions.reduce((sum, item) => sum + Number(item.currentValue ?? 0), 0);
      const cashPnl = positions.reduce((sum, item) => sum + Number(item.cashPnl ?? 0), 0);
      const realizedPnl = closedPositions.reduce((sum, item) => sum + Number(item.cashPnl ?? 0) + Number(item.realizedPnl ?? 0), 0);
      const resolvedCost = closedPositions.reduce((sum, item) => sum + Number(item.initialValue ?? (Number(item.avgPrice ?? 0) * Number(item.totalBought ?? 0))), 0);
      const wins = closedPositions.filter((item) => Number(item.cashPnl ?? 0) + Number(item.realizedPnl ?? 0) > 0).length;
      const losses = closedPositions.filter((item) => Number(item.cashPnl ?? 0) + Number(item.realizedPnl ?? 0) < 0).length;
      return sendJson(res, 200, {
        funder: polymarketFunder,
        profileUrl: `https://polymarket.com/profile/${polymarketFunder}`,
        usdcBalance,
        positionValue,
        portfolioValue: usdcBalance + positionValue,
        cashPnl,
        realizedPnl,
        positions,
        closedPositions,
        activity,
        stats: {
          open: positions.length,
          resolved: closedPositions.length,
          wins,
          losses,
          winRate: wins + losses > 0 ? wins / (wins + losses) : null,
          netReturn: resolvedCost > 0 ? realizedPnl / resolvedCost : null,
        },
        updatedAt: new Date().toISOString(),
        source: "polymarket-clob-and-data-api",
      });
    } catch (error) {
      return sendJson(res, 502, { error: error instanceof Error ? error.message : "Polymarket account data unavailable" });
    }
  }
  if (url.pathname === "/api/decisions") {
    const requested = Number(url.searchParams.get("limit") ?? 100);
    const limit = Math.min(500, Math.max(1, Number.isFinite(requested) ? requested : 100));
    return sendJson(res, 200, decisionHistory.slice(-limit).reverse());
  }
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

  const routes: Record<string, string> = {
    "/": "index.html",
    "/positions": "positions.html",
    "/history": "history.html",
    "/about": "about.html",
  };
  const file = routes[url.pathname] ?? url.pathname.slice(1);
  if (!/^(index\.html|positions\.html|history\.html|about\.html|styles\.css|pages\.css|editorial\.css|content-pages\.css|live-jev\.css|app\.js|jev-logo\.svg)$/.test(file)) {
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
