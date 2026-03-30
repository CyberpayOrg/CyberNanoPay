import nacl from "tweetnacl";
import {
  validateAuthorization,
  buildAuthMessage,
  verifyAuthorization,
  signAuthorization,
} from "./verifier";
import type { PaymentAuthorization } from "./types";

// ── Helpers ──

const FROM_ADDR = "EQABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAc3j";
const TO_ADDR = "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

function randomNonce(): string {
  const bytes = nacl.randomBytes(32);
  return Buffer.from(bytes).toString("hex");
}

function makeAuth(
  overrides: Partial<PaymentAuthorization> = {}
): PaymentAuthorization {
  return {
    from: FROM_ADDR,
    to: TO_ADDR,
    amount: 1000n,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: randomNonce(),
    signature: "a".repeat(128), // placeholder; overridden in signing tests
    ...overrides,
  };
}

// Generate a real Ed25519 keypair for the entire suite
const keypair = nacl.sign.keyPair();
const publicKeyHex = Buffer.from(keypair.publicKey).toString("hex");
const secretKeyBuf = Buffer.from(keypair.secretKey);

// A second keypair to test "wrong key" scenarios
const wrongKeypair = nacl.sign.keyPair();
const wrongPublicKeyHex = Buffer.from(wrongKeypair.publicKey).toString("hex");

// ── Tests ──

describe("verifier", () => {
  // ─── 1. Valid signature round-trip ───

  describe("sign then verify round-trip", () => {
    it("produces a valid signature that verifies successfully", () => {
      const auth = makeAuth();
      const { signature: _, ...unsigned } = auth;

      const sig = signAuthorization(unsigned, secretKeyBuf);
      expect(sig).toMatch(/^[0-9a-f]{128}$/);

      const signed: PaymentAuthorization = { ...unsigned, signature: sig };
      expect(verifyAuthorization(signed, publicKeyHex)).toBe(true);
    });

    it("works with minimum valid amount (1n)", () => {
      const auth = makeAuth({ amount: 1n });
      const { signature: _, ...unsigned } = auth;

      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };
      expect(verifyAuthorization(signed, publicKeyHex)).toBe(true);
    });

    it("works with very large amounts", () => {
      // Near uint128 max
      const auth = makeAuth({ amount: 2n ** 127n });
      const { signature: _, ...unsigned } = auth;

      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };
      expect(verifyAuthorization(signed, publicKeyHex)).toBe(true);
    });

    it("works with different nonces", () => {
      const nonce1 = randomNonce();
      const nonce2 = randomNonce();
      expect(nonce1).not.toBe(nonce2);

      const auth1 = makeAuth({ nonce: nonce1 });
      const auth2 = makeAuth({ nonce: nonce2 });

      const sig1 = signAuthorization(
        { from: auth1.from, to: auth1.to, amount: auth1.amount, validBefore: auth1.validBefore, nonce: auth1.nonce },
        secretKeyBuf
      );
      const sig2 = signAuthorization(
        { from: auth2.from, to: auth2.to, amount: auth2.amount, validBefore: auth2.validBefore, nonce: auth2.nonce },
        secretKeyBuf
      );

      // Different nonces produce different signatures
      expect(sig1).not.toBe(sig2);
    });
  });

  // ─── 2. Tampered fields detected ───

  describe("tampered fields are detected", () => {
    function signAndTamper(
      tamperFn: (auth: PaymentAuthorization) => PaymentAuthorization
    ): boolean {
      const auth = makeAuth();
      const { signature: _, ...unsigned } = auth;
      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };

      // Sanity: original verifies
      expect(verifyAuthorization(signed, publicKeyHex)).toBe(true);

      const tampered = tamperFn(signed);
      return verifyAuthorization(tampered, publicKeyHex);
    }

    it("detects tampered 'from' address", () => {
      expect(
        signAndTamper((auth) => ({ ...auth, from: TO_ADDR }))
      ).toBe(false);
    });

    it("detects tampered 'to' address", () => {
      expect(
        signAndTamper((auth) => ({ ...auth, to: FROM_ADDR }))
      ).toBe(false);
    });

    it("detects tampered amount (increased)", () => {
      expect(
        signAndTamper((auth) => ({ ...auth, amount: auth.amount + 1n }))
      ).toBe(false);
    });

    it("detects tampered amount (decreased)", () => {
      expect(
        signAndTamper((auth) => ({ ...auth, amount: auth.amount - 1n }))
      ).toBe(false);
    });

    it("detects tampered validBefore", () => {
      expect(
        signAndTamper((auth) => ({
          ...auth,
          validBefore: auth.validBefore + 1,
        }))
      ).toBe(false);
    });

    it("detects tampered nonce", () => {
      expect(
        signAndTamper((auth) => ({ ...auth, nonce: randomNonce() }))
      ).toBe(false);
    });
  });

  // ─── 3. Invalid signature rejected ───

  describe("invalid signatures are rejected", () => {
    it("rejects random 64-byte signature", () => {
      const auth = makeAuth({
        signature: Buffer.from(nacl.randomBytes(64)).toString("hex"),
      });
      expect(verifyAuthorization(auth, publicKeyHex)).toBe(false);
    });

    it("rejects all-zero signature", () => {
      const auth = makeAuth({
        signature: "0".repeat(128),
      });
      expect(verifyAuthorization(auth, publicKeyHex)).toBe(false);
    });

    it("rejects truncated signature (too short)", () => {
      const auth = makeAuth({
        signature: "ab".repeat(32), // 64 hex chars = 32 bytes, not 64
      });
      expect(verifyAuthorization(auth, publicKeyHex)).toBe(false);
    });

    it("rejects oversized signature (too long)", () => {
      const auth = makeAuth({
        signature: "ab".repeat(65), // 130 hex chars = 65 bytes
      });
      expect(verifyAuthorization(auth, publicKeyHex)).toBe(false);
    });
  });

  // ─── 4. Wrong public key rejected ───

  describe("wrong public key is rejected", () => {
    it("valid signature does not verify with a different key", () => {
      const auth = makeAuth();
      const { signature: _, ...unsigned } = auth;
      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };

      // Correct key works
      expect(verifyAuthorization(signed, publicKeyHex)).toBe(true);
      // Wrong key fails
      expect(verifyAuthorization(signed, wrongPublicKeyHex)).toBe(false);
    });

    it("rejects garbage public key hex", () => {
      const auth = makeAuth();
      const { signature: _, ...unsigned } = auth;
      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };

      expect(verifyAuthorization(signed, "not-hex")).toBe(false);
    });

    it("rejects truncated public key", () => {
      const auth = makeAuth();
      const { signature: _, ...unsigned } = auth;
      const sig = signAuthorization(unsigned, secretKeyBuf);
      const signed: PaymentAuthorization = { ...unsigned, signature: sig };

      // 16 bytes instead of 32
      expect(verifyAuthorization(signed, publicKeyHex.slice(0, 32))).toBe(
        false
      );
    });
  });

  // ─── 5. validateAuthorization ───

  describe("validateAuthorization", () => {
    it("accepts a valid authorization", () => {
      expect(() => validateAuthorization(makeAuth())).not.toThrow();
    });

    describe("rejects invalid amount", () => {
      it("throws for amount = 0n", () => {
        expect(() => validateAuthorization(makeAuth({ amount: 0n }))).toThrow(
          "amount must be > 0"
        );
      });

      it("throws for negative amount", () => {
        expect(() =>
          validateAuthorization(makeAuth({ amount: -1n }))
        ).toThrow("amount must be > 0");
      });

      it("throws for large negative amount", () => {
        expect(() =>
          validateAuthorization(makeAuth({ amount: -1000000n }))
        ).toThrow("amount must be > 0");
      });
    });

    describe("rejects invalid nonce format", () => {
      it("throws for empty nonce", () => {
        expect(() => validateAuthorization(makeAuth({ nonce: "" }))).toThrow(
          "nonce must be a 64-character hex string"
        );
      });

      it("throws for short nonce", () => {
        expect(() =>
          validateAuthorization(makeAuth({ nonce: "abcdef" }))
        ).toThrow("nonce must be a 64-character hex string");
      });

      it("throws for nonce with non-hex characters", () => {
        expect(() =>
          validateAuthorization(
            makeAuth({ nonce: "g".repeat(64) })
          )
        ).toThrow("nonce must be a 64-character hex string");
      });

      it("throws for 63-char nonce (one char short)", () => {
        expect(() =>
          validateAuthorization(makeAuth({ nonce: "a".repeat(63) }))
        ).toThrow("nonce must be a 64-character hex string");
      });

      it("throws for 65-char nonce (one char long)", () => {
        expect(() =>
          validateAuthorization(makeAuth({ nonce: "a".repeat(65) }))
        ).toThrow("nonce must be a 64-character hex string");
      });

      it("accepts uppercase hex nonce", () => {
        expect(() =>
          validateAuthorization(makeAuth({ nonce: "A".repeat(64) }))
        ).not.toThrow();
      });
    });

    describe("rejects invalid TON addresses", () => {
      it("throws for invalid 'from' address", () => {
        expect(() =>
          validateAuthorization(makeAuth({ from: "not-a-ton-address" }))
        ).toThrow("invalid 'from' TON address");
      });

      it("throws for empty 'from' address", () => {
        expect(() => validateAuthorization(makeAuth({ from: "" }))).toThrow(
          "invalid 'from' TON address"
        );
      });

      it("throws for invalid 'to' address", () => {
        expect(() =>
          validateAuthorization(makeAuth({ to: "not-a-ton-address" }))
        ).toThrow("invalid 'to' TON address");
      });

      it("throws for empty 'to' address", () => {
        expect(() => validateAuthorization(makeAuth({ to: "" }))).toThrow(
          "invalid 'to' TON address"
        );
      });
    });
  });

  // ─── 6. buildAuthMessage produces exactly 136 bytes ───
  // prefix (16) + from (32) + to (32) + amount (16) + validBefore (8) + nonce (32) = 136

  describe("buildAuthMessage", () => {
    it("produces exactly 136 bytes", () => {
      const auth = makeAuth();
      const msg = buildAuthMessage(auth);
      expect(msg.length).toBe(136);
    });

    it("starts with the ASCII prefix 'CyberGateway:v1:'", () => {
      const auth = makeAuth();
      const msg = buildAuthMessage(auth);
      const prefix = msg.subarray(0, 16).toString("ascii");
      expect(prefix).toBe("CyberGateway:v1:");
    });

    it("produces 136 bytes regardless of amount size", () => {
      const small = buildAuthMessage(makeAuth({ amount: 1n }));
      const large = buildAuthMessage(makeAuth({ amount: 2n ** 120n }));
      expect(small.length).toBe(136);
      expect(large.length).toBe(136);
    });

    it("throws for invalid inputs (delegates to validateAuthorization)", () => {
      expect(() => buildAuthMessage(makeAuth({ amount: 0n }))).toThrow(
        "amount must be > 0"
      );
    });
  });

  // ─── 7. Message determinism ───

  describe("message determinism", () => {
    it("same inputs always produce the same message bytes", () => {
      const nonce = randomNonce();
      const validBefore = 1700000000;

      const auth = makeAuth({ nonce, validBefore });

      const msg1 = buildAuthMessage(auth);
      const msg2 = buildAuthMessage(auth);
      const msg3 = buildAuthMessage(auth);

      expect(msg1.equals(msg2)).toBe(true);
      expect(msg2.equals(msg3)).toBe(true);
    });

    it("different amounts produce different messages", () => {
      const nonce = randomNonce();
      const validBefore = 1700000000;

      const msg1 = buildAuthMessage(makeAuth({ nonce, validBefore, amount: 100n }));
      const msg2 = buildAuthMessage(makeAuth({ nonce, validBefore, amount: 200n }));

      expect(msg1.equals(msg2)).toBe(false);
    });

    it("different nonces produce different messages", () => {
      const validBefore = 1700000000;

      const msg1 = buildAuthMessage(makeAuth({ nonce: "a".repeat(64), validBefore }));
      const msg2 = buildAuthMessage(makeAuth({ nonce: "b".repeat(64), validBefore }));

      expect(msg1.equals(msg2)).toBe(false);
    });

    it("different validBefore produces different messages", () => {
      const nonce = randomNonce();

      const msg1 = buildAuthMessage(makeAuth({ nonce, validBefore: 1000 }));
      const msg2 = buildAuthMessage(makeAuth({ nonce, validBefore: 2000 }));

      expect(msg1.equals(msg2)).toBe(false);
    });

    it("different from addresses produce different messages", () => {
      const nonce = randomNonce();
      const validBefore = 1700000000;

      const msg1 = buildAuthMessage(makeAuth({ from: FROM_ADDR, nonce, validBefore }));
      const msg2 = buildAuthMessage(makeAuth({ from: TO_ADDR, nonce, validBefore }));

      expect(msg1.equals(msg2)).toBe(false);
    });

    it("different to addresses produce different messages", () => {
      const nonce = randomNonce();
      const validBefore = 1700000000;

      const msg1 = buildAuthMessage(makeAuth({ to: FROM_ADDR, nonce, validBefore }));
      const msg2 = buildAuthMessage(makeAuth({ to: TO_ADDR, nonce, validBefore }));

      expect(msg1.equals(msg2)).toBe(false);
    });
  });
});
