import { createHash } from "crypto";
import { MerkleTree, buildPaymentLeaf, type MerkleProof } from "./merkle";

/** Helper: sha256 hex digest */
function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Helper: build N distinct leaf buffers */
function makeLeaves(n: number): Buffer[] {
  return Array.from({ length: n }, (_, i) => {
    const buf = Buffer.alloc(32);
    buf.writeUInt32BE(i, 0);
    return buf;
  });
}

describe("MerkleTree", () => {
  // ── 1. Single leaf ──
  it("single leaf: proof verifies", () => {
    const leaves = makeLeaves(1);
    const tree = new MerkleTree(leaves);

    expect(tree.leaves).toHaveLength(1);
    expect(tree.root).toBeDefined();

    const proof = tree.getProof(0);
    const leafHash = sha256(leaves[0]);
    expect(MerkleTree.verify(leafHash, proof)).toBe(true);
  });

  // ── 2. Two leaves ──
  it("two leaves: each proof verifies", () => {
    const leaves = makeLeaves(2);
    const tree = new MerkleTree(leaves);

    expect(tree.leaves).toHaveLength(2);

    for (let i = 0; i < 2; i++) {
      const proof = tree.getProof(i);
      const leafHash = sha256(leaves[i]);
      expect(MerkleTree.verify(leafHash, proof)).toBe(true);
    }
  });

  // ── 3. Power-of-2 leaves (4, 8) ──
  it.each([4, 8])("power-of-2 leaves (%i): all proofs verify", (n) => {
    const leaves = makeLeaves(n);
    const tree = new MerkleTree(leaves);

    expect(tree.leaves).toHaveLength(n);

    for (let i = 0; i < n; i++) {
      const proof = tree.getProof(i);
      const leafHash = sha256(leaves[i]);
      expect(MerkleTree.verify(leafHash, proof)).toBe(true);
    }
  });

  // ── 4. Non-power-of-2 leaves (3, 5) — padding works ──
  it.each([3, 5])(
    "non-power-of-2 leaves (%i): padding works, all proofs verify",
    (n) => {
      const leaves = makeLeaves(n);
      const tree = new MerkleTree(leaves);

      expect(tree.leaves).toHaveLength(n);

      // The first (bottom) layer should be padded to a power of 2
      const bottomLayer = tree.layers[0];
      expect(bottomLayer.length).toBeGreaterThanOrEqual(n);
      expect(bottomLayer.length & (bottomLayer.length - 1)).toBe(0); // power of 2

      for (let i = 0; i < n; i++) {
        const proof = tree.getProof(i);
        const leafHash = sha256(leaves[i]);
        expect(MerkleTree.verify(leafHash, proof)).toBe(true);
      }
    }
  );

  // ── 5. Tampered leaf hash fails verification ──
  it("tampered leaf hash fails verification", () => {
    const leaves = makeLeaves(4);
    const tree = new MerkleTree(leaves);

    const proof = tree.getProof(0);
    const wrongHash = sha256(Buffer.from("tampered-data"));
    expect(MerkleTree.verify(wrongHash, proof)).toBe(false);
  });

  // ── 6. Empty tree: root is hash of 32 zero bytes ──
  it("empty tree: root is hash of 32 zero bytes", () => {
    const tree = new MerkleTree([]);

    const expectedRoot = sha256(Buffer.alloc(32));
    expect(tree.root).toBe(expectedRoot);
    expect(tree.leaves).toHaveLength(0);
    expect(tree.layers).toEqual([[]]);
  });
});

describe("buildPaymentLeaf", () => {
  const payment = {
    confirmationId: "aabbccdd00112233aabbccdd00112233", // 32 hex chars = 16 bytes
    from: "EQA_sender_address_000000000000000000000000000000",
    to: "EQB_receiver_address_0000000000000000000000000000",
    amount: 1_000_000n,
    nonce: "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff", // 64 hex chars = 32 bytes
    confirmedAt: 1700000000,
  };

  // ── 7a. Deterministic output ──
  it("deterministic output", () => {
    const leaf1 = buildPaymentLeaf(payment);
    const leaf2 = buildPaymentLeaf(payment);
    expect(leaf1.equals(leaf2)).toBe(true);
  });

  // ── 7b. Correct length (200 bytes) ──
  it("correct length (200 bytes)", () => {
    const leaf = buildPaymentLeaf(payment);
    expect(leaf.length).toBe(200);
  });

  // ── 7c. Different payments produce different leaves ──
  it("different payments produce different leaves", () => {
    const leaf1 = buildPaymentLeaf(payment);
    const leaf2 = buildPaymentLeaf({ ...payment, amount: 2_000_000n });
    expect(leaf1.equals(leaf2)).toBe(false);
  });
});
