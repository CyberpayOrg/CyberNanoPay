import { createPaywall } from "./paywall";

const MERCHANT_ADDRESS =
  "EQACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAsoi";

const paywall = createPaywall({
  teeEndpoint: "http://localhost:4030",
  merchantAddress: MERCHANT_ADDRESS,
  pricePerCall: 1000n,
});

describe("createPaywall", () => {
  describe("paymentRequired", () => {
    it("has x402Version 2", () => {
      expect(paywall.paymentRequired.x402Version).toBe(2);
    });

    it("has an accepts array with one entry", () => {
      expect(Array.isArray(paywall.paymentRequired.accepts)).toBe(true);
      expect(paywall.paymentRequired.accepts).toHaveLength(1);
    });

    it("accepts entry has correct scheme, network, to, amount, asset", () => {
      const accept = paywall.paymentRequired.accepts[0];
      expect(accept.scheme).toBe("ton-nanopay");
      expect(accept.network).toBe("ton-testnet");
      expect(accept.to).toBe(MERCHANT_ADDRESS);
      expect(accept.amount).toBe("1000");
      expect(accept.asset).toBe("USDT");
    });
  });

  describe("paymentRequiredB64", () => {
    it("is valid base64 that decodes to the correct JSON", () => {
      const decoded = JSON.parse(
        Buffer.from(paywall.paymentRequiredB64, "base64").toString()
      );
      expect(decoded).toEqual(paywall.paymentRequired);
    });
  });

  describe("verify", () => {
    it("returns paid: false with 'No payment' when no header", async () => {
      const result = await paywall.verify({});
      expect(result.paid).toBe(false);
      expect(result.error).toBe("No payment");
    });

    it("returns paid: false when payment-signature is invalid base64", async () => {
      const result = await paywall.verify({
        "payment-signature": "invalid_base64!",
      });
      expect(result.paid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("middleware functions", () => {
    it("express is a function", () => {
      expect(typeof paywall.express).toBe("function");
    });

    it("hono is a function", () => {
      expect(typeof paywall.hono).toBe("function");
    });
  });
});
