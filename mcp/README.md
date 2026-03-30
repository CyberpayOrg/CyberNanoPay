# @cyberpay/nano-mcp

MCP Server for NanoPay — 让 AI Agent 拥有零 Gas 纳米支付能力。

## 为什么需要这个？

传统支付方式无法满足 AI Agent 的高频微付需求：

| 收费模式 | 问题 |
|---------|------|
| 订阅制 | Agent 为了调 3 次 API 得买一个月，用量不可预测 |
| 积分/预付包 | 买 1000 次用了 50 次就不来了，剩余额度浪费 |
| 信用卡按次扣 | Stripe 最低手续费 $0.30/笔，$0.001 的 API 调用根本不可能按次收 |
| 链上直接付 | 每笔交易有 Gas 成本，高频场景（每秒几十次）不现实 |

NanoPay 通过 offchain Ed25519 签名 + TEE 聚合 + 链上批量结算，让单笔支付成本趋近于零，$0.0001 的微付也经济可行。

**对 API 商家来说，这意味着除了订阅和积分包，多了一种之前技术上做不到的收费方式 — 真正的按次收费。**

## 覆盖场景

NanoPay 解锁了这些之前"链上按次付不现实"的高频场景：

| 场景 | 单次价值 | 频率 | NanoPay 方案 |
|------|---------|------|-------------|
| LLM 推理 / 图片生成 | $0.01–$0.50 | 中频 | offchain 签名即时付，高价值场景 |
| RPC 节点 / 链上数据查询 | $0.0001 | 每秒几十次 | TEE 链下记账，批量结算 |
| AI Crawlers / RAG 检索 | $0.001/页 | 日均 10 万次 | x402 协议自动付费，定期结算 |
| IoT 传感器 / 充电桩 / WiFi | $0.0001–$0.01 | 每秒/每分钟 | offchain 签名累积，定时结算 |
| 付费文章 / 学术论文 | $0.10 | 低频 | 替代 $30 订阅，按篇付费 |
| 短视频微付 | $0.001 | 每次观看 | 用户无感，TEE 记账 |
| GPU 算力租用 | $0.01/秒 | 持续 | 按秒计费，批量结算 |
| 预言机喂价 / DEX 报价 | $0.001 | 高频 | 链上生态天然打通 |

## 与 @ton/mcp 的协作

`@cyberpay/nano-mcp` 和 `@ton/mcp`（TON Agentic Wallets）是互补关系：

```
@ton/mcp (链上操作层)
  ├── 充值 USDT 到 CyberGateway 合约（一次性）
  ├── 查链上余额、交易状态
  ├── 提款、swap、NFT 操作
  └── 管理 Agentic Wallet

@cyberpay/nano-mcp (高频微付层)
  ├── offchain 签名支付（零 Gas，~1ms）
  ├── TEE 验证 + 记账
  ├── 批量结算到链上
  └── TEE 签名收据 + Merkle 证明
```

AI Agent 的完整支付流程：

```
1. Agent 通过 @ton/mcp → 充值 USDT 到 CyberGateway（链上，一次性）
2. Agent 通过 @cyberpay/nano-mcp → offchain 签名付费（每次 API 调用，零 Gas）
3. TEE 聚合器 → 验签、记账、累积批次
4. TEE → 定期批量结算到链上（bilateral netting 压缩交易数）
5. Agent 通过 @ton/mcp → 查余额、查结算状态、需要时再充值
```

## 安装

```bash
npx @cyberpay/nano-mcp
```

## MCP 配置

添加到 MCP 设置文件（`mcp.json`）：

```json
{
  "mcpServers": {
    "nano-pay": {
      "command": "npx",
      "args": ["@cyberpay/nano-mcp"],
      "env": {
        "NANO_TEE_URL": "https://tee.cyberpay.org"
      }
    }
  }
}
```

搭配 TON Agentic Wallet 使用（推荐）：

```json
{
  "mcpServers": {
    "ton": {
      "command": "npx",
      "args": ["-y", "@ton/mcp@alpha"]
    },
    "nano-pay": {
      "command": "npx",
      "args": ["@cyberpay/nano-mcp"],
      "env": {
        "NANO_TEE_URL": "https://tee.cyberpay.org"
      }
    }
  }
}
```
