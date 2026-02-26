#!/bin/bash
# E2B 压测配置文件
# 使用方式: source test-config.sh 或者 . test-config.sh

# 集群配置
export E2B_API_URL="${E2B_API_URL:-http://10.128.115.118:3000}"
export E2B_API_KEY="${E2B_API_KEY:-e2b_e2b53ae1fed82754c17ad8077f}"
export API_BASE_URL="${API_BASE_URL:-$E2B_API_URL}"
export API_KEY="${API_KEY:-$E2B_API_KEY}"
export TEMPLATE_ID="${TEMPLATE_ID:-base}"

echo "=========================================="
echo "E2B 压测配置已加载"
echo "=========================================="
echo "API URL: $E2B_API_URL"
echo "API Key: ${API_KEY:0:20}..."
echo "Template ID: $TEMPLATE_ID"
echo "=========================================="

