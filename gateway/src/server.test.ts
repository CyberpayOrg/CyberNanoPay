/**
 * Gateway server tests
 *
 * Tests rate limiting, requirePayment middleware, and proxy routes.
 * Mocks global fetch (TEE calls).
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Must import after mocking fetch
import { app, requirePayment } from "./server";
import { Hono } from "hono";

beforeEach(() => {
  mockFetch.mockReset();
});

// ── Health ──

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});

// ── Rate limiter ──

describe("rate limiter", () => {
  it("includes rate limit headers", async () => {
    const res = await app.request("/health");
    expect(res.headers.get("X-RateLimit-Limit")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeTruthy();
  });
});

// ── Proxy routes ──

describe("GET /balance/:address", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ available: "1000000", totalDeposited: "2000000" }),
    });

    const res = await app.request("/balance/EQtest123");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.available).toBe("1000000");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/balance/EQtest123")
    );
  });
});

describe("GET /stats", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ totalDeposits: "5000000", accountCount: 10 }),
    });

    const res = await app.request("/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accountCount).toBe(10);
  });
});

describe("POST /verify", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true, confirmationId: "abc" }),
      status: 200,
    });

    const res = await app.request("/verify", {
      method: "POST",
      body: JSON.stringify({ from: "EQ1", to: "EQ2", amount: "1000" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});

describe("GET /attestation", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ quote: "base64quote", timestamp: 123 }),
    });

    const res = await app.request("/attestation");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote).toBe("base64quote");
  });
});

// ── requirePayment middleware ──

describe("requirePayment", () => {
  const testApp = new Hono();
  testApp.get(
    "/paid",
    requirePayment({ amount: "1000", to: "EQseller" }),
    (c) => {
      const payment = (c as any).get("payment");
      return c.json({ ok: true, payment });
    }
  );

  it("returns 402 when no Payment-Signature header", async () => {
    const res = await testApp.request("/paid");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error).toBe("Payment required");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("returns 402 with x402 requirements in header", async () => {
    const res = await testApp.request("/paid");
    const header = res.headers.get("PAYMENT-REQUIRED")!;
    const requirements = JSON.parse(Buffer.from(header, "base64").toString());
    expect(requirements.x402Version).toBe(2);
    expect(requirements.accepts[0].amount).toBe("1000");
    expect(requirements.accepts[0].payTo).toBe("EQseller");
  });

  it("returns 400 for invalid payment header", async () => {
    const res = await testApp.request("/paid", {
      headers: { "Payment-Signature": "not-valid-base64!!!" },
    });
    expect(res.status).toBe(400);
  });

  it("passes through when TEE verifies payment", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true, confirmationId: "conf123" }),
    });

    const payload = {
      authorization: { from: "EQbuyer", to: "EQseller", amount: "1000", nonce: 1, sig: "abc" },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await testApp.request("/paid", {
      headers: { "Payment-Signature": encoded },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.payment.confirmationId).toBe("conf123");
  });

  it("returns 402 when TEE rejects payment", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: false, error: "Insufficient balance" }),
    });

    const payload = {
      authorization: { from: "EQbuyer", to: "EQseller", amount: "1000", nonce: 1, sig: "abc" },
    };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");

    const res = await testApp.request("/paid", {
      headers: { "Payment-Signature": encoded },
    });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.code).toBe("PAYMENT_FAILED");
  });
});

// ── Demo premium data ──

describe("GET /demo/premium-data", () => {
  it("returns 402 without payment", async () => {
    const res = await app.request("/demo/premium-data");
    expect(res.status).toBe(402);
  });
});

// ── Policy proxy ──

describe("GET /policy/:address", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ policy: { spendingLimit: "10000000" } }),
    });

    const res = await app.request("/policy/EQtest");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.policy.spendingLimit).toBe("10000000");
  });
});

describe("GET /approvals", () => {
  it("proxies to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ approvals: [] }),
    });

    const res = await app.request("/approvals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approvals).toEqual([]);
  });
});
