#!/bin/bash
# verify.sh — 全包类型检查 + 合约测试
# 用于 CI 和 Claude Code hooks
# 成功时静默，失败时输出错误

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
ERRORS=0

echo "=== CyberNanoPay Verify ==="

# 0. 安全硬约束
echo "[0/3] security lint..."
if ! bash "$ROOT/scripts/lint-security.sh" 2>&1; then
  ERRORS=$((ERRORS + 1))
fi

# 1. 合约测试
echo "[1/3] contracts: jest..."
cd "$ROOT/contracts"
if ! npm test --silent 2>&1 | tail -5; then
  echo "FAIL: contracts tests"
  ERRORS=$((ERRORS + 1))
fi

# 2. 类型检查（所有 TypeScript 包）
echo "[2/3] typecheck: all packages..."
for pkg in tee gateway telegram miniapp sdk; do
  cd "$ROOT/$pkg"
  if ! npx tsc --noEmit 2>&1; then
    echo "FAIL: $pkg typecheck"
    ERRORS=$((ERRORS + 1))
  fi
done

# 3. 依赖方向检查（简单版：gateway/telegram/miniapp 不能 import tee 的源码）
echo "[3/3] dependency direction check..."
for pkg in gateway telegram miniapp; do
  if grep -r "from.*['\"].*\.\./tee/" "$ROOT/$pkg/src/" 2>/dev/null; then
    echo "FAIL: $pkg has direct import from tee/ (should use HTTP only)"
    ERRORS=$((ERRORS + 1))
  fi
done

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "=== FAILED: $ERRORS error(s) ==="
  exit 1
else
  echo ""
  echo "=== ALL PASSED ==="
fi
