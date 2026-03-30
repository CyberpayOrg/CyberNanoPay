# NanoPay QA 质量审查报告

> 审查日期: 2026-03-27
> 审查角色: 高级 QA 质量负责人
> 项目: NanoPay — TON 链上 AI Agent 微支付协议

---

## 一、发现的问题（按严重性排序）

### P0 — 高优先级安全问题

**1. ADMIN_TOKEN 缺省允许无认证访问**
- `tee/src/server.ts:63-70` — `adminGuard()` 当 `ADMIN_TOKEN` 为空时直接 `return null`（放行）
- 未配置 token 时，`/flush`、`/simulate-deposit`、`/policy`、`/approve`、`/reject` 等管理端点完全开放
- 风险: 任何人可以模拟存款、强制结算、审批/拒绝支付

**2. Nonce 清理策略有重放攻击窗口**
- `tee/src/ledger.ts:320-330` — `pruneNonces()` 使用简单的 FIFO 删除策略
- 被删除的旧 nonce 可被重放，只要对应的 `validBefore` 尚未过期
- 注释承认 "In production, use a time-bucketed approach" — 支付系统不应有这种 TODO
- 且 `pruneNonces()` 在整个代码库中**从未被调用**

**3. `.gitignore` 第 27 行包含 `*.md`**
- 会阻止新增的 Markdown 文档被 git 跟踪
- 现有 .md 文件（README、ARCHITECTURE 等）是在此规则之前 commit 的
- 新建文档会被静默忽略，容易造成文档丢失

> **已排除**: `.env` 文件经验证从未进入 git 历史，`.gitignore` 对 `.env` 的保护正常生效。密钥仅存在于本地磁盘，无需紧急轮换。

---

### P1 — 核心测试缺失

**4. TEE 层零测试覆盖**
- `tee/` 目录没有任何测试文件
- `aggregator.ts`、`ledger.ts`、`verifier.ts`、`batcher.ts`、`receipt.ts`、`merkle.ts` — 全部无测试
- 这是系统最核心的组件：所有资金记账、签名验证、批量结算逻辑都在这里
- 合约有 7 个 spec 文件，但 TEE 层完全裸奔

**5. E2E 测试不是自动化测试**
- `test/e2e.ts` 是手动运行脚本（`npx tsx e2e.ts`），不是 Jest/Vitest 测试
- 无 `assert`/`expect` — 仅 `console.log`，失败时不会返回非零退出码
- `test/x402-flow.ts`、`test/policy-hitl.ts`、`test/trigger-hitl.ts` 同理
- 无法集成到 CI 中自动检测回归

**6. SDK 没有测试**
- `sdk/src/buyer.ts`、`sdk/src/seller.ts`、`sdk/src/paywall.ts` — 零测试
- 消息签名逻辑在 `buyer.ts` 和 `verifier.ts` 中重复实现，无测试确保一致性

**7. `buildMessage` 在 3 处重复实现**
- `tee/src/verifier.ts:58-105` — `buildAuthMessage()`
- `sdk/src/buyer.ts:150-193` — `buildMessage()`
- `mcp/src/index.ts:54-83` — `signPayment()` 内联
- 任何一处修改导致不一致，签名验证将全面失败
- 无交叉测试保障一致性

---

### P2 — 内存与一致性问题

**8. 内存泄漏风险（3 处）**

| 位置 | 数据结构 | 问题 |
|------|----------|------|
| `aggregator.ts` — `receipts` Map | 只增不删 | 长期运行 OOM |
| `ledger.ts` — `usedNonces` Set | `pruneNonces()` 存在但从未被调用 | 无界增长 |
| `server.ts:542` — `lastFlushRequest` Map | 永不清理 | 缓慢泄漏 |

**9. Settlement 无链上确认**
- `settler.ts:151-162` — `settle()` 发送交易后不等待链上确认，直接返回
- 如果交易被链上拒绝（gas 不足、合约 require 失败），TEE ledger 已扣减但链上未执行
- TEE 与链上状态可能永久不一致
- `_settleBatch()` 在发送成功后立即调用 `creditSettlement()`，但交易可能最终失败

**10. 并发安全性**
- `ledger.ts:tryDeduct()` 中 daily tracker 更新在第 133 行，余额扣减在第 151 行
- `aggregator.verifyAndDeduct()` 是 `async` 函数，在 `await publicKeyResolver` 处让出控制
- 如果同一地址有并发请求，daily cap 检查和扣减之间可能 race condition
- Node.js 单线程缓解了部分风险，但 await 点仍然是窗口

**11. 链上事件解析脆弱**
- `listener.ts:176-202` — 通过 bit 数量猜测事件类型（`bits > 335` 认为是 BatchSettle）
- 无 opcode 前缀（Tact emit 特性），依赖字段结构和 bit count 区分
- 新增事件类型可能导致错误解析

---

### P3 — 类型安全与工程化

**12. 大量 `any` 类型**

| 文件 | 位置 | 问题 |
|------|------|------|
| `store.ts:102,108,128,151` | `getPayments` 等返回 `any[]` | 无类型安全 |
| `seller.ts:41,81,89` | `receipt?: any` | SDK 公开 API 无类型 |
| `paywall.ts:33,80` | `receipt?: any` | 中间件结果无类型 |
| `server.ts:63` | `adminGuard(c: any)` | Hono Context 应有类型 |

**13. `PaywallConfig.pricePerCall` 是 `number` 而非 `bigint`**
- `paywall.ts:24` — 违反 SECURITY-INVARIANTS.md 第 1 条
- `lint-security.sh` 漏检（`pricePerCall` 不在检查列表中）

**14. `BalanceSnapshot.pendingOutgoing` 恒为 0n**
- `ledger.ts:249` — `pendingOutgoing: 0n, // TODO: track pending batch amounts`
- 导致余额查询返回不准确的数据

**15. 无 CI/CD 配置**
- 项目根目录无 `.github/workflows/`
- `verify.sh` 存在但未被任何 CI 流水线调用
- 合约测试、类型检查、安全 lint 均为手动执行

**16. 合约管理操作缺审计事件**
- `SetTeeKey`、`RescueJetton`、`SetCooldown`、`SetStopped` — 无 emit event
- 关键管理操作无链上审计追踪

---

## 二、改进实施计划

### Phase 1 — 安全加固（2 天）

| # | 任务 | 详情 |
|---|------|------|
| 1.1 | **ADMIN_TOKEN 强制要求** | 修改 `adminGuard()`: 当 `ADMIN_TOKEN` 为空时拒绝所有管理请求，而非放行。启动时如果未配置则打印 ERROR 并拒绝启动（或至少禁用管理端点） |
| 1.2 | **修复 `.gitignore`** | 删除第 27 行 `*.md` 规则 |
| 1.3 | **Nonce 清理调度** | 在 `aggregator.start()` 中添加定时器调用 `ledger.pruneNonces()`；改为基于 `validBefore` 时间戳的清理策略，而非 FIFO |
| 1.4 | **安全 lint 增强** | `lint-security.sh` Rule 1 增加 `pricePerCall` 等漏检字段 |

### Phase 2 — 核心测试建设（1 周）

| # | 任务 | 覆盖内容 |
|---|------|----------|
| 2.1 | **`verifier.test.ts`** | 签名验证正确性、篡改检测、无效签名拒绝、边界条件（空字段、超长 nonce） |
| 2.2 | **`ledger.test.ts`** | 存款/扣减/余额一致性、nonce 重放拒绝、policy 执行（spending limit / daily cap / HITL threshold）、daily reset 逻辑、`forceDeduct` 行为、序列化/反序列化 round-trip |
| 2.3 | **`batcher.test.ts`** | bilateral netting 正确性（A→B + B→A 对消）、批量分割、溢出处理、空批处理、verified 批分离 |
| 2.4 | **`aggregator.test.ts`** | 完整支付流（存款→验签→扣减→batch→结算）、HITL 审批流（hold→approve/reject/expire）、batch 失败重试（指数退避、5 次上限） |
| 2.5 | **`receipt.test.ts` + `merkle.test.ts`** | 收据签名/验证 round-trip、Merkle proof 生成与独立验证、篡改 payload 后验证失败 |
| 2.6 | **SDK 测试** | `buyer.test.ts`: 签名一致性（与 verifier 交叉验证）、x402 flow mock。`paywall.test.ts`: Express/Hono 中间件行为 |
| 2.7 | **E2E 测试改造** | 将 `test/e2e.ts` 改写为 Jest 测试，加 `expect()` assertions，失败时非零退出 |
| 2.8 | **消息构建一致性测试** | 对 3 处 `buildMessage` 实现（verifier、buyer、mcp）做同一输入交叉验证 |

### Phase 3 — 可靠性修复（3-5 天）

| # | 任务 | 详情 |
|---|------|------|
| 3.1 | **Receipt 内存上限** | 给 `receipts` Map 设 LRU 上限（如 100k 条），旧 receipt 持久化到 SQLite |
| 3.2 | **`lastFlushRequest` 清理** | 在 snapshot 定时器中清理过期条目 |
| 3.3 | **Settlement 确认机制** | `settler.ts` 提交后通过 listener 回调确认链上成功，再调用 `creditSettlement`；失败时触发 retry 而非假设成功 |
| 3.4 | **消息构建去重** | 将 `buildAuthMessage` 提取到 `sdk` 共享模块，TEE 和 MCP 统一引用，消除 3 处重复 |
| 3.5 | **`pricePerCall` 改为 bigint** | 修复 `paywall.ts` 类型安全违规 |
| 3.6 | **消除 `any` 类型** | Store 返回值、SDK receipt 字段替换为具体类型 |

### Phase 4 — 工程化（1 周）

| # | 任务 | 详情 |
|---|------|------|
| 4.1 | **CI 流水线** | 添加 `.github/workflows/ci.yml`，运行: `verify.sh`（合约测试 + 类型检查 + 安全 lint）+ TEE 单元测试 + SDK 测试 |
| 4.2 | **测试覆盖率门槛** | 配置 Jest coverage，TEE 核心模块（verifier/ledger/batcher/aggregator）最低 80% |
| 4.3 | **Ledger 不变量审计** | 添加定时检查: `sum(balances) == totalDeposits - totalSettled - totalWithdrawn`，不等式触发告警 |
| 4.4 | **实现 `pendingOutgoing`** | 修复 `BalanceSnapshot.pendingOutgoing` TODO，追踪 batch 中未结算金额 |
| 4.5 | **合约管理事件** | 给 `SetTeeKey`、`RescueJetton`、`SetCooldown`、`SetStopped` 添加 emit event |
| 4.6 | **TEE API Rate Limiting** | 添加 Hono rate limit 中间件，防止 `/verify` 端点被滥用 |

---

## 三、优先级总结

```
本周完成 (P0):  ADMIN_TOKEN 强制 + Nonce 清理 + .gitignore 修复
下周完成 (P1):  TEE 单元测试全覆盖 + E2E 自动化 + 消息构建去重
两周内   (P2):  内存泄漏修复 + Settlement 确认 + 类型安全
一个月内 (P3):  CI/CD + 覆盖率门槛 + Ledger 不变量审计 + Rate Limiting
```

**最大风险**: TEE（系统核心）零测试覆盖。TEE 承载所有资金记账、签名验证、批量结算逻辑，是唯一没有测试的组件。

---

## 四、已验证安全项（无需行动）

| 检查项 | 结果 |
|--------|------|
| `.env` 是否被 git 跟踪 | `.env` 从未进入 git 历史，`.gitignore` 正常生效 |
| 密钥是否推送到 GitHub | 未推送，仅存在于本地磁盘 |
| Ed25519 签名验证是否存在 | `verifier.ts` 中 `nacl.sign.detached.verify` 正常存在 |
| 金额类型是否使用 bigint | 核心路径（types.ts/ledger.ts/aggregator.ts）均使用 bigint |
| 包间依赖方向 | gateway/telegram/miniapp 通过 HTTP 调用 TEE，无直接 import |
| 两阶段提款 cooldown | 合约正确实现 `InitiateWithdraw` → cooldown → `CompleteWithdraw` |
| TEE 签名双重验证 | 合约层 `checkSignature` 验证 TEE 签名，不依赖 TEE 自证 |
