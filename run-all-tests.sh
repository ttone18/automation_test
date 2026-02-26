#!/bin/bash

set -e

# 解析命令行参数
SCENARIO="${1:-all}"
API_URL_ARG="${2:-}"
API_KEY_ARG="${3:-}"

# 如果提供了命令行参数，设置环境变量
if [ -n "$API_URL_ARG" ]; then
  export E2B_API_URL="$API_URL_ARG"
  export API_BASE_URL="$API_URL_ARG"
fi

if [ -n "$API_KEY_ARG" ]; then
  export E2B_API_KEY="$API_KEY_ARG"
  export API_KEY="$API_KEY_ARG"
fi

. ./test-config.sh

# 支持多种环境变量名（命令行参数已通过环境变量设置，这里只是确保有默认值）
API_BASE_URL="${E2B_API_URL:-${API_BASE_URL:-http://localhost:3000}}"
API_KEY="${E2B_API_KEY:-${API_KEY:-}}"
TEMPLATE_ID="${TEMPLATE_ID:-base}"
OUTPUT_DIR="./results"
mkdir -p "$OUTPUT_DIR"

echo "=========================================="
echo "E2B 系统压测 - 完整测试套件"
echo "=========================================="
echo "API 地址: $API_BASE_URL"
echo "模板 ID: $TEMPLATE_ID"
echo "开始时间: $(date)"
echo "=========================================="
echo ""

check_tool() {
  if ! command -v "$1" &> /dev/null; then
    echo "错误: 未找到 $1，请先安装"
    return 1
  fi
}

if check_tool k6; then
  HAS_K6=true
else
  HAS_K6=false
  echo "错误: 需要安装 k6"
  exit 1
fi

run_k6_concurrent_create() {
  echo ""
  echo ">>> 运行 k6 并发创建 Sandbox 压测..."
  # 从环境变量读取并发数量，默认10
  CONCURRENT_COUNT="${CONCURRENT_COUNT:-${VUS:-10}}"
  echo "    场景: 并发创建${CONCURRENT_COUNT}个sandbox，统计每个sandbox起来的时间分布"
  if [ -z "$API_KEY" ]; then
    echo "错误: 需要 E2B_API_KEY 或 API_KEY"
    return 1
  fi
  if [ -f "./run-k6.sh" ]; then
    ./run-k6.sh k6-concurrent-create.js \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env TEMPLATE_ID="$TEMPLATE_ID" \
      --env CONCURRENT_COUNT="$CONCURRENT_COUNT" \
      --env VUS="$CONCURRENT_COUNT"
  else
    cat k6-concurrent-create.js | k6 run - \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env TEMPLATE_ID="$TEMPLATE_ID" \
      --env CONCURRENT_COUNT="$CONCURRENT_COUNT" \
      --env VUS="$CONCURRENT_COUNT"
  fi
}


run_k6_quick_delete_all() {
  echo ""
  echo ">>> 运行 k6 一键删除所有 Sandbox 压测..."
  # 从环境变量读取配置
  CONCURRENT_COUNT="${CONCURRENT_COUNT:-${VUS:-50}}"
  CREATE_COUNT="${CREATE_COUNT:-0}"  # 如果需要先创建sandbox，设置这个变量
  
  if [ "$CREATE_COUNT" -gt 0 ]; then
    echo "    场景: 创建 ${CREATE_COUNT} 个 Sandbox 后，一次性删除（删除并发数: ${CONCURRENT_COUNT}）"
  else
    echo "    场景: 快速并发删除所有现有sandbox（并发数: ${CONCURRENT_COUNT}），测试一键删除功能"
  fi
  
  if [ -z "$API_KEY" ]; then
    echo "错误: 需要 E2B_API_KEY 或 API_KEY"
    return 1
  fi
  if [ -f "./run-k6.sh" ]; then
    ./run-k6.sh k6-quick-delete-all.js \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env CONCURRENT_COUNT="$CONCURRENT_COUNT" \
      --env VUS="$CONCURRENT_COUNT" \
      --env CREATE_COUNT="$CREATE_COUNT" \
      --env TEMPLATE_ID="$TEMPLATE_ID"
  else
    cat k6-quick-delete-all.js | k6 run - \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env CONCURRENT_COUNT="$CONCURRENT_COUNT" \
      --env VUS="$CONCURRENT_COUNT" \
      --env CREATE_COUNT="$CREATE_COUNT" \
      --env TEMPLATE_ID="$TEMPLATE_ID"
  fi
}

run_k6_stress_100_sandboxes() {
  echo ""
  echo ">>> 运行 k6 Sandbox流量压力测试..."
  # 从环境变量读取配置
  SANDBOX_COUNT="${SANDBOX_COUNT:-${CREATE_COUNT:-100}}"
  TRAFFIC_VUS="${TRAFFIC_VUS:-${VUS:-100}}"
  TRAFFIC_DURATION="${TRAFFIC_DURATION:-3m}"
  echo "    场景: 创建${SANDBOX_COUNT}个sandbox，同时给它们发流量（并发数: ${TRAFFIC_VUS}，持续: ${TRAFFIC_DURATION})"
  if [ -z "$API_KEY" ]; then
    echo "错误: 需要 E2B_API_KEY 或 API_KEY"
    return 1
  fi
  if [ -f "./run-k6.sh" ]; then
    ./run-k6.sh k6-stress-100-sandboxes.js \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env TEMPLATE_ID="$TEMPLATE_ID" \
      --env SANDBOX_COUNT="$SANDBOX_COUNT" \
      --env CREATE_COUNT="$SANDBOX_COUNT" \
      --env TRAFFIC_VUS="$TRAFFIC_VUS" \
      --env VUS="$TRAFFIC_VUS" \
      --env TRAFFIC_DURATION="$TRAFFIC_DURATION"
  else
    cat k6-stress-100-sandboxes.js | k6 run - \
      --env E2B_API_URL="$API_BASE_URL" \
      --env API_BASE_URL="$API_BASE_URL" \
      --env E2B_API_KEY="$API_KEY" \
      --env API_KEY="$API_KEY" \
      --env TEMPLATE_ID="$TEMPLATE_ID" \
      --env SANDBOX_COUNT="$SANDBOX_COUNT" \
      --env CREATE_COUNT="$SANDBOX_COUNT" \
      --env TRAFFIC_VUS="$TRAFFIC_VUS" \
      --env VUS="$TRAFFIC_VUS" \
      --env TRAFFIC_DURATION="$TRAFFIC_DURATION"
  fi
}

run_k6_multi_template_create() {
  echo ""
  echo ">>> 运行 k6 多模板并发创建 Sandbox 压测..."
  # 从环境变量读取配置
  CONCURRENT_COUNT="${CONCURRENT_COUNT:-${VUS:-128}}"
  TEMPLATE_LIST="${TEMPLATE_LIST:-}"
  TEMPLATE_LIST_FILE="${TEMPLATE_LIST_FILE:-}"
  TEMPLATES_PER_TEST="${TEMPLATES_PER_TEST:-16}"
  SANDBOXES_PER_TEMPLATE="${SANDBOXES_PER_TEMPLATE:-8}"
  TOTAL_SANDBOXES=$((TEMPLATES_PER_TEST * SANDBOXES_PER_TEMPLATE))
  echo "    场景: 从模板列表中随机选择${TEMPLATES_PER_TEST}个模板，每个模板创建${SANDBOXES_PER_TEMPLATE}个sandbox，总共${TOTAL_SANDBOXES}个"
  if [ -z "$API_KEY" ]; then
    echo "错误: 需要 E2B_API_KEY 或 API_KEY"
    return 1
  fi
  if [ -z "$TEMPLATE_LIST" ] && [ -z "$TEMPLATE_LIST_FILE" ]; then
    echo "错误: 需要 TEMPLATE_LIST 或 TEMPLATE_LIST_FILE 环境变量"
    echo "方式1: TEMPLATE_LIST=\"base,python,nodejs,go\" ./run-all-tests.sh multi-template-create ..."
    echo "方式2: TEMPLATE_LIST_FILE=\"./templates.txt\" ./run-all-tests.sh multi-template-create ..."
    return 1
  fi
  if [ -n "$TEMPLATE_LIST_FILE" ]; then
    if [ ! -f "$TEMPLATE_LIST_FILE" ]; then
      echo "错误: 模板列表文件不存在: $TEMPLATE_LIST_FILE"
      return 1
    fi
    echo "    模板列表文件: $TEMPLATE_LIST_FILE"
  else
    echo "    模板列表: $TEMPLATE_LIST"
  fi
  
  # 构建环境变量参数
  ENV_ARGS=(
    --env "E2B_API_URL=$API_BASE_URL"
    --env "API_BASE_URL=$API_BASE_URL"
    --env "E2B_API_KEY=$API_KEY"
    --env "API_KEY=$API_KEY"
    --env "CONCURRENT_COUNT=$CONCURRENT_COUNT"
    --env "VUS=$CONCURRENT_COUNT"
    --env "MAX_RETRIES=${MAX_RETRIES:-0}"
    --env "RETRY_DELAY_MS=${RETRY_DELAY_MS:-1000}"
    --env "SANDBOX_TIMEOUT=${SANDBOX_TIMEOUT:-60}"
    --env "HTTP_REQUEST_TIMEOUT=${HTTP_REQUEST_TIMEOUT:-120}"
    --env "TEMPLATES_PER_TEST=${TEMPLATES_PER_TEST:-16}"
    --env "SANDBOXES_PER_TEMPLATE=${SANDBOXES_PER_TEMPLATE:-8}"
  )
  
  # 根据是否有文件来添加不同的环境变量
  if [ -n "$TEMPLATE_LIST_FILE" ]; then
    # 使用绝对路径，确保k6能找到文件
    ABS_TEMPLATE_FILE="$(cd "$(dirname "$TEMPLATE_LIST_FILE")" && pwd)/$(basename "$TEMPLATE_LIST_FILE")"
    ENV_ARGS+=(--env "TEMPLATE_LIST_FILE=$ABS_TEMPLATE_FILE")
  else
    ENV_ARGS+=(--env "TEMPLATE_LIST=$TEMPLATE_LIST")
  fi
  
  if [ -f "./run-k6.sh" ]; then
    ./run-k6.sh k6-concurrent-create-multi-template.js "${ENV_ARGS[@]}"
  else
    cat k6-concurrent-create-multi-template.js | k6 run - "${ENV_ARGS[@]}"
  fi
}

run_k6_multi_template_stress() {
  echo ""
  echo ">>> 运行 k6 多模板压力测试..."
  TRAFFIC_DURATION="${TRAFFIC_DURATION:-30m}"
  CONCURRENT_COUNT="${CONCURRENT_COUNT:-${VUS:-60}}"
  TEMPLATE_LIST="${TEMPLATE_LIST:-test-gvisor,base,test}"
  
  echo "    场景: 对多个模板进行长时间压力测试"
  echo "    模板列表: $TEMPLATE_LIST"
  echo "    持续时间: $TRAFFIC_DURATION"
  echo "    并发速率: ${CONCURRENT_COUNT} 请求/分钟"
  echo "    API URL: $API_BASE_URL"
  echo "    API KEY: ${API_KEY:0:15}..."
  
  if [ -z "$API_KEY" ]; then
    echo "错误: 需要 E2B_API_KEY 或 API_KEY"
    return 1
  fi
  
  RESULTS_DIR="/tmp/e2b-load-test-results"
  mkdir -p "$RESULTS_DIR"
  
  TIMESTAMP=$(date +"%Y-%m-%dT%H-%M-%S")
  LOG_FILE="$RESULTS_DIR/k6-multi-template-stress-${TIMESTAMP}.log"
  
  echo "完整日志将保存到: $LOG_FILE"
  echo ""
  
  k6 run \
    -e E2B_API_URL="$API_BASE_URL" \
    -e API_BASE_URL="$API_BASE_URL" \
    -e E2B_API_KEY="$API_KEY" \
    -e API_KEY="$API_KEY" \
    -e TEMPLATE_LIST="$TEMPLATE_LIST" \
    -e CONCURRENT_COUNT="$CONCURRENT_COUNT" \
    -e TRAFFIC_DURATION="$TRAFFIC_DURATION" \
    k6-multi-template-stress.js 2>&1 | tee "$LOG_FILE"
  
  K6_EXIT_CODE=${PIPESTATUS[0]}
  
  echo ""
  echo "测试完成，退出码: $K6_EXIT_CODE"
  echo "日志文件: $LOG_FILE"
  
  return $K6_EXIT_CODE
}


case "$SCENARIO" in
  concurrent-create)
    if [ "$HAS_K6" = true ]; then
      run_k6_concurrent_create
    else
      echo "错误: 需要 k6 来运行并发创建测试"
      exit 1
    fi
    ;;
  quick-delete-all)
    if [ "$HAS_K6" = true ]; then
      run_k6_quick_delete_all
    else
      echo "错误: 需要 k6 来运行一键删除测试"
      exit 1
    fi
    ;;
  stress-100)
    if [ "$HAS_K6" = true ]; then
      run_k6_stress_100_sandboxes
    else
      echo "错误: 需要 k6 来运行流量压力测试"
      exit 1
    fi
    ;;
  multi-template-create)
    if [ "$HAS_K6" = true ]; then
      run_k6_multi_template_create
    else
      echo "错误: 需要 k6 来运行多模板并发创建测试"
      exit 1
    fi
    ;;
  multi-template-stress)
    if [ "$HAS_K6" = true ]; then
      run_k6_multi_template_stress
    else
      echo "错误: 需要 k6 来运行多模板压力测试"
      exit 1
    fi
    ;;
  all|*)
    echo "运行所有压测场景..."
    echo ""
    
    if [ "$HAS_K6" = true ]; then
      if [ -z "$API_KEY" ]; then
        echo "错误: 需要 E2B_API_KEY 或 API_KEY 来运行测试"
        exit 1
      fi
      
      echo "场景1: 并发创建 Sandbox"
      run_k6_concurrent_create
      sleep 5
      
      echo ""
      echo "场景2: 一键删除所有 Sandbox"
      run_k6_quick_delete_all
      sleep 5
      
      echo ""
      echo "场景3: 创建 Sandbox 后同时发送流量"
      run_k6_stress_100_sandboxes
    fi
    ;;
esac

echo ""
echo "=========================================="
echo "所有测试完成"
echo "结束时间: $(date)"
echo "=========================================="
echo ""
echo "结果文件保存在: /tmp/e2b-load-test-results"
echo "查看结果: ls -lh /tmp/e2b-load-test-results/"
echo ""

