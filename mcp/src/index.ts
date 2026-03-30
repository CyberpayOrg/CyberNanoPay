#!/usr/bin/env node
/**
 * NanoPay MCP Server
 *
 * Gives AI agents gas-free nanopayment capabilities on TON.
 * Works alongside Agentic Wallets — agent uses agentic wallet for on-chain ops,
 * and this MCP for high-frequency micropayments.
 *
 * Tools:
 *   nano_deposit       — Deposit funds (simulated or on-chain)
 *   nano_pay           — Sign and submit a micropayment
 *   nano_balance       — Check balance
 *   nano_history       — View payment history
 *   nano_receipt       — Get a TEE-signed receipt
 *   nano_attestation   — Verify TEE attestation
 *   nano_flush         — Trigger batch settlement (settle pending payments on-chain)
 *   nano_withdraw      — Request withdrawal (flush unsettled → prepare for on-chain withdraw)
 *   nano_policy        — Get or set spending policy (limits, daily cap, HITL threshold)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import nacl from "tweetnacl";
import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TEE_URL = process.env.NANO_TEE_URL ?? "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network";
const ADMIN_TOKEN = process.env.NANO_ADMIN_TOKEN ?? "";

// ── Keypair management ──
// Agent generates or loads a keypair for signing payments
// Seed is persisted to ~/.cyberpay/agent-seed so address survives restarts

const SEED_DIR = join(homedir(), ".cyberpay");
const SEED_FILE = join(SEED_DIR, "agent-seed");

let agentKeypair: nacl.SignKeyPair | null = null;

function getOrCreateKeypair(): nacl.SignKeyPair {
  if (agentKeypair) return agentKeypair;

  // Priority 1: env var
  const envSeed = process.env.NANO_AGENT_SEED;
  if (envSeed) {
    agentKeypair = nacl.sign.keyPair.fromSeed(Buffer.from(envSeed, "hex"));
    return agentKeypair;
  }

  // Priority 2: persisted seed file
  try {
    const saved = readFileSync(SEED_FILE, "utf-8").trim();
    if (saved.length === 64) {
      agentKeypair = nacl.sign.keyPair.fromSeed(Buffer.from(saved, "hex"));
      return agentKeypair;
    }
  } catch {
    // File doesn't exist yet — will create below
  }

  // Priority 3: generate new and persist
  const seed = nacl.randomBytes(32);
  agentKeypair = nacl.sign.keyPair.fromSeed(seed);
  try {
    mkdirSync(SEED_DIR, { recursive: true });
    writeFileSync(SEED_FILE, Buffer.from(seed).toString("hex"), { mode: 0o600 });
  } catch {
    // Non-fatal: agent works but address changes on restart
  }

  return agentKeypair;
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function agentAddress(): string {
  const kp = getOrCreateKeypair();
  return "0:" + toHex(kp.publicKey.slice(0, 32));
}

// ── Payment signing ──
// Canonical message format must match tee/src/verifier.ts and sdk/src/message.ts exactly.
// Format: "CyberGateway:v1:" + from_hash(32) + to_hash(32) + amount(16) + validBefore(8) + nonce(32)
// Address hash: for raw "wc:hex" format, hash is the 32 bytes from the hex part.

function parseAddressHash(addr: string): Buffer {
  // Support raw format "0:hex..." (workchain:hash)
  const parts = addr.split(":");
  if (parts.length === 2 && parts[1].length === 64) {
    return Buffer.from(parts[1], "hex");
  }
  // Fallback: treat entire string as hex (shouldn't happen with proper addresses)
  throw new Error(`Unsupported address format: ${addr}`);
}

function signPayment(to: string, amount: bigint, nonce: string, validBefore: number): string {
  const kp = getOrCreateKeypair();
  const prefix = Buffer.from("CyberGateway:v1:");
  const from = agentAddress();
  const fromHash = parseAddressHash(from);
  const toHash = parseAddressHash(to);

  const buf = Buffer.alloc(prefix.length + 32 + 32 + 16 + 8 + 32);
  let offset = 0;
  prefix.copy(buf, offset); offset += prefix.length;
  fromHash.copy(buf, offset); offset += 32;
  toHash.copy(buf, offset); offset += 32;

  const amountBuf = Buffer.alloc(16);
  let amt = amount;
  for (let i = 15; i >= 0; i--) { amountBuf[i] = Number(amt & 0xffn); amt >>= 8n; }
  amountBuf.copy(buf, offset); offset += 16;

  const timeBuf = Buffer.alloc(8);
  let ts = BigInt(validBefore);
  for (let i = 7; i >= 0; i--) { timeBuf[i] = Number(ts & 0xffn); ts >>= 8n; }
  timeBuf.copy(buf, offset); offset += 8;

  Buffer.from(nonce, "hex").copy(buf, offset);

  const hash = createHash("sha256").update(buf).digest();
  const sig = nacl.sign.detached(new Uint8Array(hash), kp.secretKey);
  return toHex(sig);
}

// ── Helpers ──

async function teeRequest(path: string, options?: RequestInit): Promise<any> {
  const res = await fetch(`${TEE_URL}${path}`, options);
  return res.json();
}

function adminHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (ADMIN_TOKEN) h["Authorization"] = `Bearer ${ADMIN_TOKEN}`;
  return h;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

// ── MCP Server ──

const server = new McpServer({
  name: "nano-pay",
  version: "0.1.0",
});

// Tool: nano_attestation
server.tool("nano_attestation", "Get TEE attestation report — proves the payment service runs in a secure enclave", {}, async () => {
  const data = await teeRequest("/attestation");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: nano_balance
server.tool("nano_balance", "Check nanopay balance for an address", {
  address: z.string().optional().describe("TON address to check. Defaults to agent's own address."),
}, async ({ address }) => {
  const addr = address ?? agentAddress();
  const data = await teeRequest(`/balance/${addr}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: nano_deposit
server.tool("nano_deposit", "Deposit funds into NanoPay (simulated for testnet)", {
  amount: z.string().describe("Amount in USDT units (6 decimals). e.g. '10000000' = $10"),
  address: z.string().optional().describe("Depositor address. Defaults to agent's own address."),
}, async ({ amount, address }) => {
  const addr = address ?? agentAddress();
  const kp = getOrCreateKeypair();
  // Register pubkey first
  await teeRequest("/register-key", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ address: addr, publicKey: toHex(kp.publicKey) }),
  });
  // Simulate deposit
  const data = await teeRequest("/simulate-deposit", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ address: addr, amount }),
  });
  return { content: [{ type: "text", text: `Deposited ${Number(amount) / 1e6} USDT. Balance: ${Number(data.balance) / 1e6} USDT` }] };
});

// Tool: nano_pay
server.tool("nano_pay", "Make a gas-free micropayment via TEE", {
  to: z.string().describe("Recipient address"),
  amount: z.string().describe("Amount in USDT units (6 decimals). e.g. '1000' = $0.001"),
}, async ({ to, amount }) => {
  const from = agentAddress();
  const nonce = randomHex(32);
  const validBefore = Math.floor(Date.now() / 1000) + 300;
  const signature = signPayment(to, BigInt(amount), nonce, validBefore);

  const data = await teeRequest("/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, amount, validBefore, nonce, signature }),
  });

  if (data.success) {
    return { content: [{ type: "text", text: `✓ Paid ${Number(amount) / 1e6} USDT to ${to}\nConfirmation: ${data.confirmationId}\nRemaining: ${Number(data.remainingBalance) / 1e6} USDT` }] };
  }
  return { content: [{ type: "text", text: `✗ Payment failed: ${data.error}` }] };
});

// Tool: nano_history
server.tool("nano_history", "View recent payment history", {
  address: z.string().optional().describe("Address to check. Defaults to agent's own."),
  limit: z.number().optional().describe("Max results (default 10)"),
}, async ({ address, limit }) => {
  const addr = address ?? agentAddress();
  const data = await teeRequest(`/history/payments/${addr}?limit=${limit ?? 10}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: nano_receipt
server.tool("nano_receipt", "Get a TEE-signed payment receipt", {
  confirmationId: z.string().describe("Payment confirmation ID"),
}, async ({ confirmationId }) => {
  const data = await teeRequest(`/receipt/${confirmationId}`);
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: nano_stats
server.tool("nano_stats", "Get global protocol statistics", {}, async () => {
  const data = await teeRequest("/stats");
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
});

// Tool: nano_flush
server.tool("nano_flush", "Trigger batch settlement to chain (settles pending payments on-chain)", {}, async () => {
  const data = await teeRequest("/flush", {
    method: "POST",
    headers: adminHeaders(),
  });
  return { content: [{ type: "text", text: `Settlement: ${JSON.stringify(data)}` }] };
});

// Tool: nano_flush
server.tool("nano_flush", "Trigger batch settlement — settles pending offchain payments on-chain. Use before withdrawing.", {}, async () => {
  const data = await teeRequest("/flush", {
    method: "POST",
    headers: adminHeaders(),
  });
  if (data.settled) {
    return { content: [{ type: "text", text: "✓ Batch settled on-chain successfully" }] };
  }
  return { content: [{ type: "text", text: `Flush result: ${JSON.stringify(data)}` }] };
});

// Tool: nano_withdraw
server.tool("nano_withdraw", "Request withdrawal — flushes unsettled payments for your address so funds can be withdrawn on-chain", {
  address: z.string().optional().describe("Address to withdraw for. Defaults to agent's own."),
}, async ({ address }) => {
  const addr = address ?? agentAddress();
  const data = await teeRequest("/flush-for-withdraw", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: addr }),
  });
  if (data.error) {
    return { content: [{ type: "text", text: `✗ Withdraw failed: ${data.error}` }] };
  }
  const balanceUsdt = Number(data.balance) / 1e6;
  if (data.settled) {
    return { content: [{ type: "text", text: `✓ Settlement complete. On-chain balance: ${balanceUsdt} USDT. You can now withdraw via the CyberGateway contract (InitiateWithdraw → wait cooldown → CompleteWithdraw).` }] };
  }
  return { content: [{ type: "text", text: `No pending payments to settle. Current balance: ${balanceUsdt} USDT. ${data.message ?? ""}` }] };
});

// Tool: nano_policy_get
server.tool("nano_policy_get", "Get spending policy for an address (limits, daily cap, HITL threshold)", {
  address: z.string().optional().describe("Address to check. Defaults to agent's own."),
}, async ({ address }) => {
  const addr = address ?? agentAddress();
  const data = await teeRequest(`/policy/${addr}`);
  if (!data.policy) {
    return { content: [{ type: "text", text: `No spending policy set for ${addr}` }] };
  }
  const p = data.policy;
  return { content: [{ type: "text", text: `Policy for ${addr}:\n  Spending Limit: ${Number(p.spendingLimit) / 1e6} USDT per tx\n  Daily Cap: ${Number(p.dailyCap) / 1e6} USDT/day\n  HITL Threshold: ${Number(p.hitlThreshold) / 1e6} USDT (requires human approval above this)` }] };
});

// Tool: nano_policy_set
server.tool("nano_policy_set", "Set spending policy — per-transaction limit, daily cap, and HITL approval threshold", {
  address: z.string().optional().describe("Address to set policy for. Defaults to agent's own."),
  spendingLimit: z.string().describe("Max amount per transaction in USDT units (6 decimals). e.g. '5000000' = $5"),
  dailyCap: z.string().describe("Max daily spending in USDT units. e.g. '50000000' = $50"),
  hitlThreshold: z.string().describe("Payments above this require human approval. e.g. '1000000' = $1"),
}, async ({ address, spendingLimit, dailyCap, hitlThreshold }) => {
  const addr = address ?? agentAddress();
  const data = await teeRequest("/policy", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ address: addr, spendingLimit, dailyCap, hitlThreshold }),
  });
  if (data.success) {
    return { content: [{ type: "text", text: `✓ Policy set for ${addr}:\n  Spending Limit: ${Number(spendingLimit) / 1e6} USDT/tx\n  Daily Cap: ${Number(dailyCap) / 1e6} USDT/day\n  HITL Threshold: ${Number(hitlThreshold) / 1e6} USDT` }] };
  }
  return { content: [{ type: "text", text: `✗ Failed: ${data.error}` }] };
});

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
