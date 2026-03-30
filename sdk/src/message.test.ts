import { Address } from "@ton/core";
import { buildPaymentMessage, PaymentFields } from "./message";

/**
 * Replicate the TEE's buildAuthMessage logic exactly (from tee/src/verifier.ts).
 * This allows cross-validation without importing across package boundaries.
 */
function teeStyleBuildAuthMessage(fields: PaymentFields): Buffer {
  const PREFIX = Buffer.from("CyberGateway:v1:");
  const fromHash = Address.parse(fields.from).hash;
  const toHash = Address.parse(fields.to).hash;

  const buf = Buffer.alloc(PREFIX.length + 32 + 32 + 16 + 8 + 32);
  let off = 0;
  PREFIX.copy(buf, off);
  off += PREFIX.length;
  fromHash.copy(buf, off);
  off += 32;
  toHash.copy(buf, off);
  off += 32;

  // Amount uint128 BE
  let amt = fields.amount;
  const amtBuf = Buffer.alloc(16);
  for (let i = 15; i >= 0; i--) {
    amtBuf[i] = Number(amt & 0xffn);
    amt >>= 8n;
  }
  amtBuf.copy(buf, off);
  off += 16;

  // ValidBefore uint64 BE
  let ts = BigInt(fields.validBefore);
  const tsBuf = Buffer.alloc(8);
  for (let i = 7; i >= 0; i--) {
    tsBuf[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  tsBuf.copy(buf, off);
  off += 8;

  // Nonce
  Buffer.from(fields.nonce, "hex").copy(buf, off);

  return buf;
}

describe("buildPaymentMessage cross-validation with TEE verifier", () => {
  const FROM = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
  const TO = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

  it("SDK and TEE produce identical bytes for a standard payment", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 1000n,
      validBefore: 1700000000,
      nonce: "aa".repeat(32),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("produces identical bytes with zero amount", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 0n,
      validBefore: 1700000000,
      nonce: "00".repeat(32),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("produces identical bytes with large amount (uint128 boundary)", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: (1n << 64n) - 1n, // large but valid uint128
      validBefore: 2000000000,
      nonce: "ff".repeat(32),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("produces identical bytes with swapped from/to addresses", () => {
    const fields: PaymentFields = {
      from: TO,
      to: FROM,
      amount: 500000n,
      validBefore: 1600000000,
      nonce: "ab".repeat(32),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("produces identical bytes with typical USDT micro-payment", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 1000000n, // $1.00 in USDT (6 decimals)
      validBefore: 1750000000,
      nonce: "deadbeef".padEnd(64, "0"),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("produces identical bytes with max uint64 validBefore", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 42n,
      validBefore: Number.MAX_SAFE_INTEGER,
      nonce: "1234567890abcdef".repeat(4),
    };
    const sdk = buildPaymentMessage(fields);
    const tee = teeStyleBuildAuthMessage(fields);
    expect(sdk.equals(tee)).toBe(true);
  });

  it("message length is 136 bytes (16 prefix + 32 from + 32 to + 16 amt + 8 ts + 32 nonce)", () => {
    const fields: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 1000n,
      validBefore: 1700000000,
      nonce: "aa".repeat(32),
    };
    const msg = buildPaymentMessage(fields);
    expect(msg.length).toBe(136);
  });

  it("different amounts produce different messages", () => {
    const base: PaymentFields = {
      from: FROM,
      to: TO,
      amount: 1000n,
      validBefore: 1700000000,
      nonce: "aa".repeat(32),
    };
    const msg1 = buildPaymentMessage(base);
    const msg2 = buildPaymentMessage({ ...base, amount: 2000n });
    expect(msg1.equals(msg2)).toBe(false);
  });
});
