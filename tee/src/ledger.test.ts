import { Ledger } from "./ledger";
import type { SpendingPolicy } from "./types";

const ADDR_A = "addr_A";
const ADDR_B = "addr_B";
const NONCE_1 = "a".repeat(64);
const NONCE_2 = "b".repeat(64);
const NONCE_3 = "c".repeat(64);
const NONCE_4 = "d".repeat(64);
const NONCE_5 = "e".repeat(64);
const NONCE_6 = "f".repeat(64);
const NONCE_7 = "1".repeat(64);
const NONCE_8 = "2".repeat(64);

let ledger: Ledger;

beforeEach(() => {
  ledger = new Ledger();
});

// ─────────────────────────────────────────────────────────
// 1. Deposit
// ─────────────────────────────────────────────────────────
describe("deposit", () => {
  it("credits a positive amount", () => {
    ledger.deposit(ADDR_A, 1000n);
    expect(ledger.getBalance(ADDR_A)).toBe(1000n);
  });

  it("rejects zero amount", () => {
    expect(() => ledger.deposit(ADDR_A, 0n)).toThrow("Deposit amount must be positive");
  });

  it("rejects negative amount", () => {
    expect(() => ledger.deposit(ADDR_A, -1n)).toThrow("Deposit amount must be positive");
  });

  it("accumulates multiple deposits", () => {
    ledger.deposit(ADDR_A, 500n);
    ledger.deposit(ADDR_A, 300n);
    expect(ledger.getBalance(ADDR_A)).toBe(800n);
  });

  it("tracks deposits per address independently", () => {
    ledger.deposit(ADDR_A, 100n);
    ledger.deposit(ADDR_B, 200n);
    expect(ledger.getBalance(ADDR_A)).toBe(100n);
    expect(ledger.getBalance(ADDR_B)).toBe(200n);
  });

  it("updates settled balance on deposit", () => {
    ledger.deposit(ADDR_A, 1000n);
    expect(ledger.getSettledBalance(ADDR_A)).toBe(1000n);
  });
});

// ─────────────────────────────────────────────────────────
// 2. tryDeduct — basic
// ─────────────────────────────────────────────────────────
describe("tryDeduct", () => {
  it("succeeds with sufficient balance", () => {
    ledger.deposit(ADDR_A, 1000n);
    const result = ledger.tryDeduct(ADDR_A, 400n, NONCE_1);
    expect(result).toEqual({ ok: true });
    expect(ledger.getBalance(ADDR_A)).toBe(600n);
  });

  it("fails with insufficient balance", () => {
    ledger.deposit(ADDR_A, 100n);
    const result = ledger.tryDeduct(ADDR_A, 200n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient balance/);
    expect(ledger.getBalance(ADDR_A)).toBe(100n);
  });

  it("fails when address has no deposits", () => {
    const result = ledger.tryDeduct(ADDR_A, 1n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient balance/);
  });

  it("deducts exact balance", () => {
    ledger.deposit(ADDR_A, 500n);
    const result = ledger.tryDeduct(ADDR_A, 500n, NONCE_1);
    expect(result.ok).toBe(true);
    expect(ledger.getBalance(ADDR_A)).toBe(0n);
  });

  it("records the nonce after successful deduction", () => {
    ledger.deposit(ADDR_A, 1000n);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(true);
  });

  it("does not record nonce on failure", () => {
    const result = ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────
// 3. Nonce replay protection
// ─────────────────────────────────────────────────────────
describe("nonce replay protection", () => {
  it("rejects a repeated nonce", () => {
    ledger.deposit(ADDR_A, 1000n);
    const first = ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    expect(first.ok).toBe(true);

    const second = ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/Nonce already used/);
    // Balance unchanged after replay attempt
    expect(ledger.getBalance(ADDR_A)).toBe(900n);
  });

  it("allows different nonces for same address", () => {
    ledger.deposit(ADDR_A, 1000n);
    expect(ledger.tryDeduct(ADDR_A, 100n, NONCE_1).ok).toBe(true);
    expect(ledger.tryDeduct(ADDR_A, 100n, NONCE_2).ok).toBe(true);
    expect(ledger.getBalance(ADDR_A)).toBe(800n);
  });

  it("nonce is global, not per-address", () => {
    ledger.deposit(ADDR_A, 1000n);
    ledger.deposit(ADDR_B, 1000n);
    expect(ledger.tryDeduct(ADDR_A, 100n, NONCE_1).ok).toBe(true);
    const replay = ledger.tryDeduct(ADDR_B, 100n, NONCE_1);
    expect(replay.ok).toBe(false);
    expect(replay.error).toMatch(/Nonce already used/);
  });
});

// ─────────────────────────────────────────────────────────
// 4. Policy — spending limit
// ─────────────────────────────────────────────────────────
describe("policy — spending limit", () => {
  beforeEach(() => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 500n,
      dailyCap: 0n,
      hitlThreshold: 0n,
    });
  });

  it("allows payment within limit", () => {
    const result = ledger.tryDeduct(ADDR_A, 500n, NONCE_1);
    expect(result.ok).toBe(true);
  });

  it("rejects payment above limit", () => {
    const result = ledger.tryDeduct(ADDR_A, 501n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Exceeds spending limit/);
    expect(ledger.getBalance(ADDR_A)).toBe(10_000n);
  });

  it("spendingLimit of 0 means unlimited", () => {
    ledger.setPolicy(ADDR_A, { spendingLimit: 0n, dailyCap: 0n, hitlThreshold: 0n });
    const result = ledger.tryDeduct(ADDR_A, 9_999n, NONCE_1);
    expect(result.ok).toBe(true);
  });

  it("returns policy via getPolicy", () => {
    const policy = ledger.getPolicy(ADDR_A);
    expect(policy).toEqual({ spendingLimit: 500n, dailyCap: 0n, hitlThreshold: 0n });
  });

  it("returns undefined for address without policy", () => {
    expect(ledger.getPolicy(ADDR_B)).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────
// 5. Policy — daily cap
// ─────────────────────────────────────────────────────────
describe("policy — daily cap", () => {
  beforeEach(() => {
    ledger.deposit(ADDR_A, 100_000n);
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 0n,
      dailyCap: 1000n,
      hitlThreshold: 0n,
    });
  });

  it("allows payments within daily cap", () => {
    expect(ledger.tryDeduct(ADDR_A, 600n, NONCE_1).ok).toBe(true);
    expect(ledger.tryDeduct(ADDR_A, 400n, NONCE_2).ok).toBe(true);
  });

  it("rejects payment that would exceed daily cap", () => {
    expect(ledger.tryDeduct(ADDR_A, 600n, NONCE_1).ok).toBe(true);
    const result = ledger.tryDeduct(ADDR_A, 401n, NONCE_2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Exceeds daily cap/);
  });

  it("tracks daily spent amount", () => {
    ledger.tryDeduct(ADDR_A, 300n, NONCE_1);
    expect(ledger.getDailySpent(ADDR_A)).toBe(300n);
  });

  it("resets daily spent after 24h", () => {
    ledger.tryDeduct(ADDR_A, 800n, NONCE_1);
    expect(ledger.getDailySpent(ADDR_A)).toBe(800n);

    // Advance time past the 24h reset
    const realDateNow = Date.now;
    Date.now = () => realDateNow() + 86_400 * 1000 + 1000;
    try {
      expect(ledger.getDailySpent(ADDR_A)).toBe(0n);
      // Should be able to spend again
      const result = ledger.tryDeduct(ADDR_A, 800n, NONCE_2);
      expect(result.ok).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ─────────────────────────────────────────────────────────
// 6. Policy — HITL threshold
// ─────────────────────────────────────────────────────────
describe("policy — HITL threshold", () => {
  beforeEach(() => {
    ledger.deposit(ADDR_A, 100_000n);
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 0n,
      dailyCap: 0n,
      hitlThreshold: 5000n,
    });
  });

  it("returns needsApproval for amount at threshold", () => {
    const result = ledger.tryDeduct(ADDR_A, 5000n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.needsApproval).toBe(true);
    expect(result.error).toMatch(/Requires human approval/);
  });

  it("returns needsApproval for amount above threshold", () => {
    const result = ledger.tryDeduct(ADDR_A, 10_000n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.needsApproval).toBe(true);
  });

  it("allows amount below threshold without approval", () => {
    const result = ledger.tryDeduct(ADDR_A, 4999n, NONCE_1);
    expect(result.ok).toBe(true);
    expect(result.needsApproval).toBeUndefined();
  });

  it("does not deduct balance when HITL triggers", () => {
    ledger.tryDeduct(ADDR_A, 5000n, NONCE_1);
    expect(ledger.getBalance(ADDR_A)).toBe(100_000n);
  });

  it("does not consume nonce when HITL triggers", () => {
    ledger.tryDeduct(ADDR_A, 5000n, NONCE_1);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(false);
  });

  it("does not count toward daily cap when HITL triggers", () => {
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 0n,
      dailyCap: 10_000n,
      hitlThreshold: 5000n,
    });
    const result = ledger.tryDeduct(ADDR_A, 5000n, NONCE_1);
    expect(result.needsApproval).toBe(true);
    expect(ledger.getDailySpent(ADDR_A)).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────
// 7. forceDeduct
// ─────────────────────────────────────────────────────────
describe("forceDeduct", () => {
  beforeEach(() => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 100n,
      dailyCap: 500n,
      hitlThreshold: 50n,
    });
  });

  it("bypasses spending limit", () => {
    const result = ledger.forceDeduct(ADDR_A, 5000n, NONCE_1);
    expect(result.ok).toBe(true);
    expect(ledger.getBalance(ADDR_A)).toBe(5000n);
  });

  it("bypasses HITL threshold", () => {
    const result = ledger.forceDeduct(ADDR_A, 1000n, NONCE_1);
    expect(result.ok).toBe(true);
  });

  it("still checks balance", () => {
    const result = ledger.forceDeduct(ADDR_A, 20_000n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Insufficient balance/);
  });

  it("still checks nonce replay", () => {
    ledger.forceDeduct(ADDR_A, 100n, NONCE_1);
    const result = ledger.forceDeduct(ADDR_A, 100n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Nonce already used/);
  });

  it("nonce from tryDeduct blocks forceDeduct", () => {
    // Remove policy so tryDeduct succeeds
    ledger.setPolicy(ADDR_A, { spendingLimit: 0n, dailyCap: 0n, hitlThreshold: 0n });
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    const result = ledger.forceDeduct(ADDR_A, 100n, NONCE_1);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Nonce already used/);
  });
});

// ─────────────────────────────────────────────────────────
// 8. Daily tracker — forceDeduct counts toward daily cap
// ─────────────────────────────────────────────────────────
describe("daily tracker with forceDeduct", () => {
  it("forceDeduct counts toward daily spending", () => {
    ledger.deposit(ADDR_A, 100_000n);
    ledger.setPolicy(ADDR_A, {
      spendingLimit: 0n,
      dailyCap: 1000n,
      hitlThreshold: 0n,
    });

    // Force-deduct 800 (bypasses policy but counts toward daily)
    ledger.forceDeduct(ADDR_A, 800n, NONCE_1);
    expect(ledger.getDailySpent(ADDR_A)).toBe(800n);

    // Now a normal tryDeduct of 201 should exceed the 1000 daily cap
    const result = ledger.tryDeduct(ADDR_A, 201n, NONCE_2);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Exceeds daily cap/);
  });
});

// ─────────────────────────────────────────────────────────
// 9. creditSettlement
// ─────────────────────────────────────────────────────────
describe("creditSettlement", () => {
  it("credits balance to receiver", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 5000n, NONCE_1);
    ledger.creditSettlement(ADDR_A, ADDR_B, 5000n);
    expect(ledger.getBalance(ADDR_B)).toBe(5000n);
  });

  it("accumulates multiple settlements", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 1000n, NONCE_1);
    ledger.tryDeduct(ADDR_A, 2000n, NONCE_2);
    ledger.creditSettlement(ADDR_A, ADDR_B, 1000n);
    ledger.creditSettlement(ADDR_A, ADDR_B, 2000n);
    expect(ledger.getBalance(ADDR_B)).toBe(3000n);
  });

  it("updates settled balance", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 3000n, NONCE_1);
    ledger.creditSettlement(ADDR_A, ADDR_B, 3000n);
    expect(ledger.getSettledBalance(ADDR_B)).toBe(3000n);
  });

  it("credits to an address that already has deposit balance", () => {
    ledger.deposit(ADDR_A, 1000n);
    ledger.deposit(ADDR_B, 500n);
    ledger.tryDeduct(ADDR_B, 500n, NONCE_1);
    ledger.creditSettlement(ADDR_B, ADDR_A, 500n);
    expect(ledger.getBalance(ADDR_A)).toBe(1500n);
    expect(ledger.getSettledBalance(ADDR_A)).toBe(1500n);
  });

  it("reduces sender's pendingOutgoing", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 3000n, NONCE_1);
    expect(ledger.getSnapshot(ADDR_A).pendingOutgoing).toBe(3000n);

    ledger.creditSettlement(ADDR_A, ADDR_B, 3000n);
    expect(ledger.getSnapshot(ADDR_A).pendingOutgoing).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────
// 10. lockForWithdrawal / unlockWithdrawal
// ─────────────────────────────────────────────────────────
describe("lockForWithdrawal / unlockWithdrawal", () => {
  it("locks funds by reducing available balance", () => {
    ledger.deposit(ADDR_A, 1000n);
    const locked = ledger.lockForWithdrawal(ADDR_A, 600n);
    expect(locked).toBe(true);
    expect(ledger.getBalance(ADDR_A)).toBe(400n);
  });

  it("returns false when insufficient balance", () => {
    ledger.deposit(ADDR_A, 100n);
    const locked = ledger.lockForWithdrawal(ADDR_A, 200n);
    expect(locked).toBe(false);
    expect(ledger.getBalance(ADDR_A)).toBe(100n);
  });

  it("returns false for unknown address", () => {
    const locked = ledger.lockForWithdrawal(ADDR_A, 1n);
    expect(locked).toBe(false);
  });

  it("unlocks funds by restoring available balance", () => {
    ledger.deposit(ADDR_A, 1000n);
    ledger.lockForWithdrawal(ADDR_A, 600n);
    ledger.unlockWithdrawal(ADDR_A, 600n);
    expect(ledger.getBalance(ADDR_A)).toBe(1000n);
  });

  it("can lock exact balance", () => {
    ledger.deposit(ADDR_A, 500n);
    const locked = ledger.lockForWithdrawal(ADDR_A, 500n);
    expect(locked).toBe(true);
    expect(ledger.getBalance(ADDR_A)).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────
// 11. Serialization round-trip
// ─────────────────────────────────────────────────────────
describe("serialize / restore", () => {
  it("round-trips all balance state", () => {
    ledger.deposit(ADDR_A, 5000n);
    ledger.deposit(ADDR_B, 3000n);
    ledger.tryDeduct(ADDR_A, 1000n, NONCE_1);
    ledger.creditSettlement(ADDR_A, ADDR_B, 500n);

    const snapshot = ledger.serialize();

    const restored = new Ledger();
    restored.restore(snapshot);

    expect(restored.getBalance(ADDR_A)).toBe(4000n);
    expect(restored.getBalance(ADDR_B)).toBe(3500n);
    expect(restored.getSettledBalance(ADDR_A)).toBe(5000n);
    expect(restored.getSettledBalance(ADDR_B)).toBe(3500n);
    expect(restored.totalDeposits).toBe(8000n);
    expect(restored.totalDeducted).toBe(1000n);
  });

  it("preserves per-address totalDeposited and totalSpent in snapshot", () => {
    ledger.deposit(ADDR_A, 2000n);
    ledger.tryDeduct(ADDR_A, 300n, NONCE_1);

    const snapshot = ledger.serialize();
    const entry = snapshot.find((e) => e.address === ADDR_A)!;
    expect(entry.totalDeposited).toBe("2000");
    expect(entry.totalSpent).toBe("300");
    expect(entry.balance).toBe("1700");
  });

  it("restore clears previous state", () => {
    ledger.deposit(ADDR_A, 9999n);

    const fresh = new Ledger();
    fresh.deposit(ADDR_B, 100n);
    const snap = fresh.serialize();

    ledger.restore(snap);
    expect(ledger.getBalance(ADDR_A)).toBe(0n);
    expect(ledger.getBalance(ADDR_B)).toBe(100n);
    expect(ledger.accountCount).toBe(1);
  });

  it("handles empty snapshot", () => {
    ledger.deposit(ADDR_A, 500n);
    ledger.restore([]);
    expect(ledger.getBalance(ADDR_A)).toBe(0n);
    expect(ledger.totalDeposits).toBe(0n);
    expect(ledger.accountCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// 12. pruneNonces
// ─────────────────────────────────────────────────────────
describe("pruneNonces", () => {
  it("removes expired nonces", () => {
    ledger.deposit(ADDR_A, 10_000n);
    const pastTimestamp = Math.floor(Date.now() / 1000) - 1000;
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1, pastTimestamp);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(true);

    const pruned = ledger.pruneNonces(0);
    expect(pruned).toBe(1);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(false);
    expect(ledger.nonceCount).toBe(0);
  });

  it("keeps recent nonces", () => {
    ledger.deposit(ADDR_A, 10_000n);
    const futureTimestamp = Math.floor(Date.now() / 1000) + 3600;
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1, futureTimestamp);

    const pruned = ledger.pruneNonces(0);
    expect(pruned).toBe(0);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(true);
  });

  it("respects grace period", () => {
    ledger.deposit(ADDR_A, 10_000n);
    // Expired 100 seconds ago
    const expiredTs = Math.floor(Date.now() / 1000) - 100;
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1, expiredTs);

    // Grace period of 200s: expiry + 200 > now, so should NOT be pruned
    expect(ledger.pruneNonces(200)).toBe(0);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(true);

    // Grace period of 50s: expiry + 50 < now, so should be pruned
    expect(ledger.pruneNonces(50)).toBe(1);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(false);
  });

  it("uses default grace period of 300 seconds", () => {
    ledger.deposit(ADDR_A, 10_000n);
    // Expired 200 seconds ago — within default grace of 300
    const expiredTs = Math.floor(Date.now() / 1000) - 200;
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1, expiredTs);

    const pruned = ledger.pruneNonces();
    expect(pruned).toBe(0);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(true);
  });

  it("prunes selectively — removes only expired nonces", () => {
    ledger.deposit(ADDR_A, 10_000n);
    const pastTs = Math.floor(Date.now() / 1000) - 1000;
    const futureTs = Math.floor(Date.now() / 1000) + 3600;

    ledger.tryDeduct(ADDR_A, 100n, NONCE_1, pastTs);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_2, futureTs);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_3, pastTs);

    const pruned = ledger.pruneNonces(0);
    expect(pruned).toBe(2);
    expect(ledger.isNonceUsed(NONCE_1)).toBe(false);
    expect(ledger.isNonceUsed(NONCE_2)).toBe(true);
    expect(ledger.isNonceUsed(NONCE_3)).toBe(false);
    expect(ledger.nonceCount).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────
// 13. Global stats
// ─────────────────────────────────────────────────────────
describe("global stats", () => {
  it("totalDeposits tracks all deposits", () => {
    ledger.deposit(ADDR_A, 1000n);
    ledger.deposit(ADDR_B, 2000n);
    ledger.deposit(ADDR_A, 500n);
    expect(ledger.totalDeposits).toBe(3500n);
  });

  it("totalDeducted tracks all deductions", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    ledger.tryDeduct(ADDR_A, 200n, NONCE_2);
    expect(ledger.totalDeducted).toBe(300n);
  });

  it("totalDeducted includes forceDeduct", () => {
    ledger.deposit(ADDR_A, 10_000n);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    ledger.forceDeduct(ADDR_A, 500n, NONCE_2);
    expect(ledger.totalDeducted).toBe(600n);
  });

  it("totalDeducted does not count failed deductions", () => {
    ledger.deposit(ADDR_A, 100n);
    ledger.tryDeduct(ADDR_A, 200n, NONCE_1); // fails
    expect(ledger.totalDeducted).toBe(0n);
  });

  it("accountCount reflects unique deposited addresses", () => {
    expect(ledger.accountCount).toBe(0);
    ledger.deposit(ADDR_A, 100n);
    expect(ledger.accountCount).toBe(1);
    ledger.deposit(ADDR_B, 200n);
    expect(ledger.accountCount).toBe(2);
    ledger.deposit(ADDR_A, 50n);
    expect(ledger.accountCount).toBe(2);
  });

  it("nonceCount tracks used nonces", () => {
    ledger.deposit(ADDR_A, 10_000n);
    expect(ledger.nonceCount).toBe(0);
    ledger.tryDeduct(ADDR_A, 100n, NONCE_1);
    expect(ledger.nonceCount).toBe(1);
    ledger.forceDeduct(ADDR_A, 100n, NONCE_2);
    expect(ledger.nonceCount).toBe(2);
  });

  it("starts at zero", () => {
    expect(ledger.totalDeposits).toBe(0n);
    expect(ledger.totalDeducted).toBe(0n);
    expect(ledger.accountCount).toBe(0);
    expect(ledger.nonceCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────
// Snapshot query
// ─────────────────────────────────────────────────────────
describe("getSnapshot", () => {
  it("returns full snapshot for an address", () => {
    ledger.deposit(ADDR_A, 5000n);
    ledger.tryDeduct(ADDR_A, 1200n, NONCE_1);

    const snap = ledger.getSnapshot(ADDR_A);
    expect(snap.address).toBe(ADDR_A);
    expect(snap.available).toBe(3800n);
    expect(snap.totalDeposited).toBe(5000n);
    expect(snap.totalSpent).toBe(1200n);
  });

  it("returns zeroes for unknown address", () => {
    const snap = ledger.getSnapshot("unknown");
    expect(snap.available).toBe(0n);
    expect(snap.totalDeposited).toBe(0n);
    expect(snap.totalSpent).toBe(0n);
  });
});

// ─────────────────────────────────────────────────────────
// Edge: getBalance for unknown address
// ─────────────────────────────────────────────────────────
describe("edge cases", () => {
  it("getBalance returns 0n for unknown address", () => {
    expect(ledger.getBalance("nonexistent")).toBe(0n);
  });

  it("getSettledBalance returns 0n for unknown address", () => {
    expect(ledger.getSettledBalance("nonexistent")).toBe(0n);
  });

  it("getDailySpent returns 0n for address without tracker", () => {
    expect(ledger.getDailySpent(ADDR_A)).toBe(0n);
  });

  it("isNonceUsed returns false for unknown nonce", () => {
    expect(ledger.isNonceUsed("unknown_nonce")).toBe(false);
  });
});
