# NanoPay — Agent Guide

TON 链上 AI Agent 微支付协议。7 个包的 monorepo。

## Build & Test Commands

```bash
# 合约（Tact）
cd contracts && npm run build          # 编译合约
cd contracts && npm test               # Jest 测试（7 个 spec 文件）

# TEE 聚合器
cd tee && npm run build                # TypeScript 编译

# Gateway / Telegram / MiniApp
cd gateway && npm run build
cd telegram && npm run build
cd miniapp && npm run build

# SDK
cd sdk && npm run build

# E2E 测试（需要 TEE 服务运行在 localhost:4030）
cd test && npx tsx e2e.ts
cd test && npx tsx x402-flow.ts
cd test && npx tsx policy-hitl.ts

# 全包类型检查
bash scripts/verify.sh
```

## Package Dependency Direction (STRICT)

```
contracts  →  独立，不依赖其他包
sdk        →  依赖 tweetnacl, @ton/core（不依赖其他包）
tee        →  可引用 contracts/wrappers, sdk 的类型
gateway    →  只通过 HTTP 调用 tee（不直接 import tee 代码）
telegram   →  只通过 HTTP 调用 tee
miniapp    →  只通过 HTTP 调用 tee
test       →  可依赖 sdk；通过 HTTP 调用 tee/gateway
```

违反方向的 import 是 bug，必须修复。

## Security Invariants (RED LINES)

→ 详见 `docs/SECURITY-INVARIANTS.md`

关键规则速查：
- 金额/余额必须用 `bigint`，禁止 `number`
- Ed25519 签名验证不能跳过或 mock（测试环境除外）
- nonce 必须检查重放
- 所有外部 HTTP 输入必须类型校验
- 私钥、助记词、seed 不能硬编码在源码中

## Architecture

→ 详见 `docs/ARCHITECTURE.md`

## Tech Stack

- Smart Contract: Tact (TON), @ton/blueprint
- TEE: Phala Network TDX, Hono, better-sqlite3
- Crypto: tweetnacl (Ed25519), @ton/core, @ton/crypto
- Telegram: grammY, Telegram Mini App
- Protocol: x402 (HTTP 402 Payment Required)
- All packages: TypeScript, ES2020+

## Definition of Done

一个任务完成的标准：
1. `bash scripts/lint-security.sh` 全部通过（安全硬约束）
2. `cd contracts && npm test` 全部通过
3. 所有修改过的包 `tsc --noEmit` 通过
4. 没有引入违反包间依赖方向的 import
5. 金额相关代码使用 bigint
6. 没有硬编码的密钥或助记词

完整验证: `bash scripts/verify.sh`

## When Blocked

- 测试失败 3 次：停下来，报告失败的测试和完整输出
- 不确定架构决策：停下来，说明选项和权衡
- 需要 .env 中的真实密钥：停下来，告知需要哪个变量
- 永远不要：删除测试文件来解决测试失败、跳过签名验证、用 `any` 绕过类型错误
