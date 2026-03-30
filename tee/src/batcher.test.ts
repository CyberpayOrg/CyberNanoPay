import { Batcher } from "./batcher";
import type { PaymentAuthorization } from "./types";

/** Helper: create a dummy PaymentAuthorization */
function makeAuth(
  from: string,
  to: string,
  amount: bigint
): PaymentAuthorization {
  return {
    from,
    to,
    amount,
    validBefore: Math.floor(Date.now() / 1000) + 3600,
    nonce: Math.random().toString(16).slice(2).padEnd(64, "0"),
    signature: "0".repeat(128),
  };
}

describe("Batcher", () => {
  let batcher: Batcher;

  beforeEach(() => {
    batcher = new Batcher();
  });

  // ── 1. Empty flush returns null ──

  test("flush returns null when no payments are pending", () => {
    expect(batcher.flush()).toBeNull();
  });

  test("flushVerified returns null when no payments are pending", () => {
    expect(batcher.flushVerified()).toBeNull();
  });

  // ── 2. Single payment produces correct batch ──

  test("single payment produces a batch with one position", () => {
    batcher.add(makeAuth("A", "B", 500n));
    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(1);
    expect(batch!.positions[0]).toEqual({ from: "A", to: "B", amount: 500n });
    expect(batch!.totalAmount).toBe(500n);
    expect(batch!.batchId).toBe(1n);
    expect(batch!.verified).toBe(false);
    expect(typeof batch!.createdAt).toBe("number");
  });

  // ── 3. Multiple A→B payments aggregate to one net position ──

  test("multiple payments between same pair aggregate into one net position", () => {
    batcher.add(makeAuth("A", "B", 300n));
    batcher.add(makeAuth("A", "B", 200n));
    batcher.add(makeAuth("A", "B", 100n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(1);
    expect(batch!.positions[0]).toEqual({ from: "A", to: "B", amount: 600n });
    expect(batch!.totalAmount).toBe(600n);
  });

  // ── 4. Bilateral netting: A→B + B→A → net difference only ──

  test("bilateral netting keeps only net difference (A→B wins)", () => {
    batcher.add(makeAuth("A", "B", 500n));
    batcher.add(makeAuth("B", "A", 300n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(1);
    expect(batch!.positions[0]).toEqual({ from: "A", to: "B", amount: 200n });
    expect(batch!.totalAmount).toBe(200n);
  });

  test("bilateral netting keeps only net difference (B→A wins)", () => {
    batcher.add(makeAuth("A", "B", 200n));
    batcher.add(makeAuth("B", "A", 700n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(1);
    expect(batch!.positions[0]).toEqual({ from: "B", to: "A", amount: 500n });
    expect(batch!.totalAmount).toBe(500n);
  });

  // ── 5. Bilateral netting: equal amounts cancel out → null batch ──

  test("bilateral netting with equal amounts cancels out and returns null", () => {
    batcher.add(makeAuth("A", "B", 1000n));
    batcher.add(makeAuth("B", "A", 1000n));

    const batch = batcher.flush();

    expect(batch).toBeNull();
  });

  // ── 6. Three-party payments with correct netting ──

  test("three-party payments produce correct net positions", () => {
    batcher.add(makeAuth("A", "B", 500n));
    batcher.add(makeAuth("B", "C", 300n));
    batcher.add(makeAuth("C", "A", 100n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(3);

    const posMap = new Map(
      batch!.positions.map((p) => [`${p.from}:${p.to}`, p.amount])
    );

    expect(posMap.get("A:B")).toBe(500n);
    expect(posMap.get("B:C")).toBe(300n);
    expect(posMap.get("C:A")).toBe(100n);
    expect(batch!.totalAmount).toBe(900n);
  });

  test("three-party payments with bilateral netting", () => {
    // A→B 500, B→A 200 → net A→B 300
    // B→C 400, C→B 400 → cancel out
    // C→A 100
    batcher.add(makeAuth("A", "B", 500n));
    batcher.add(makeAuth("B", "A", 200n));
    batcher.add(makeAuth("B", "C", 400n));
    batcher.add(makeAuth("C", "B", 400n));
    batcher.add(makeAuth("C", "A", 100n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();

    const posMap = new Map(
      batch!.positions.map((p) => [`${p.from}:${p.to}`, p.amount])
    );

    // A→B netted to 300
    expect(posMap.get("A:B")).toBe(300n);
    // B↔C cancel out — neither direction should appear
    expect(posMap.has("B:C")).toBe(false);
    expect(posMap.has("C:B")).toBe(false);
    // C→A remains
    expect(posMap.get("C:A")).toBe(100n);
    expect(batch!.positions).toHaveLength(2);
    expect(batch!.totalAmount).toBe(400n);
  });

  // ── 7. shouldFlush: triggers on count threshold ──

  test("shouldFlush returns true when pending count reaches threshold", () => {
    for (let i = 0; i < 10; i++) {
      batcher.add(makeAuth("A", "B", 1n));
    }

    expect(batcher.shouldFlush(10)).toBe(true);
    expect(batcher.shouldFlush(11)).toBe(false);
  });

  // ── 8. shouldFlush: triggers on age threshold ──

  test("shouldFlush returns true when oldest payment exceeds age threshold", () => {
    // Mock Date.now for the add call to set an old confirmedAt
    const originalNow = Date.now;
    const pastTime = originalNow() - 5000;

    Date.now = jest.fn(() => pastTime);
    batcher.add(makeAuth("A", "B", 1n));

    // Restore Date.now for the shouldFlush call (simulating time passing)
    Date.now = originalNow;

    // With maxAgeMs=3000, the 5 second old payment should trigger flush
    expect(batcher.shouldFlush(1000, 3000)).toBe(true);
    // With maxAgeMs=10000, it should not trigger
    expect(batcher.shouldFlush(1000, 10000)).toBe(false);
  });

  // ── 9. shouldFlush: false when empty or below thresholds ──

  test("shouldFlush returns false when no payments are pending", () => {
    expect(batcher.shouldFlush()).toBe(false);
  });

  test("shouldFlush returns false when below both thresholds", () => {
    batcher.add(makeAuth("A", "B", 1n));

    // Default thresholds: maxPending=1000, maxAgeMs=60000
    expect(batcher.shouldFlush()).toBe(false);
  });

  // ── 10. Verified payments separated from normal ──

  test("verified and normal payments are separated in flush", () => {
    batcher.add(makeAuth("A", "B", 100n), false);
    batcher.add(makeAuth("C", "D", 5000n), true);

    // First flush should return normal batch
    const normalBatch = batcher.flush();
    expect(normalBatch).not.toBeNull();
    expect(normalBatch!.verified).toBe(false);
    expect(normalBatch!.positions).toHaveLength(1);
    expect(normalBatch!.positions[0]).toEqual({
      from: "A",
      to: "B",
      amount: 100n,
    });

    // Verified payments should still be pending (put back by flush)
    expect(batcher.pendingCount).toBe(1);

    // Second flush should return verified batch
    const verifiedBatch = batcher.flush();
    expect(verifiedBatch).not.toBeNull();
    expect(verifiedBatch!.verified).toBe(true);
    expect(verifiedBatch!.positions).toHaveLength(1);
    expect(verifiedBatch!.positions[0]).toEqual({
      from: "C",
      to: "D",
      amount: 5000n,
    });
  });

  test("flush returns verified batch when no normal payments exist", () => {
    batcher.add(makeAuth("A", "B", 5000n), true);

    const batch = batcher.flush();
    expect(batch).not.toBeNull();
    expect(batch!.verified).toBe(true);
    expect(batch!.positions[0]).toEqual({ from: "A", to: "B", amount: 5000n });
  });

  // ── 11. flushVerified: only flushes verified payments ──

  test("flushVerified only returns verified payments and keeps normal ones", () => {
    batcher.add(makeAuth("A", "B", 100n), false);
    batcher.add(makeAuth("C", "D", 5000n), true);
    batcher.add(makeAuth("E", "F", 8000n), true);

    const verifiedBatch = batcher.flushVerified();

    expect(verifiedBatch).not.toBeNull();
    expect(verifiedBatch!.verified).toBe(true);
    expect(verifiedBatch!.positions).toHaveLength(2);

    const posMap = new Map(
      verifiedBatch!.positions.map((p) => [`${p.from}:${p.to}`, p.amount])
    );
    expect(posMap.get("C:D")).toBe(5000n);
    expect(posMap.get("E:F")).toBe(8000n);

    // Normal payment should remain pending
    expect(batcher.pendingCount).toBe(1);

    // Can still flush normal payment
    const normalBatch = batcher.flush();
    expect(normalBatch).not.toBeNull();
    expect(normalBatch!.verified).toBe(false);
    expect(normalBatch!.positions[0]).toEqual({
      from: "A",
      to: "B",
      amount: 100n,
    });
  });

  test("flushVerified returns null when only normal payments exist", () => {
    batcher.add(makeAuth("A", "B", 100n), false);
    expect(batcher.flushVerified()).toBeNull();
    // Normal payment should remain
    expect(batcher.pendingCount).toBe(1);
  });

  // ── 12. batchId increments correctly ──

  test("batchId increments across multiple flushes", () => {
    batcher.add(makeAuth("A", "B", 100n));
    const batch1 = batcher.flush();
    expect(batch1!.batchId).toBe(1n);

    batcher.add(makeAuth("C", "D", 200n));
    const batch2 = batcher.flush();
    expect(batch2!.batchId).toBe(2n);

    batcher.add(makeAuth("E", "F", 300n));
    const batch3 = batcher.flush();
    expect(batch3!.batchId).toBe(3n);
  });

  test("batchId increments across mixed flush and flushVerified", () => {
    batcher.add(makeAuth("A", "B", 100n), false);
    const batch1 = batcher.flush();
    expect(batch1!.batchId).toBe(1n);

    batcher.add(makeAuth("C", "D", 5000n), true);
    const batch2 = batcher.flushVerified();
    expect(batch2!.batchId).toBe(2n);

    batcher.add(makeAuth("E", "F", 200n), false);
    const batch3 = batcher.flush();
    expect(batch3!.batchId).toBe(3n);
  });

  test("null flushes do not increment batchId", () => {
    // Empty flush returns null — should not consume a batchId
    const nullBatch = batcher.flush();
    expect(nullBatch).toBeNull();

    batcher.add(makeAuth("A", "B", 100n));
    const batch1 = batcher.flush();
    expect(batch1!.batchId).toBe(1n);
  });

  // ── 13. Batch overflow: many net positions ──

  test("batch overflow: positions are capped at maxEntries", () => {
    // Create more unique pairs than the limit
    const maxEntries = 5;
    for (let i = 0; i < 10; i++) {
      batcher.add(makeAuth(`sender${i}`, `receiver${i}`, BigInt(100 + i)));
    }

    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
    const batch = batcher.flush(maxEntries);
    consoleSpy.mockRestore();

    expect(batch).not.toBeNull();
    expect(batch!.positions.length).toBeLessThanOrEqual(maxEntries);
    // totalAmount should reflect only the included positions
    const expectedTotal = batch!.positions.reduce(
      (sum, p) => sum + p.amount,
      0n
    );
    expect(batch!.totalAmount).toBe(expectedTotal);
  });

  test("batch overflow logs a warning", () => {
    const maxEntries = 3;
    for (let i = 0; i < 10; i++) {
      batcher.add(makeAuth(`s${i}`, `r${i}`, BigInt(100 + i)));
    }

    const consoleSpy = jest.spyOn(console, "warn").mockImplementation();
    batcher.flush(maxEntries);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Batch overflow")
    );
    consoleSpy.mockRestore();
  });

  // ── Additional edge cases ──

  test("pendingCount reflects current state", () => {
    expect(batcher.pendingCount).toBe(0);

    batcher.add(makeAuth("A", "B", 100n));
    expect(batcher.pendingCount).toBe(1);

    batcher.add(makeAuth("C", "D", 200n));
    expect(batcher.pendingCount).toBe(2);

    batcher.flush();
    expect(batcher.pendingCount).toBe(0);
  });

  test("flush clears all pending payments (normal-only case)", () => {
    batcher.add(makeAuth("A", "B", 100n));
    batcher.add(makeAuth("C", "D", 200n));
    batcher.flush();

    expect(batcher.pendingCount).toBe(0);
    expect(batcher.flush()).toBeNull();
  });

  test("amounts use bigint correctly for large values", () => {
    const largeAmount = 1_000_000_000_000n; // 1 trillion
    batcher.add(makeAuth("A", "B", largeAmount));
    batcher.add(makeAuth("A", "B", largeAmount));

    const batch = batcher.flush();
    expect(batch).not.toBeNull();
    expect(batch!.positions[0].amount).toBe(2_000_000_000_000n);
    expect(batch!.totalAmount).toBe(2_000_000_000_000n);
  });

  test("bilateral netting with multiple payments per direction", () => {
    // A→B: 100 + 200 + 300 = 600
    batcher.add(makeAuth("A", "B", 100n));
    batcher.add(makeAuth("A", "B", 200n));
    batcher.add(makeAuth("A", "B", 300n));
    // B→A: 150 + 250 = 400
    batcher.add(makeAuth("B", "A", 150n));
    batcher.add(makeAuth("B", "A", 250n));

    const batch = batcher.flush();

    expect(batch).not.toBeNull();
    expect(batch!.positions).toHaveLength(1);
    // Net: A→B 600 - B→A 400 = A→B 200
    expect(batch!.positions[0]).toEqual({ from: "A", to: "B", amount: 200n });
    expect(batch!.totalAmount).toBe(200n);
  });

  test("needsVerification defaults to false", () => {
    batcher.add(makeAuth("A", "B", 100n));

    // Should appear in normal flush, not verified
    const batch = batcher.flush();
    expect(batch).not.toBeNull();
    expect(batch!.verified).toBe(false);
  });
});
