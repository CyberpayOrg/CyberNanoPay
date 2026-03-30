# NanoPay — Gas-Free Nanopayment Infrastructure for AI Agents on TON

Sub-cent USDT micropayments for AI agents. Zero gas per payment. x402-compatible. TEE-secured. Telegram-native.

## Demo

> 📺 [Live Demo](https://nano.cyberpay.org) · [Contract on TON Explorer](https://testnet.tonviewer.com/EQCywI9kxVeHirgdGg9dglbV5tcds-RPBfU2go2WQCMN3op9) · [TEE Attestation](https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network/attestation)

## The Problem

AI agents need to pay for API calls, compute, data, and services — often thousands of times per day at sub-cent amounts.

| Payment Method | Cost per $0.001 payment | Viable? |
|---|---|---|
| Credit Card (Stripe) | $0.30 fixed fee | ❌ 300x the payment |
| TON on-chain | ~$0.01 gas | ❌ 10x the payment |
| NanoPay | ~$0.00002 (batched) | ✅ 50x cheaper |

Traditional payment rails charge $0.30/tx minimum. On-chain transactions cost gas per tx. Neither works for micropayments. NanoPay batches 1000+ payments into 1 on-chain transaction, reducing cost by 99%.

## The Solution

NanoPay is a nanopayment protocol on TON. Buyers sign Ed25519 authorizations offchain (zero gas), a Phala TEE aggregator verifies and batches them, then periodically settles on-chain.

```
Agent (buyer)
  │  1. Deposit USDT → CyberGateway contract (one-time on-chain tx)
  │  2. Sign Ed25519 payment authorization (offchain, zero gas)
  ▼
Phala TEE Aggregator (TDX attestation)
  │  Verify signature → enforce policy → deduct balance → issue receipt
  │  Batch queue accumulates...
  ▼
CyberGateway Contract (TON, Tact)
  │  TEE submits BatchSettle() periodically
  │  Contract verifies TEE signature → executes batch Jetton transfers
  ▼
Sellers receive USDT
```

## Key Metrics

- **Payment latency**: ~500ms (offchain signature verification)
- **Gas cost**: 99% reduction (1000 payments → 1 on-chain tx)
- **Minimum payment**: $0.000001 (no lower bound)
- **TEE platform**: Phala Cloud TDX (hardware-level security)
- **Attestation**: Real Intel TDX quote, independently verifiable

## Use Cases

**AI Agent API Payments**
- LLM inference (per token/call), image generation, TTS, RAG retrieval
- Agent pays $0.001 per API call, no subscription needed

**Telegram Bot Monetization**
- Translation bot, AI chat bot, image gen bot — per-use billing
- Mini App in-app purchases (game items, votes, tips)

**Content Micropayments**
- Pay-per-article ($0.05) instead of monthly subscription
- AI crawler content licensing — charge per page crawled

**Compute & Data**
- GPU rental per second, serverless function per invocation
- Oracle price feeds, RPC node queries, on-chain data indexing

**IoT & Machine-to-Machine**
- Sensor data per reading, EV charging per second
- WiFi hotspot per minute, autonomous vehicle data exchange

## Integration

### For Buyers (AI Agents)

**Option A: MCP (recommended for AI agents)**

Works with Cursor, Claude Desktop, Windsurf, and any MCP-compatible client.

```json
{
  "mcpServers": {
    "nano-pay": {
      "command": "npx",
      "args": ["@cyberpay/nano-mcp"],
      "env": {
        "NANO_TEE_URL": "https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network"
      }
    }
  }
}
```

Then ask your agent:
```
You: Deposit 10 USDT into nanopay
Agent: [calls nano_deposit] ✓ Deposited. Balance: 10 USDT

You: Pay 0.001 USDT to 0:abc123...
Agent: [calls nano_pay] ✓ Paid. Confirmation: 8fb6b25b...

You: Check my balance
Agent: [calls nano_balance] Available: 9.999 USDT
```

MCP Tools: `nano_deposit`, `nano_pay`, `nano_balance`, `nano_history`, `nano_receipt`, `nano_attestation`, `nano_stats`, `nano_flush`, `nano_withdraw`, `nano_policy_get`, `nano_policy_set`

**Option B: SDK (for programmatic use)**

```typescript
import { NanoPayBuyer } from "@cyberpay/nano-sdk";

const buyer = new NanoPayBuyer({
  keypair: myEd25519Keypair,
  address: "EQ...",
  gatewayUrl: "https://3c84244e...-4030.dstack-pha-prod5.phala.network",
});

// Automatic x402 flow: request → 402 → sign → retry → 200
const response = await buyer.payAndFetch("https://api.merchant.com/data");
const data = await response.json();
```

### For Sellers (API Merchants)

Add a paywall middleware to your API — 3 lines of code:

**Express:**
```typescript
import { createPaywall } from "@cyberpay/nano-sdk";

const paywall = createPaywall({
  teeEndpoint: "https://3c84244e...-4030.dstack-pha-prod5.phala.network",
  merchantAddress: "EQxxx...",  // your TON address
  pricePerCall: 1000,           // $0.001 per call (USDT has 6 decimals)
});

app.use("/api", paywall.express());
app.get("/api/data", (req, res) => {
  res.json({ data: "premium content", payment: req.nanopay });
});
```

**Hono:**
```typescript
app.use("/api/*", paywall.hono());
```

**Any framework:**
```typescript
const result = await paywall.verify(request.headers);
if (!result.paid) return new Response("Payment Required", { status: 402 });
```

### Receipts

Every payment produces a TEE-signed receipt (buyer and seller both get it):

```json
{
  "version": "NanoPay:receipt:v2",
  "protected": {
    "alg": "EdDSA",
    "teePlatform": "phala-tdx",
    "teePubkey": "1e24ab..."
  },
  "payload": {
    "confirmationId": "abc123...",
    "from": "EQ...",
    "to": "EQ...",
    "amount": "1000",
    "confirmedAt": 1711234567,
    "remainingBalance": "9999000"
  },
  "signature": "ed25519-sig-hex"
}
```

Query by role: `GET /receipts/:address?role=from` (buyer) or `role=to` (seller).

## Works with TON Agentic Wallets

NanoPay complements [TON Agentic Wallets](https://agents.ton.org):

- **Agentic Wallet** → agent's on-chain wallet (deposit, withdraw, swap)
- **NanoPay** → agent's offchain payment layer (high-frequency micropayments)

```
Agent MCP Tools:
├── agentic-wallet/deposit    → fund CyberGateway from agent wallet
├── nano-pay/pay              → offchain micropayment (zero gas)
├── nano-pay/balance          → check balance
└── nano-pay/receipt          → get TEE-signed proof
```

## TEE Trust Model

NanoPay is not just micropayments — it's **verifiable micropayments**. The TEE provides three guarantees that pure on-chain solutions (x402, Superfluid) cannot:

| Property | What it means | Why it matters |
|----------|--------------|----------------|
| Input privacy | Who pays whom, how much — invisible to anyone outside TEE | Commercial secrets stay secret (API usage patterns, pricing) |
| Tamper-proof computation | Balance deductions cannot be manipulated | No one — not even the operator — can forge or alter payments |
| Provable output | Every receipt is TEE-signed with attestation | Third parties can independently verify any payment happened |

NanoPay uses Phala Cloud TDX (Intel Trust Domain Extensions) for security:

| Layer | What it proves |
|-------|---------------|
| Hardware isolation | TEE memory is encrypted — even server admin can't read it |
| Attestation | Running code matches open-source repo (verifiable codeHash) |
| On-chain binding | Contract only accepts signatures from the attested TEE key |
| Deterministic keys | Same app_id always derives same keypair (survives restarts) |

**What TEE is NOT**: It doesn't prevent the project owner from deploying new code. Users should verify attestation continuously. For production, add timelock/multisig on `SetTeeKey`.

## Architecture

```
cyber-nano-pay/
├── contracts/       # TON smart contract (Tact) — Deposit, BatchSettle, Withdraw, HITL
├── tee/             # Phala TEE Aggregator — signature verification, batching, settlement
├── sdk/             # Client SDK — buyer, seller, paywall middleware
├── mcp/             # MCP server — AI agent integration (nano_pay, nano_balance, nano_flush, etc.)
├── gateway/         # x402 HTTP gateway (rate-limited)
├── telegram/        # HITL approval Telegram bot
├── miniapp/         # Telegram Mini App (backend + frontend)
├── web/             # Demo frontend + pitch assets (nano.cyberpay.org)
├── website/         # Production deployment root (Vercel)
├── scripts/         # Utility scripts (lint, verify)
└── test/            # E2E tests
```

## TEE API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/attestation` | GET | TDX attestation report (pubkey, platform, quote) |
| `/verify` | POST | Verify payment + deduct balance |
| `/balance/:addr` | GET | Check balance (available/settled/unsettled) |
| `/stats` | GET | Global protocol statistics |
| `/policy` | POST | Set spending policy (admin) |
| `/policy/:addr` | GET | Get spending policy |
| `/receipts/:addr` | GET | Payment receipts (role=from/to/both) |
| `/receipt/:id` | GET | Single receipt by confirmation ID |
| `/history/payments/:addr` | GET | Payment history |
| `/history/deposits/:addr` | GET | Deposit history |
| `/flush` | POST | Force batch settlement (admin) |
| `/flush-for-withdraw` | POST | Merchant-triggered settlement |
| `/build-withdraw-tx` | POST | Build on-chain withdraw tx payload |
| `/approvals` | GET | Pending HITL approvals |
| `/approve/:id` | POST | Approve payment (admin) |
| `/reject/:id` | POST | Reject payment (admin) |
| `/simulate-deposit` | POST | Simulate deposit (dev mode only) |
| `/register-key` | POST | Register Ed25519 pubkey (dev mode only) |

## Running Locally

Prerequisites: Node.js >= 18, npm

```bash
# 1. Smart contracts (compile + test)
cd contracts
npm install
npx blueprint build           # compile Tact contracts
npx blueprint test            # run contract unit tests

# 2. TEE aggregator (local dev)
cd tee
cp .env.example .env          # edit .env with your config
npm install
npm run dev                   # starts on http://localhost:4030

# 3. SDK (build)
cd sdk
npm install
npm run build

# 4. MCP server (local dev)
cd mcp
npm install
npm run dev

# 5. Telegram HITL bot
cd telegram
cp .env.example .env          # set TELEGRAM_BOT_TOKEN
npm install
npm run dev

# 6. Mini App
cd miniapp
cp .env.example .env
npm install
npm run dev

# 7. E2E tests (against local or remote TEE)
cd test
cp .env.example .env          # set TEE_URL, ADMIN_TOKEN
npm install
npx tsx e2e.ts
```

## Deployments (Testnet)

| Component | Address / URL |
|-----------|--------------|
| CyberGateway Contract | `EQCywI9kxVeHirgdGg9dglbV5tcds-RPBfU2go2WQCMN3op9` |
| TestUSDT Jetton | `EQCNTKRmyHoE_O-Xv7-3OYp1WEFwVaTzoFiKFWVo_JQbJ7B4` |
| TEE (Phala CVM) | `3c84244ec8585d9d81678e9f8933c2b63bbfe5cd` |
| TEE Endpoint | [dstack-pha-prod5.phala.network](https://3c84244ec8585d9d81678e9f8933c2b63bbfe5cd-4030.dstack-pha-prod5.phala.network/health) |
| Demo Frontend | [nano.cyberpay.org](https://nano.cyberpay.org) |

## License

MIT
