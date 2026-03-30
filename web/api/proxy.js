/**
 * TEE API Proxy — Vercel Edge Function
 *
 * Forwards authenticated dashboard requests to the TEE aggregator.
 * Used by web/app.html dashboard (TonConnect auth via X-Address header).
 *
 * Usage:  /api/proxy?path=/balance/EQ...
 *         /api/proxy?path=/history/payments/EQ...&limit=50
 */

const TEE_URL =
  process.env.TEE_URL ||
  "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network";

export const config = { runtime: "edge" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Address",
};

// Allowed TEE path prefixes (prevent open proxy abuse)
const ALLOWED_PREFIXES = [
  "/balance/",
  "/history/",
  "/receipts/",
  "/receipt/",
  "/stats",
  "/health",
  "/attestation",
  "/policy",
  "/approvals",
  "/approve/",
  "/reject/",
  "/simulate-deposit",
  "/register-key",
  "/verify",
  "/flush-for-withdraw",
  "/build-withdraw-tx",
];

export default async function handler(req) {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(req.url);
  const path = url.searchParams.get("path");

  if (!path) {
    return new Response(JSON.stringify({ error: "Missing ?path= parameter" }), {
      status: 400,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  // Validate path against allowlist
  const allowed = ALLOWED_PREFIXES.some(
    (p) => path === p.replace(/\/$/, "") || path.startsWith(p)
  );
  if (!allowed) {
    return new Response(JSON.stringify({ error: "Path not allowed" }), {
      status: 403,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const teeUrl = `${TEE_URL}${path}`;
    const headers = { "Content-Type": "application/json" };

    const options = { method: req.method, headers };
    if (req.method === "POST") {
      options.body = await req.text();
    }

    const res = await fetch(teeUrl, options);
    const body = await res.text();

    return new Response(body, {
      status: res.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "TEE unavailable" }), {
      status: 502,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
}
