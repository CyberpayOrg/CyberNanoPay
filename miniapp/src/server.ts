/**
 * NanoPay Mini App — Backend Server
 *
 * Serves the Telegram Mini App frontend and proxies API calls to TEE.
 * Validates Telegram WebApp initData for authentication.
 *
 * Endpoints:
 *   GET  /                         — Serve Mini App HTML
 *   GET  /api/account              — Get balance, policy, daily spent
 *   GET  /api/history              — Payment history
 *   GET  /api/approvals            — Pending HITL approvals
 *   POST /api/topup                — Simulate deposit (dev)
 *   POST /api/build-deposit-tx     — Build on-chain Jetton transfer payload for TonConnect
 *   POST /api/register-key         — Register agent Ed25519 public key
 *   POST /api/policy               — Update spending policy
 *   POST /api/approve/:id          — Approve pending payment
 *   POST /api/reject/:id           — Reject pending payment
 *   GET  /api/mcp-config           — Get MCP config JSON for this address
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import crypto from "crypto";
import { beginCell, Address, toNano } from "@ton/core";
import { TonClient } from "@ton/ton";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "4033");
const TEE_URL = process.env.TEE_URL ?? "http://localhost:4030";
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const GATEWAY_ADDRESS = process.env.GATEWAY_ADDRESS ?? "";
const JETTON_MASTER = process.env.JETTON_MASTER ?? "";
const TON_RPC = process.env.TON_RPC ?? "https://toncenter.com/api/v2/jsonRPC";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY ?? "";

type Variables = {
  address: string;
  initData: string;
};

export const app = new Hono<{ Variables: Variables }>();

// ── Telegram WebApp Auth ──

/**
 * Validate Telegram Mini App initData.
 * Returns parsed user data or null if invalid.
 * See: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
function validateInitData(initData: string): Record<string, string> | null {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  params.delete("hash");
  const entries = Array.from(params.entries());
  entries.sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const computedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (computedHash !== hash) return null;

  const result: Record<string, string> = {};
  for (const [k, v] of params.entries()) {
    result[k] = v;
  }
  result.hash = hash;
  return result;
}

/**
 * Extract user address from initData.
 * In production, map Telegram user ID → TON address via registration.
 * For now, use query_id or user.id as lookup key.
 */
function extractAddress(initData: string): string | null {
  const data = validateInitData(initData);
  if (!data) return null;

  // Try to get address from start_param (deep link: ?startapp=<address>)
  if (data.start_param) return data.start_param;

  // Fallback: parse user object for ID
  try {
    const user = JSON.parse(data.user ?? "{}");
    return user.id ? `tg_${user.id}` : null;
  } catch {
    return null;
  }
}

// ── Auth middleware ──

async function authMiddleware(c: any, next: any) {
  const initData = c.req.header("X-Telegram-Init-Data") ?? "";
  const address =
    c.req.header("X-Address") ?? extractAddress(initData) ?? "";

  if (!address) {
    return c.json({ error: "No address provided" }, 401);
  }

  c.set("address", address);
  c.set("initData", initData);
  await next();
}

// ── API Routes ──

// Account overview: balance + policy + daily spent
app.get("/api/account", authMiddleware, async (c) => {
  const address = c.get("address");
  try {
    const res = await fetch(`${TEE_URL}/balance/${address}`);
    const data = await res.json();
    return c.json(data);
  } catch (err) {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Payment history
app.get("/api/history", authMiddleware, async (c) => {
  const address = c.get("address");
  const limit = c.req.query("limit") ?? "50";
  try {
    const res = await fetch(
      `${TEE_URL}/history/payments/${address}?limit=${limit}`
    );
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Deposit history
app.get("/api/deposits", authMiddleware, async (c) => {
  const address = c.get("address");
  const limit = c.req.query("limit") ?? "50";
  try {
    const res = await fetch(
      `${TEE_URL}/history/deposits/${address}?limit=${limit}`
    );
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Pending HITL approvals
app.get("/api/approvals", authMiddleware, async (c) => {
  try {
    const res = await fetch(`${TEE_URL}/approvals`);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Top up (simulate deposit for dev; in production triggers real Jetton transfer)
app.post("/api/topup", authMiddleware, async (c) => {
  const address = c.get("address");
  const body = await c.req.json<{ amount: string }>();
  try {
    const res = await fetch(`${TEE_URL}/simulate-deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, amount: body.amount }),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Update spending policy
app.post("/api/policy", authMiddleware, async (c) => {
  const address = c.get("address");
  const body = await c.req.json<{
    spendingLimit: string;
    dailyCap: string;
    hitlThreshold: string;
  }>();
  try {
    const res = await fetch(`${TEE_URL}/policy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, ...body }),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Approve / Reject HITL
app.post("/api/approve/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  try {
    const res = await fetch(`${TEE_URL}/approve/${id}`, { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

app.post("/api/reject/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  try {
    const res = await fetch(`${TEE_URL}/reject/${id}`, { method: "POST" });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

// Global stats
app.get("/api/stats", async (c) => {
  try {
    const res = await fetch(`${TEE_URL}/stats`);
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

/**
 * Build Jetton transfer transaction payload for TonConnect.
 * Returns { to, value, payload } for TonConnect sendTransaction.
 *
 * The user signs+sends this via TonConnect; their Jetton wallet
 * forwards USDT to CyberGateway for on-chain deposit.
 */
app.post("/api/build-deposit-tx", authMiddleware, async (c) => {
  if (!GATEWAY_ADDRESS || !JETTON_MASTER) {
    return c.json({ error: "On-chain deposit not configured (no GATEWAY_ADDRESS or JETTON_MASTER)" }, 501);
  }

  const body = await c.req.json<{ amount: string }>();
  const address = c.get("address");

  let userJettonWallet: string;
  try {
    const client = new TonClient({
      endpoint: TON_RPC,
      apiKey: TONCENTER_API_KEY || undefined,
    });
    const master = Address.parse(JETTON_MASTER);
    const userAddr = Address.parse(address);
    const result = await client.runMethod(master, "get_wallet_address", [
      { type: "slice", cell: beginCell().storeAddress(userAddr).endCell() },
    ]);
    userJettonWallet = result.stack.readAddress().toString();
  } catch (err) {
    return c.json({ error: `Failed to resolve Jetton wallet: ${err}` }, 502);
  }

  // Build Jetton transfer cell: transfer USDT to CyberGateway
  const transferBody = beginCell()
    .storeUint(0x0f8a7ea5, 32)           // op: jetton transfer
    .storeUint(0, 64)                     // query_id
    .storeCoins(BigInt(body.amount))      // amount (6 decimals)
    .storeAddress(Address.parse(GATEWAY_ADDRESS))  // destination
    .storeAddress(Address.parse(address))           // response_destination
    .storeBit(0)                          // no custom_payload
    .storeCoins(toNano("0.01"))           // forward_ton_amount
    .storeBit(0)                          // forward_payload inline
    .endCell();

  return c.json({
    to: userJettonWallet,
    value: toNano("0.15").toString(),      // TON for gas
    payload: transferBody.toBoc().toString("base64"),
  });
});

/**
 * Register an agent's Ed25519 public key.
 * Maps address → pubkey so TEE can verify the agent's payment signatures.
 */
app.post("/api/register-key", authMiddleware, async (c) => {
  const body = await c.req.json<{ publicKey: string }>();
  const address = c.get("address");

  if (!body.publicKey || !/^[0-9a-fA-F]{64}$/.test(body.publicKey)) {
    return c.json({ error: "publicKey must be 64 hex chars (Ed25519 public key)" }, 400);
  }

  try {
    const res = await fetch(`${TEE_URL}/register-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, publicKey: body.publicKey }),
    });
    return c.json(await res.json());
  } catch {
    return c.json({ error: "TEE unavailable" }, 502);
  }
});

/**
 * Return an MCP config JSON snippet for connecting an AI agent.
 * Includes the agent's pre-configured TEE URL.
 */
app.get("/api/mcp-config", authMiddleware, async (c) => {
  return c.json({
    mcpServers: {
      ton: {
        command: "npx",
        args: ["-y", "@ton/mcp@alpha"],
      },
      "nano-pay": {
        command: "npx",
        args: ["@cyberpay/nano-mcp"],
        env: {
          NANO_TEE_URL: TEE_URL,
        },
      },
    },
  });
});

// ── Serve static frontend ──
app.use("/assets/*", serveStatic({ root: "./public" }));

// TonConnect manifest (must be publicly accessible)
app.get("/tonconnect-manifest.json", serveStatic({ root: "./public", path: "/tonconnect-manifest.json" }));

// Serve main HTML for all non-API routes (SPA)
app.get("/*", async (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ error: "Not found" }, 404);
  }
  const fs = await import("fs");
  const html = fs.readFileSync("public/index.html", "utf-8");
  return c.html(html);
});

// ── Start (only when run directly) ──

if (require.main === module) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[cyber-nano-pay-miniapp] http://localhost:${info.port}`);
  });
}
