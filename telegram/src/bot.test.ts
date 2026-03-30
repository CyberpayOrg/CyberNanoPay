/**
 * Telegram HITL bot HTTP server tests
 *
 * Tests the /notify endpoint and /health.
 * Mocks the grammY bot to avoid needing a real token.
 */

// Mock grammy before importing
jest.mock("grammy", () => {
  const mockSendMessage = jest.fn().mockResolvedValue({});
  return {
    Bot: jest.fn().mockImplementation(() => ({
      command: jest.fn(),
      on: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      api: { sendMessage: mockSendMessage },
    })),
    InlineKeyboard: jest.fn().mockImplementation(() => ({
      text: jest.fn().mockReturnThis(),
    })),
    __mockSendMessage: mockSendMessage,
  };
});

// Mock @hono/node-server serve
jest.mock("@hono/node-server", () => ({
  serve: jest.fn(),
}));

// Set env before import
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_OWNER_CHAT_ID = "12345";

import { httpApp } from "./bot";

const grammy = require("grammy");
const mockSendMessage = grammy.__mockSendMessage;

beforeEach(() => {
  mockSendMessage.mockReset();
  mockSendMessage.mockResolvedValue({});
});

describe("GET /health", () => {
  it("returns ok", async () => {
    const res = await httpApp.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("telegram-hitl");
  });
});

describe("POST /notify", () => {
  it("sends approval message to owner", async () => {
    const res = await httpApp.request("/notify", {
      method: "POST",
      body: JSON.stringify({
        paymentId: "pay-001",
        from: "EQbuyer12345",
        to: "EQseller67890",
        amount: "5000000",
        requestedAt: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.success).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledWith(
      "12345",
      expect.stringContaining("pay-001"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it("returns 500 when sendMessage fails", async () => {
    mockSendMessage.mockRejectedValueOnce(new Error("Bot blocked"));
    const res = await httpApp.request("/notify", {
      method: "POST",
      body: JSON.stringify({
        paymentId: "pay-002",
        from: "EQbuyer",
        to: "EQseller",
        amount: "100",
        requestedAt: Date.now(),
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(500);
    const body = await res.json() as any;
    expect(body.error).toContain("Bot blocked");
  });
});
