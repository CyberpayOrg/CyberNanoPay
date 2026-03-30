/**
 * Canonical message builder for NanoPay payment authorizations.
 *
 * This is the single source of truth for building the message bytes
 * that are signed by buyers and verified by the TEE.
 *
 * Message format:
 *   prefix:      "CyberGateway:v1:" (ASCII, 17 bytes)
 *   from:        32 bytes (TON address hash)
 *   to:          32 bytes (TON address hash)
 *   amount:      16 bytes (uint128 big-endian)
 *   validBefore: 8 bytes (uint64 big-endian)
 *   nonce:       32 bytes
 *
 * Total: 17 + 32 + 32 + 16 + 8 + 32 = 137 bytes
 */

import { Address } from "@ton/core";

const MESSAGE_PREFIX = Buffer.from("CyberGateway:v1:");

export interface PaymentFields {
  from: string;
  to: string;
  amount: bigint;
  validBefore: number;
  nonce: string;
}

/**
 * Build the canonical message bytes for a payment authorization.
 * Both buyer (signing) and TEE (verifying) must produce identical bytes.
 */
export function buildPaymentMessage(fields: PaymentFields): Buffer {
  const fromAddr = Address.parse(fields.from);
  const toAddr = Address.parse(fields.to);

  const buf = Buffer.alloc(MESSAGE_PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let offset = 0;

  // Prefix
  MESSAGE_PREFIX.copy(buf, offset);
  offset += MESSAGE_PREFIX.length;

  // From address (hash part, 32 bytes)
  fromAddr.hash.copy(buf, offset);
  offset += 32;

  // To address (hash part, 32 bytes)
  toAddr.hash.copy(buf, offset);
  offset += 32;

  // Amount (uint128 big-endian)
  const amountBuf = Buffer.alloc(16);
  let amt = fields.amount;
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }
  amountBuf.copy(buf, offset);
  offset += 16;

  // ValidBefore (uint64 big-endian)
  const timeBuf = Buffer.alloc(8);
  let ts = BigInt(fields.validBefore);
  for (let i = 7; i >= 0; i--) {
    timeBuf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  timeBuf.copy(buf, offset);
  offset += 8;

  // Nonce (32 bytes)
  Buffer.from(fields.nonce, "hex").copy(buf, offset);

  return buf;
}
