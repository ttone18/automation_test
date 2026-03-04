#!/bin/bash
# 长稳 + 波测场景入口
# 长稳：3 sandbox 持续压测 7*24h
# 波测：30 sandbox 并发 10 分钟
# 飞书告警：日志出现错误时推送

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 加载 test-config（若有）
[[ -f ./test-config.sh ]] && . ./test-config.sh

# 配置文件（可选）
CONFIG="${1:-long_stability_burst_config.yaml}"
if [[ -f "$CONFIG" ]]; then
  echo "使用配置: $CONFIG"
  EXTRA_ARGS="-c $CONFIG"
else
  EXTRA_ARGS=""
fi

# 依赖
command -v python3 >/dev/null || { echo "需要 python3"; exit 1; }
command -v k6 >/dev/null || { echo "需要 k6"; exit 1; }
[[ -n "${E2B_API_KEY:-}" ]] || { echo "请设置 E2B_API_KEY"; exit 1; }

# 飞书 webhook（可选，用于告警）
export FEISHU_WEBHOOK_URL="${FEISHU_WEBHOOK_URL:-}"

echo "=========================================="
echo "长稳 + 波测 压测"
echo "波测: 30 sandbox 并发 10 分钟"
echo "长稳: 3 sandbox 持续压测 7*24 小时"
echo "飞书告警: ${FEISHU_WEBHOOK_URL:+已配置}"
echo "=========================================="

python3 long_stability_burst_test.py $EXTRA_ARGS
