# Security Invariants — CyberNanoPay

这些是支付协议的安全红线。违反任何一条都是严重 bug。

## 1. 金额运算

- 所有金额、余额、费用字段必须使用 `bigint`
- 禁止用 `number` 处理金额（精度丢失 = 资金损失）
- 金额比较必须用 bigint 运算符，不能转 number 后比较
- 序列化/反序列化时必须用 `BigInt()` 或 `toString()` 显式转换

```typescript
// ✅ 正确
const amount: bigint = 1000n;
if (balance >= amount) { ... }

// ❌ 错误
const amount: number = 1000;
if (Number(balance) >= amount) { ... }
```

## 2. 签名验证

- Ed25519 签名验证（`nacl.sign.detached.verify`）不能被跳过
- 不能用 mock 替代真实签名验证（测试环境中使用真实 keypair）
- TEE 的 batch settlement 签名必须在合约层二次验证
- VerifiedBatchSettle 中每笔大额支付的用户签名必须逐一验证

## 3. 重放保护

- 每笔支付的 nonce 必须是唯一的（32 bytes hex）
- 已使用的 nonce 必须记录在 TEE ledger 中
- 重复 nonce 的支付必须被拒绝，返回明确错误
- nonce 检查必须在余额扣减之前执行

## 4. 输入校验

- 所有 HTTP API 的外部输入必须进行类型校验
- TON 地址格式必须验证（使用 `Address.parse()` 或等价方法）
- 金额必须 > 0，不能为负数
- `validBefore` 时间戳必须在未来
- 签名长度必须是 128 hex chars (64 bytes)

## 5. 密钥管理

- 私钥、助记词、seed 不能出现在源码中
- 必须通过环境变量或 TEE 密钥派生获取
- `.env` 文件必须在 `.gitignore` 中
- 日志中不能打印密钥或签名的完整内容

## 6. 提款安全

- 两阶段提款的 cooldown 期不能被绕过
- `InitiateWithdraw` 和 `CompleteWithdraw` 之间必须有时间间隔
- 提款金额不能超过可用余额

## 7. 批量结算

- batch 中的 positions 必须经过 bilateral netting
- batch_data_hash 必须与链上提交的数据一致
- 失败的 settlement 必须重试（指数退避，最多 5 次）
- 重试耗尽后必须标记为需要人工干预，不能静默丢弃

## 8. HITL (Human-in-the-Loop)

- 超过 hitlThreshold 的支付必须等待人工审批
- pending 状态的支付不能自动通过
- 审批超时的支付必须被拒绝，不能默认通过
