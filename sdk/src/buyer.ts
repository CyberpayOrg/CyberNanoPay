/**
 * NanoPay Buyer SDK
 *
 * For AI agents and buyers to:
 * 1. Deposit USDT into NanoPay
 * 2. Sign payment authorizations (offchain, zero gas)
 * 3. Pay for resources via x402
 */

import nacl from "tweetnacl";
import { randomBytes } from "crypto";
import { sha256_sync } from "@ton/crypto";
import { buildPaymentMessage } from "./message";

export interface BuyerConfig {
  /** Buyer's Ed25519 keypair */
  keypair: nacl.SignKeyPair;
  /** Buyer's TON address */
  address: string;
  /** Gateway API URL */
  gatewayUrl: string;
}

export class NanoPayBuyer {
  private config: BuyerConfig;

  constructor(config: BuyerConfig) {
    this.config = config;
  }

  /**
   * Sign a payment authorization (offchain, zero gas).
   */
  signAuthorization(params: {
    to: string;
    amount: bigint;
    validForSeconds?: number;
  }): {
    from: string;
    to: string;
    amount: string;
    validBefore: number;
    nonce: string;
    signature: string;
  } {
    const nonce = randomBytes(32).toString("hex");
    const validBefore =
      Math.floor(Date.now() / 1000) + (params.validForSeconds ?? 300);

    const message = buildPaymentMessage({
      from: this.config.address,
      to: params.to,
      amount: params.amount,
      validBefore,
      nonce,
    });

    const messageHash = sha256_sync(message);
    const sig = nacl.sign.detached(
      new Uint8Array(messageHash),
      this.config.keypair.secretKey
    );

    return {
      from: this.config.address,
      to: params.to,
      amount: params.amount.toString(),
      validBefore,
      nonce,
      signature: Buffer.from(sig).toString("hex"),
    };
  }

  /**
   * Pay for a 402-protected resource.
   * Handles the full x402 flow: request → 402 → sign → retry.
   */
  async payAndFetch(url: string, options?: RequestInit): Promise<Response> {
    // First request — expect 402
    const firstRes = await fetch(url, options);

    if (firstRes.status !== 402) {
      return firstRes; // No payment needed
    }

    // Parse payment requirements
    const paymentHeader = firstRes.headers.get("PAYMENT-REQUIRED");
    if (!paymentHeader) throw new Error("402 but no PAYMENT-REQUIRED header");

    const requirements = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString()
    );

    const accept = requirements.accepts?.find(
      (a: any) => a.scheme === "ton-nanopay"
    );
    if (!accept) throw new Error("No ton-nanopay scheme in 402 response");

    // Sign authorization
    const auth = this.signAuthorization({
      to: accept.to,
      amount: BigInt(accept.amount),
    });

    // Retry with payment
    const paymentPayload = {
      x402Version: 2,
      authorization: auth,
      accepted: accept,
    };

    const encoded = Buffer.from(JSON.stringify(paymentPayload)).toString(
      "base64"
    );

    return fetch(url, {
      ...options,
      headers: {
        ...((options?.headers as Record<string, string>) ?? {}),
        "Payment-Signature": encoded,
      },
    });
  }

  /**
   * Check available balance.
   */
  async getBalance(): Promise<{
    available: string;
    settled: string;
    unsettled: string;
    totalDeposited: string;
    totalSpent: string;
  }> {
    const res = await fetch(
      `${this.config.gatewayUrl}/balance/${this.config.address}`
    );
    return res.json() as Promise<{
      available: string;
      settled: string;
      unsettled: string;
      totalDeposited: string;
      totalSpent: string;
    }>;
  }

  /**
   * Get public key hex string.
   */
  getPublicKey(): string {
    return Buffer.from(this.config.keypair.publicKey).toString("hex");
  }

}
