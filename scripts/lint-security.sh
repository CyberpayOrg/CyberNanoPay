#!/bin/bash
# lint-security.sh — 安全硬约束检查
# 这些规则违反了就不能合并。报错信息写给 agent 看。
#
# 用法: bash scripts/lint-security.sh
# 退出码: 0=通过, 1=有违规

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ERRORS=0

red()   { echo -e "\033[31m$1\033[0m"; }
green() { echo -e "\033[32m$1\033[0m"; }

# ─────────────────────────────────────────────
# Rule 1: 金额变量禁止用 number 类型
# 允许: amount: bigint, balance: bigint
# 禁止: amount: number, balance: number
# 修复: 把 number 改成 bigint
# ─────────────────────────────────────────────
echo "[Rule 1] 金额变量不能用 number..."

AMOUNT_VIOLATIONS=$(grep -rn \
  -E '(amount|balance|totalDeposited|totalSpent|totalAmount|pendingOutgoing|spendingLimit|dailyCap|hitlThreshold)\s*:\s*number' \
  "$ROOT"/tee/src/*.ts \
  "$ROOT"/sdk/src/*.ts \
  "$ROOT"/gateway/src/*.ts \
  2>/dev/null || true)

if [ -n "$AMOUNT_VIOLATIONS" ]; then
  red "FAIL: 金额相关变量使用了 number 类型（必须用 bigint）"
  echo "$AMOUNT_VIOLATIONS"
  echo "修复: 将这些字段的类型从 number 改为 bigint"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✓ 通过"
fi

# ─────────────────────────────────────────────
# Rule 2: 禁止硬编码密钥
# 禁止: mnemonic = "word word...", seed = "hex..."
# 修复: 使用 process.env.VARIABLE_NAME
# ─────────────────────────────────────────────
echo "[Rule 2] 禁止硬编码密钥..."

KEY_VIOLATIONS=$(grep -rn \
  -E "(mnemonic|private_key|privateKey|secret_key|secretKey|wallet_seed|TEE_SEED)\s*[:=]\s*[\"'][a-zA-Z0-9]" \
  "$ROOT"/tee/src/*.ts \
  "$ROOT"/sdk/src/*.ts \
  "$ROOT"/gateway/src/*.ts \
  "$ROOT"/telegram/src/*.ts \
  "$ROOT"/miniapp/src/*.ts \
  2>/dev/null | grep -v "process\.env\." | grep -v "\.example" | grep -v "test" || true)

if [ -n "$KEY_VIOLATIONS" ]; then
  red "FAIL: 发现硬编码的密钥或助记词"
  echo "$KEY_VIOLATIONS"
  echo "修复: 使用 process.env.VARIABLE_NAME 读取敏感信息"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✓ 通过"
fi

# ─────────────────────────────────────────────
# Rule 3: 包间依赖方向检查
# gateway/telegram/miniapp 不能直接 import tee 的源码
# 它们只能通过 HTTP 调用 tee
# 修复: 改为 HTTP 调用 TEE_URL 端点
# ─────────────────────────────────────────────
echo "[Rule 3] 包间依赖方向..."

for pkg in gateway telegram miniapp; do
  if [ -d "$ROOT/$pkg/src" ]; then
    DEP_VIOLATIONS=$(grep -rn "from.*['\"].*\.\./tee/" "$ROOT/$pkg/src/" 2>/dev/null || true)
    if [ -n "$DEP_VIOLATIONS" ]; then
      red "FAIL: $pkg 直接 import 了 tee 的源码（应该通过 HTTP 调用）"
      echo "$DEP_VIOLATIONS"
      echo "修复: 改为 fetch(\${TEE_URL}/endpoint) 的 HTTP 调用方式"
      ERRORS=$((ERRORS + 1))
    fi
  fi
done

# sdk 不能 import tee
if [ -d "$ROOT/sdk/src" ]; then
  SDK_DEP=$(grep -rn "from.*['\"].*\.\./tee/" "$ROOT/sdk/src/" 2>/dev/null || true)
  if [ -n "$SDK_DEP" ]; then
    red "FAIL: sdk 直接 import 了 tee 的源码（sdk 应该独立）"
    echo "$SDK_DEP"
    ERRORS=$((ERRORS + 1))
  fi
fi

echo "  ✓ 通过"

# ─────────────────────────────────────────────
# Rule 4: 签名验证不能被注释掉或跳过
# verifier.ts 里必须有 nacl.sign.detached.verify
# ─────────────────────────────────────────────
echo "[Rule 4] 签名验证完整性..."

VERIFIER="$ROOT/tee/src/verifier.ts"
if [ -f "$VERIFIER" ]; then
  if ! grep -q "nacl\.sign\.detached\.verify" "$VERIFIER"; then
    red "FAIL: tee/src/verifier.ts 中缺少 nacl.sign.detached.verify 调用"
    echo "修复: 签名验证是安全核心，不能移除或替换"
    ERRORS=$((ERRORS + 1))
  else
    echo "  ✓ 通过"
  fi
else
  red "FAIL: tee/src/verifier.ts 文件不存在"
  ERRORS=$((ERRORS + 1))
fi

# ─────────────────────────────────────────────
# Rule 5: .env 文件不能被提交
# ─────────────────────────────────────────────
echo "[Rule 5] .env 不在 git 追踪中..."

ENV_TRACKED=$(cd "$ROOT" && git ls-files '*.env' '.env.*' '*/.env' '*/.env.*' 2>/dev/null | grep -v ".example" | grep -v ".env.local" || true)
if [ -n "$ENV_TRACKED" ]; then
  red "FAIL: .env 文件被 git 追踪了"
  echo "$ENV_TRACKED"
  echo "修复: git rm --cached <file> 并确保 .gitignore 包含 .env"
  ERRORS=$((ERRORS + 1))
else
  echo "  ✓ 通过"
fi

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo ""
if [ $ERRORS -gt 0 ]; then
  red "=== FAILED: $ERRORS rule(s) violated ==="
  exit 1
else
  green "=== ALL SECURITY RULES PASSED ==="
fi
