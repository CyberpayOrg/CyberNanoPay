/**
 * MiniApp server tests
 *
 * Tests auth middleware, API proxy routes, and build-deposit-tx.
 * Mocks global fetch (TEE calls) and @ton/ton TonClient.
 */

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Mock @ton/ton to avoid real network calls
jest.mock("@ton/ton", () => ({
  TonClient: jest.fn().mockImplementation(() => ({
    runMethod: jest.fn().mockResolvedValue({
      stack: {
        readAddress: () => ({
          toString: () => "EQBvW8Z5iuBkMJYdnfAEM5JyTNkuWX3diqYENkWSwgvReCp6",
        }),
      },
    }),
  })),
}));

// Mock @hono/node-server
jest.mock("@hono/node-server", () => ({
  serve: jest.fn(),
}));

jest.mock("@hono/node-server/serve-static", () => ({
  serveStatic: () => jest.fn(),
}));

// Set env before import — use valid TON address format
process.env.TELEGRAM_BOT_TOKEN = "test-token-for-hmac";
process.env.GATEWAY_ADDRESS = "EQBvW8Z5iuBkMJYdnfAEM5JyTNkuWX3diqYENkWSwgvReCp6";
process.env.JETTON_MASTER = "EQBvW8Z5iuBkMJYdnfAEM5JyTNkuWX3diqYENkWSwgvReCp6";

import { app } from "./server";

beforeEach(() => {
  mockFetch.mockReset();
});

const TEST_ADDRESS = "EQBvW8Z5iuBkMJYdnfAEM5JyTNkuWX3diqYENkWSwgvReCp6";

// Helper: make request with X-Address header
function authedRequest(path: string, opts: RequestInit = {}) {
  return app.request(path, {
    ...opts,
    headers: {
      "X-Address": TEST_ADDRESS,
      ...((opts.headers as Record<string, string>) || {}),
    },
  });
}

// ── Auth middleware ──

describe("auth middleware", () => {
  it("returns 401 when no address provided", async () => {
    const res = await app.request("/api/account");
    expect(res.status).toBe(401);
    const body = await res.json() as any;
    expect(body.error).toContain("No address");
  });

  it("passes with X-Address header", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ available: "0" }),
    });

    const res = await authedRequest("/api/account");
    expect(res.status).toBe(200);
  });
});

// ── Account ──

describe("GET /api/account", () => {
  it("proxies balance from TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ available: "5000000", totalDeposited: "10000000" }),
    });

    const res = await authedRequest("/api/account");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.available).toBe("5000000");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/balance/${TEST_ADDRESS}`)
    );
  });

  it("returns 502 when TEE is down", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await authedRequest("/api/account");
    expect(res.status).toBe(502);
  });
});

// ── History ──

describe("GET /api/history", () => {
  it("proxies payment history", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ payments: [{ id: "p1" }] }),
    });

    const res = await authedRequest("/api/history?limit=10");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/history/payments/${TEST_ADDRESS}`)
    );
  });
});

// ── Deposits ──

describe("GET /api/deposits", () => {
  it("proxies deposit history", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ deposits: [] }),
    });

    const res = await authedRequest("/api/deposits");
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining(`/history/deposits/${TEST_ADDRESS}`)
    );
  });
});

// ── Topup ──

describe("POST /api/topup", () => {
  it("proxies simulated deposit", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const res = await authedRequest("/api/topup", {
      method: "POST",
      body: JSON.stringify({ amount: "1000000" }),
      headers: {
        "X-Address": TEST_ADDRESS,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/simulate-deposit"),
      expect.objectContaining({ method: "POST" })
    );
  });
});

// ── Policy ──

describe("POST /api/policy", () => {
  it("proxies policy update", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const res = await authedRequest("/api/policy", {
      method: "POST",
      body: JSON.stringify({
        spendingLimit: "5000000",
        dailyCap: "50000000",
        hitlThreshold: "10000000",
      }),
      headers: {
        "X-Address": TEST_ADDRESS,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/policy"),
      expect.objectContaining({ method: "POST" })
    );
  });
});

// ── Approve / Reject ──

describe("POST /api/approve/:id", () => {
  it("proxies approval to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const res = await authedRequest("/api/approve/pay-001", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/approve/pay-001"),
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("POST /api/reject/:id", () => {
  it("proxies rejection to TEE", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const res = await authedRequest("/api/reject/pay-002", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/reject/pay-002"),
      expect.objectContaining({ method: "POST" })
    );
  });
});

// ── Stats ──

describe("GET /api/stats", () => {
  it("proxies stats (no auth required)", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ totalDeposits: "100000000", accountCount: 5 }),
    });

    const res = await app.request("/api/stats");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.accountCount).toBe(5);
  });
});

// ── Build deposit tx ──

describe("POST /api/build-deposit-tx", () => {
  it("returns transaction payload", async () => {
    const res = await authedRequest("/api/build-deposit-tx", {
      method: "POST",
      body: JSON.stringify({ amount: "1000000" }),
      headers: {
        "X-Address": TEST_ADDRESS,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.to).toBe("EQBvW8Z5iuBkMJYdnfAEM5JyTNkuWX3diqYENkWSwgvReCp6");
    expect(body.value).toBeTruthy();
    expect(body.payload).toBeTruthy(); // base64 BOC
  });
});

// ── Register key ──

describe("POST /api/register-key", () => {
  it("validates public key format", async () => {
    const res = await authedRequest("/api/register-key", {
      method: "POST",
      body: JSON.stringify({ publicKey: "not-hex" }),
      headers: {
        "X-Address": TEST_ADDRESS,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(400);
  });

  it("proxies valid key registration", async () => {
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ success: true }),
    });

    const validKey = "a".repeat(64);
    const res = await authedRequest("/api/register-key", {
      method: "POST",
      body: JSON.stringify({ publicKey: validKey }),
      headers: {
        "X-Address": TEST_ADDRESS,
        "Content-Type": "application/json",
      },
    });
    expect(res.status).toBe(200);
  });
});

// ── MCP config ──

describe("GET /api/mcp-config", () => {
  it("returns MCP server config", async () => {
    const res = await authedRequest("/api/mcp-config");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.mcpServers).toBeDefined();
    expect(body.mcpServers["nano-pay"]).toBeDefined();
    expect(body.mcpServers["nano-pay"].command).toBe("npx");
  });
});
