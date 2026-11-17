#!/usr/bin/env bash
# 可重复验证流程（Task 16）
#
# 从干净克隆或当前工作区都能运行：依赖或 Electron 运行时缺失时先 npm install。
# 依次跑 构建 → 全量测试 → 凭据位自检 → 口径字典自检 → 最窄主干 explain，
# 再补 官方质控用例 与 引用留痕导出，并复核产物确实落盘。
# 任一检查失败立即以非 0 退出；输出全量透出，不截断。
#
# 用法：bash scripts/verify.sh
set -uo pipefail

cd "$(dirname "$0")/.."
PROJECT_ROOT="$(pwd)"
echo "=================================================================="
echo " 住院费用争议解释系统 · 可重复验证"
echo " 项目目录: $PROJECT_ROOT"
echo " 开始时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo " Node: $(node --version)   npm: $(npm --version)"
echo "=================================================================="

fail() {
  echo
  echo "[FAIL] $*"
  exit 1
}

run() {
  echo
  echo "===== $* ====="
  "$@" || fail "命令失败：$*"
}

# 0. 依赖就位（保证干净克隆也能复跑）
if [ ! -d node_modules/electron ] || [ ! -f node_modules/electron/path.txt ]; then
  run npm install --no-audit --no-fund
fi

# 1. 构建（TypeScript 编译 + 资产复制 + 渲染层打包）
run npm run build

# 2. 全量测试
run npm test

# 3. 凭据位自检
#    doctor 在无真实院内凭据时按设计返回 1 并列出缺项，这是预期状态而非失败；
#    这里同时校验「齐备」与「缺项」两条分支的输出，防止自检被写成永远通过。
echo
echo "===== cli doctor（接口凭据位配置状态）====="
DOCTOR_OUT="$(npm run --silent cli -- doctor 2>&1)"
DOCTOR_RC=$?
printf '%s\n' "$DOCTOR_OUT"
if [ "$DOCTOR_RC" -eq 0 ]; then
  printf '%s\n' "$DOCTOR_OUT" | grep -q '必填凭据位齐备' || fail 'doctor 齐备分支缺少结论'
elif [ "$DOCTOR_RC" -eq 1 ]; then
  printf '%s\n' "$DOCTOR_OUT" | grep -q '结论：缺少' || fail 'doctor 缺项分支缺少结论'
  echo '[verify] 当前无真实院内凭据，doctor 按设计报告缺项（预期状态，非失败）'
else
  fail "doctor 异常退出码 $DOCTOR_RC"
fi

# 4. 口径字典自检（结算清单 193 项 / 负面清单 §4 七条 / 勾稽 2 组）
run npm run --silent cli -- dict:check

# 5. 最窄主干：一条命令产出带引用解释稿与争议分类单
run npm run --silent cli -- explain --encounter ZY2026000001 --text "上次多算了 3200"

# 6. 产物落盘复核（含诚实的数据来源标注）
test -f outbox/explanation-CS-EXPLAIN-000001.md || fail '解释稿未落盘'
test -f outbox/classification-CS-EXPLAIN-000001.json || fail '争议分类单未落盘'
grep -q '本地脱敏样例' outbox/explanation-CS-EXPLAIN-000001.md || fail '解释稿缺少「本地脱敏样例」来源标注'
echo '[verify] 解释稿与分类单已落盘，且显式标注本地脱敏样例来源'

# 7. 附加回归：官方 8 条质控用例、引用留痕导出
run npm run --silent cli -- cases:run
run npm run --silent cli -- export

echo
echo "=================================================================="
echo " ALL CHECKS PASSED · $(date '+%Y-%m-%d %H:%M:%S')"
echo "=================================================================="
exit 0
