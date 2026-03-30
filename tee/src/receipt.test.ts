import nacl from "tweetnacl";
import { createHash } from "crypto";
import {
  ReceiptBuilder,
  verifyStandardReceipt,
  type StandardReceipt,
  type ReceiptBuilderConfig,
} from "./receipt";
import { MerkleTree, buildPaymentLeaf } from "./merkle";

/** Generate a real Ed25519 keypair for testing */
function makeTeeConfig(): ReceiptBuilderConfig {
  const kp = nacl.sign.keyPair();
  return {
    teeSecretKey: kp.secretKey,
    teePubkey: Buffer.from(kp.publicKey).toString("hex"),
    teePlatform: "test-tdx",
    teeCodeHash: "deadbeef".repeat(8), // 64 hex chars
  };
}

/** Dummy payment for testing */
function makePayment(overrides: Record<string, unknown> = {}) {
  return {
    confirmationId: "aabbccdd00112233aabbccdd00112233",
    from: "EQA_sender_address_000000000000000000000000000000",
    to: "EQB_receiver_address_0000000000000000000000000000",
    amount: 500_000n,
    nonce: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
    confirmedAt: 1700000000,
    remainingBalance: 9_500_000n,
    ...overrides,
  };
}

describe("ReceiptBuilder", () => {
  let config: ReceiptBuilderConfig;
  let builder: ReceiptBuilder;

  beforeEach(() => {
    config = makeTeeConfig();
    builder = new ReceiptBuilder(config);
  });

  // ── 1. Build receipt: correct version, header, payload fields ──
  it("build receipt: has correct version, header, and payload fields", () => {
    const payment = makePayment();
    const receipt = builder.buildReceipt(payment);

    // Version
    expect(receipt.version).toBe("NanoPay:receipt:v2");

    // Header
    expect(receipt.protected.alg).toBe("EdDSA");
    expect(receipt.protected.teePlatform).toBe("test-tdx");
    expect(receipt.protected.teeCodeHash).toBe("deadbeef".repeat(8));
    expect(receipt.protected.teePubkey).toBe(config.teePubkey);
    expect(receipt.protected.contentType).toBe(
      "application/cyberpay-receipt+json"
    );

    // Payload
    expect(receipt.payload.confirmationId).toBe(payment.confirmationId);
    expect(receipt.payload.from).toBe(payment.from);
    expect(receipt.payload.to).toBe(payment.to);
    expect(receipt.payload.amount).toBe(payment.amount.toString());
    expect(receipt.payload.nonce).toBe(payment.nonce);
    expect(receipt.payload.confirmedAt).toBe(payment.confirmedAt);
    expect(receipt.payload.remainingBalance).toBe(
      payment.remainingBalance.toString()
    );
    expect(receipt.payload.batchId).toBeNull();
    expect(receipt.payload.merkleProof).toBeNull();

    // Signature present
    expect(receipt.signature).toHaveLength(128); // 64 bytes = 128 hex chars
  });

  // ── 2. Signature verification round-trip ──
  it("signature verification round-trip: build then verify succeeds", () => {
    const receipt = builder.buildReceipt(makePayment());
    const result = verifyStandardReceipt(receipt);

    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  // ── 3. Tampered payload: verification fails ──
  it("tampered payload: verification fails", () => {
    const receipt = builder.buildReceipt(makePayment());

    // Tamper with the amount
    const tampered: StandardReceipt = {
      ...receipt,
      payload: { ...receipt.payload, amount: "999999999" },
    };

    const result = verifyStandardReceipt(tampered);
    expect(result.valid).toBe(false);
  });

  // ── 4. Tampered signature: verification fails ──
  it("tampered signature: verification fails", () => {
    const receipt = builder.buildReceipt(makePayment());

    // Flip a byte in the signature
    const sigBytes = Buffer.from(receipt.signature, "hex");
    sigBytes[0] ^= 0xff;
    const tampered: StandardReceipt = {
      ...receipt,
      signature: sigBytes.toString("hex"),
    };

    const result = verifyStandardReceipt(tampered);
    expect(result.valid).toBe(false);
  });

  // ── 5. Wrong TEE pubkey: verification fails ──
  it("wrong TEE pubkey: verification fails", () => {
    const receipt = builder.buildReceipt(makePayment());

    // Use a different keypair's public key
    const wrongKp = nacl.sign.keyPair();
    const wrongPubkey = Buffer.from(wrongKp.publicKey).toString("hex");

    const result = verifyStandardReceipt(receipt, wrongPubkey);
    expect(result.valid).toBe(false);
  });

  // ── 6. attachMerkleProofs: adds batchId and merkleProof, re-signs, still verifies ──
  it("attachMerkleProofs: adds batchId and merkleProof, re-signs, still verifies", () => {
    const payments = [
      makePayment({ confirmationId: "aa".repeat(16) }),
      makePayment({
        confirmationId: "bb".repeat(16),
        amount: 300_000n,
        nonce: "ff".repeat(32),
      }),
      makePayment({
        confirmationId: "cc".repeat(16),
        amount: 200_000n,
        nonce: "ee".repeat(32),
      }),
    ];

    const receipts = payments.map((p) => builder.buildReceipt(p));
    const batchId = 42n;
    const updated = builder.attachMerkleProofs(receipts, batchId);

    expect(updated).toHaveLength(3);

    for (const r of updated) {
      // batchId attached
      expect(r.payload.batchId).toBe("42");

      // Merkle proof attached
      expect(r.payload.merkleProof).not.toBeNull();
      expect(r.payload.merkleProof!.root).toBeDefined();
      expect(r.payload.merkleProof!.path.length).toBeGreaterThan(0);

      // Re-signed receipt still verifies
      const result = verifyStandardReceipt(r);
      expect(result.valid).toBe(true);
      expect(result.merkleValid).toBe(true);
    }

    // All share the same Merkle root
    const roots = updated.map((r) => r.payload.merkleProof!.root);
    expect(new Set(roots).size).toBe(1);
  });

  // ── 7. Merkle proof in receipt verifies independently ──
  it("Merkle proof in receipt verifies independently via MerkleTree.verify", () => {
    const payment = makePayment();
    const receipt = builder.buildReceipt(payment);
    const [withProof] = builder.attachMerkleProofs([receipt], 1n);

    // Rebuild the leaf hash independently
    const leaf = buildPaymentLeaf({
      confirmationId: withProof.payload.confirmationId,
      from: withProof.payload.from,
      to: withProof.payload.to,
      amount: BigInt(withProof.payload.amount),
      nonce: withProof.payload.nonce,
      confirmedAt: withProof.payload.confirmedAt,
    });
    const leafHash = createHash("sha256").update(leaf).digest("hex");

    // Verify against the Merkle proof extracted from the receipt
    const proof = withProof.payload.merkleProof!;
    expect(MerkleTree.verify(leafHash, proof)).toBe(true);
  });
});
