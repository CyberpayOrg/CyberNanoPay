/**
 * Build Jetton Transfer TX — Vercel Serverless Function (Node.js runtime)
 *
 * Resolves the user's Jetton wallet via TonClient and builds a TEP-74
 * Jetton transfer cell for TonConnect to sign and send.
 *
 * POST /api/build-deposit-tx
 * Body: { "amount": "1000000", "address": "EQ..." }
 * Returns: { "to": "EQ...", "value": "150000000", "payload": "<base64 boc>" }
 */

const { TonClient } = require("@ton/ton");
const { Address, beginCell, toNano } = require("@ton/core");

const GATEWAY_ADDRESS = process.env.GATEWAY_ADDRESS || "";
const JETTON_MASTER = process.env.JETTON_MASTER || "";
const TON_RPC = process.env.TON_RPC || "https://toncenter.com/api/v2/jsonRPC";
const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Address",
};

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (req.method !== "POST") {
    res.writeHead(405, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  if (!GATEWAY_ADDRESS || !JETTON_MASTER) {
    res.writeHead(501, { ...CORS, "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        error: "On-chain deposit not configured (no GATEWAY_ADDRESS or JETTON_MASTER)",
      })
    );
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Invalid JSON body" }));
  }

  const { amount, address } = body || {};
  if (!amount || !address) {
    res.writeHead(400, { ...CORS, "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Missing amount or address" }));
  }

  // Resolve Jetton wallet address
  let userJettonWallet;
  try {
    const client = new TonClient({
      endpoint: TON_RPC,
      apiKey: TONCENTER_API_KEY || undefined,
    });
    const master = Address.parse(JETTON_MASTER);
    const userAddr = Address.parse(address);
    const result = await client.runMethod(master, "get_wallet_address", [
      { type: "slice", cell: beginCell().storeAddress(userAddr).endCell() },
    ]);
    userJettonWallet = result.stack.readAddress().toString();
  } catch (err) {
    res.writeHead(502, { ...CORS, "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({ error: `Failed to resolve Jetton wallet: ${err}` })
    );
  }

  // Build TEP-74 Jetton transfer cell
  const transferBody = beginCell()
    .storeUint(0x0f8a7ea5, 32) // op: jetton transfer
    .storeUint(0, 64) // query_id
    .storeCoins(BigInt(amount)) // amount (6 decimals for USDT)
    .storeAddress(Address.parse(GATEWAY_ADDRESS)) // destination
    .storeAddress(Address.parse(address)) // response_destination
    .storeBit(0) // no custom_payload
    .storeCoins(toNano("0.01")) // forward_ton_amount
    .storeBit(0) // forward_payload inline
    .endCell();

  res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      to: userJettonWallet,
      value: toNano("0.15").toString(), // TON for gas
      payload: transferBody.toBoc().toString("base64"),
    })
  );
};
