/**
 * Demo Merchant API — Simulates a paid AI API endpoint
 *
 * This is a separate service from the TEE, demonstrating how a
 * third-party merchant integrates CyberNanoPay paywall.
 *
 * Flow: Agent request → 402 → Agent signs payment → Agent retries with proof → Merchant verifies via TEE → 200
 */

const TEE_URL = "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network";
const MERCHANT_ADDRESS = "EQCywI9kxVeHirgdGg9dglbV5tcds-RPBfU2go2WQCMN3op9";
const PRICE_PER_CALL = "1000"; // $0.001 USDT

export const config = { runtime: "edge" };

export default async function handler(req) {
  // CORS
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Payment-Signature",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  // Check for payment header
  const paymentHeader = req.headers.get("Payment-Signature");

  if (!paymentHeader) {
    // Return 402 — Payment Required
    const requirements = {
      x402Version: 2,
      accepts: [{
        scheme: "ton-nanopay",
        network: "ton-testnet",
        to: MERCHANT_ADDRESS,
        amount: PRICE_PER_CALL,
        asset: "tUSDT",
      }],
    };

    return new Response(JSON.stringify({
      error: "Payment Required",
      ...requirements,
    }), {
      status: 402,
      headers: {
        ...corsHeaders,
        "PAYMENT-REQUIRED": btoa(JSON.stringify(requirements)),
      },
    });
  }

  // Verify payment via TEE
  try {
    const payload = JSON.parse(atob(paymentHeader));
    const auth = payload.authorization;

    if (!auth) {
      return new Response(JSON.stringify({ error: "Invalid payment payload" }), {
        status: 400, headers: corsHeaders,
      });
    }

    // Forward to TEE for verification
    const verifyRes = await fetch(`${TEE_URL}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from: auth.from,
        to: auth.to || MERCHANT_ADDRESS,
        amount: auth.amount || PRICE_PER_CALL,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
        signature: auth.signature,
      }),
    });

    const result = await verifyRes.json();

    if (!result.success) {
      return new Response(JSON.stringify({ error: result.error }), {
        status: 402, headers: corsHeaders,
      });
    }

    // Payment verified — return premium content
    return new Response(JSON.stringify({
      result: "AI analysis complete — 847 tokens generated",
      model: "gpt-4-turbo",
      tokens: 847,
      confirmationId: result.confirmationId,
      charged: "0.001 USDT",
      remaining: result.remainingBalance,
      merchant: "demo-ai-api.cyberpay.org",
    }), {
      status: 200, headers: corsHeaders,
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: corsHeaders,
    });
  }
}
