# Architecture — CyberNanoPay

## System Overview

```
Buyer (AI Agent)
  │  deposit USDT → CyberGateway contract (on-chain, one-time)
  │  sign Ed25519 payment auth (offchain, zero gas)
  ▼
TEE Aggregator (Phala TDX)
  │  verify sig → check policy → deduct balance → issue receipt
  │  accumulate batch → bilateral netting
  ▼
CyberGateway Contract (TON, Tact)
  │  TEE submits batchSettle() → verify TEE sig → execute transfers
  ▼
Seller receives USDT
```

## Package Map

| Package | 职责 | 运行环境 | 端口 |
|---------|------|----------|------|
| `contracts/` | TON 智能合约 (Tact) | TON 区块链 | — |
| `tee/` | 核心聚合器：验签、记账、批量结算 | Phala TEE | 4030 |
| `gateway/` | x402 HTTP 网关：requirePayment 中间件 | Node.js | 4031 |
| `telegram/` | HITL 审批 Bot | Node.js | 4032 |
| `miniapp/` | Telegram Mini App 钱包 UI | Node.js | 4033 |
| `sdk/` | 客户端 SDK (buyer + seller) | npm package | — |
| `test/` | E2E 和集成测试 | Node.js | — |

## Dependency Direction (Enforced)

```
contracts  ──(独立)
     │
     ▼ (wrappers)
    tee  ◄── sdk (types only)
     │
     │ (HTTP only, no code import)
     ├──► gateway
     ├──► telegram
     └──► miniapp

test ──► sdk (direct import)
test ──► tee, gateway (HTTP calls)
```

规则：箭头方向是允许的依赖方向。反向依赖是 bug。
gateway/telegram/miniapp 之间互不依赖。

## TEE Internal Modules

```
server.ts          HTTP API 入口 (Hono)
  └─► aggregator.ts   核心编排：verify → policy → deduct → batch
        ├─► verifier.ts    Ed25519 签名验证
        ├─► ledger.ts      余额账本 (内存 + 持久化)
        ├─► batcher.ts     批量累积 + bilateral netting
        ├─► settler.ts     链上提交 batch settlement
        ├─► receipt.ts     COSE_Sign1 风格收据生成
        └─► merkle.ts      Merkle tree 用于收据证明

store.ts           SQLite 审计日志
listener.ts        链上事件监听 (deposits, settlements)
attestation.ts     Phala TDX 远程证明
types.ts           共享类型定义
```

## Data Flow: Single Payment

```
1. Buyer signs PaymentAuthorization {from, to, amount, nonce, validBefore, signature}
2. POST /verify → server.ts
3. verifier.ts: nacl.sign.detached.verify(message, signature, publicKey)
4. aggregator.ts: check nonce uniqueness → check spending policy → check HITL threshold
5. ledger.ts: deduct balance (available -= amount, pendingOutgoing += amount)
6. batcher.ts: add to pending batch
7. receipt.ts: generate TEE-signed receipt with confirmationId
8. Return receipt to caller
9. (async) batcher.flush() → settler.ts → on-chain batchSettle()
10. listener.ts: confirm settlement → ledger.ts: finalize balances
```

## Smart Contract Messages

| Message | Direction | Description |
|---------|-----------|-------------|
| Deposit (TEP-74 transfer) | User → Contract | 充值 USDT |
| BatchSettle | TEE → Contract | 批量结算（TEE 签名） |
| VerifiedBatchSettle | TEE → Contract | 大额批量结算（TEE + 用户签名） |
| InitiateWithdraw | User → Contract | 发起提款（开始 cooldown） |
| CompleteWithdraw | User → Contract | 完成提款（cooldown 后） |
| SetSpendingLimit | User → Contract | 设置单笔限额 |
| SetDailyCap | User → Contract | 设置日限额 |
| RequestApproval | TEE → Contract | HITL 审批请求 |
| ApprovePayment / RejectPayment | User → Contract | HITL 审批结果 |
