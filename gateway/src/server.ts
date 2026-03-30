/**
 * NanoPay HTTP Gateway
 *
 * x402-compatible HTTP gateway for sellers.
 * Sellers integrate this to accept nanopayments.
 *
 * Flow:
 *   1. Seller's API returns 402 with payment requirements
 *   2. Buyer signs authorization
 *   3. Buyer retries request with Payment-Signature header
 *   4. Gateway middleware verifies via TEE → serves resource
 *
 * This is a thin proxy that forwards verification to the TEE aggregator.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "4031");
const TEE_URL = process.env.TEE_URL ?? "http://localhost:4030";
const GATEWAY_ADDRESS = process.env.GATEWAY_ADDRESS ?? "";

// ── Simple in-memory rate limiter ──

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX ?? "120"); // 120 req/min

function rateLimit() {
  return async (c: any, next: any) => {
    const ip = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown";
    const now = Date.now();
    let entry = rateLimitMap.get(ip);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
      rateLimitMap.set(ip, entry);
    }

    entry.count++;
    c.header("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    c.header("X-RateLimit-Remaining", String(Math.max(0, RATE_LIMIT_MAX - entry.count)));

    if (entry.count > RATE_LIMIT_MAX) {
      return c.json({ error: "Too many requests" }, 429);
    }

    await next();
  };
}

// Clean up stale entries every 5 minutes
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);
cleanupTimer.unref();

export const app = new Hono();

app.use("*", rateLimit());

// ── x402 Middleware Factory ──

/**
 * Create middleware that gates a route behind nanopayment.
 *
 * Usage:
 *   app.get("/premium-data", requirePayment({ amount: "1000", to: sellerAddress }), handler)
 */
export function requirePayment(opts: {
  amount: string;  // Jetton smallest unit
  to: string;      // Seller address
}) {
  return async (c: any, next: any) => {
    const paymentHeader = c.req.header("Payment-Signature");

    if (!paymentHeader) {
      const requirements = {
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "ton:mainnet",
            amount: opts.amount,
            payTo: opts.to,
            asset: "USDT",
            maxTimeoutSeconds: 345600,
            extra: {
              name: "NanoPayBatched",
              version: "1",
              gatewayContract: GATEWAY_ADDRESS,
              teeEndpoint: TEE_URL,
            },
          },
        ],
      };

      c.header(
        "PAYMENT-REQUIRED",
        Buffer.from(JSON.stringify(requirements)).toString("base64")
      );
      return c.json({ error: "Payment required" }, 402);
    }

    // Decode payment payload
    let payload: any;
    try {
      payload = JSON.parse(
        Buffer.from(paymentHeader, "base64").toString()
      );
    } catch {
      return c.json({ error: "Invalid payment header" }, 400);
    }

    // Forward to TEE for verification
    const verifyRes = await fetch(`${TEE_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload.authorization),
    });

    const result = await verifyRes.json() as any;

    if (!result.success) {
      return c.json(
        { error: result.error, code: "PAYMENT_FAILED" },
        402
      );
    }

    // Payment verified — attach confirmation to context
    (c as any).set("payment", {
      confirmationId: result.confirmationId,
      from: payload.authorization.from,
      amount: payload.authorization.amount,
    });

    await next();
  };
}

// ── Gateway API Routes ──

// Health
app.get("/health", (c) => c.json({ status: "ok", service: "cyber-nano-pay" }));

// Proxy balance check to TEE
app.get("/balance/:address", async (c) => {
  const address = c.req.param("address");
  const res = await fetch(`${TEE_URL}/balance/${address}`);
  return c.json(await res.json());
});

// Proxy stats to TEE
app.get("/stats", async (c) => {
  const res = await fetch(`${TEE_URL}/stats`);
  return c.json(await res.json());
});

// Proxy verify to TEE (for direct integration)
app.post("/verify", async (c) => {
  const body = await c.req.text();
  const res = await fetch(`${TEE_URL}/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return c.json(await res.json(), res.status as any);
});

// TEE attestation (so sellers can verify the TEE)
app.get("/attestation", async (c) => {
  const res = await fetch(`${TEE_URL}/attestation`);
  return c.json(await res.json());
});

// Proxy policy endpoints
app.post("/policy", async (c) => {
  const body = await c.req.text();
  const res = await fetch(`${TEE_URL}/policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return c.json(await res.json(), res.status as any);
});

app.get("/policy/:address", async (c) => {
  const address = c.req.param("address");
  const res = await fetch(`${TEE_URL}/policy/${address}`);
  return c.json(await res.json());
});

// HITL approval status
app.get("/approvals", async (c) => {
  const res = await fetch(`${TEE_URL}/approvals`);
  return c.json(await res.json());
});

// ── Example: protected resource ──

const DEMO_SELLER = process.env.DEMO_SELLER ?? "";

app.get(
  "/demo/premium-data",
  requirePayment({ amount: "1000", to: DEMO_SELLER }), // $0.001 USDT
  (c) => {
    const payment = (c as any).get("payment");
    return c.json({
      data: "This is premium content you paid for",
      payment: {
        confirmationId: payment.confirmationId,
        amount: payment.amount,
      },
    });
  }
);

// ── Start (only when run directly) ──

if (require.main === module) {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[cyber-nano-pay] HTTP Gateway on http://localhost:${info.port}`);
  });
}
