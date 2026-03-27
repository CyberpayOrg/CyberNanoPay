#!/usr/bin/env node
/**
 * CyberNanoPay MCP Server
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
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import nacl from "tweetnacl";
import { createHash } from "crypto";

const TEE_URL = process.env.NANO_TEE_URL ?? "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network";
const ADMIN_TOKEN = process.env.NANO_ADMIN_TOKEN ?? "";

// ── Keypair management ──
// Agent generates or loads a keypair for signing payments

let agentKeypair: nacl.SignKeyPair | null = null;

function getOrCreateKeypair(): nacl.SignKeyPair {
  if (agentKeypair) return agentKeypair;
  const seed = process.env.NANO_AGENT_SEED;
  if (seed) {
    agentKeypair = nacl.sign.keyPair.fromSeed(Buffer.from(seed, "hex"));
  } else {
    agentKeypair = nacl.sign.keyPair();
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

function signPayment(to: string, amount: bigint, nonce: string, validBefore: number): string {
  const kp = getOrCreateKeypair();
  const prefix = Buffer.from("CyberGateway:v1:");
  const fromHash = Buffer.from(kp.publicKey.slice(0, 32));
  // Parse "to" address hash
  const toClean = to.startsWith("0:") ? to.slice(2) : to;
  const toHash = Buffer.from(toClean.padEnd(64, "0").slice(0, 64), "hex");

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
server.tool("nano_deposit", "Deposit funds into CyberNanoPay (simulated for testnet)", {
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

// ── Start ──

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
