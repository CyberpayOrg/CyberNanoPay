/**
 * CyberNanoPay Paywall Middleware
 *
 * Drop-in middleware for API merchants. Supports Express, Hono, and generic HTTP.
 *
 * Usage (Express):
 *   import { createPaywall } from "@cyberpay/nano-sdk";
 *   const paywall = createPaywall({ merchantAddress: "EQxxx...", pricePerCall: 1000 });
 *   app.use("/api", paywall.express());
 *
 * Usage (Hono):
 *   app.use("/api/*", paywall.hono());
 *
 * Usage (generic):
 *   const result = await paywall.verify(request.headers);
 */

export interface PaywallConfig {
  /** TEE endpoint URL */
  teeEndpoint: string;
  /** Merchant's TON address (receives payments) */
  merchantAddress: string;
  /** Price per API call in USDT units (6 decimals). 1000000 = $1, 1000 = $0.001 */
  pricePerCall: number;
  /** Optional: custom payment scheme name */
  scheme?: string;
}

export interface PaywallResult {
  paid: boolean;
  confirmationId?: string;
  receipt?: any;
  error?: string;
}

export function createPaywall(config: PaywallConfig) {
  const { teeEndpoint, merchantAddress, pricePerCall, scheme = "ton-nanopay" } = config;

  // Build 402 response body
  const paymentRequired = {
    x402Version: 2,
    accepts: [{
      scheme,
      network: "ton-testnet",
      to: merchantAddress,
      amount: pricePerCall.toString(),
      asset: "USDT",
    }],
  };
  const paymentRequiredB64 = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");

  /**
   * Verify a payment from request headers.
   * Returns { paid: true, confirmationId, receipt } or { paid: false, error }.
   */
  async function verify(headers: Record<string, string | undefined>): Promise<PaywallResult> {
    const paymentHeader = headers["payment-signature"] || headers["Payment-Signature"];
    if (!paymentHeader) {
      return { paid: false, error: "No payment" };
    }

    try {
      const payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString());
      const auth = payload.authorization;
      if (!auth) return { paid: false, error: "Invalid payment payload" };

      // Verify with TEE
      const res = await fetch(`${teeEndpoint}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: auth.from,
          to: merchantAddress,
          amount: pricePerCall.toString(),
          validBefore: auth.validBefore,
          nonce: auth.nonce,
          signature: auth.signature,
        }),
      });
      const result = await res.json() as any;

      if (result.success) {
        return { paid: true, confirmationId: result.confirmationId, receipt: result.receipt };
      }
      return { paid: false, error: result.error };
    } catch (err: any) {
      return { paid: false, error: err.message };
    }
  }

  /**
   * Express/Connect middleware.
   */
  function express() {
    return async (req: any, res: any, next: any) => {
      const result = await verify(req.headers);
      if (result.paid) {
        req.nanopay = result;
        return next();
      }
      res.status(402)
        .set("PAYMENT-REQUIRED", paymentRequiredB64)
        .json({ error: "Payment Required", ...paymentRequired });
    };
  }

  /**
   * Hono middleware.
   */
  function hono() {
    return async (c: any, next: any) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(c.req.header())) {
        if (typeof v === "string") headers[k.toLowerCase()] = v;
      }
      const result = await verify(headers);
      if (result.paid) {
        c.set("nanopay", result);
        return next();
      }
      c.header("PAYMENT-REQUIRED", paymentRequiredB64);
      return c.json({ error: "Payment Required", ...paymentRequired }, 402);
    };
  }

  return { verify, express, hono, paymentRequired, paymentRequiredB64 };
}
