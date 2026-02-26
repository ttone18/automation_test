#!/usr/bin/env bash

set -uo pipefail

MODE="${1:-all}"        # smoke | functional | performance | all | full
API_URL="${2:-${E2B_API_URL:-}}"
API_KEY="${3:-${E2B_API_KEY:-}}"

if [[ -n "${API_URL}" ]]; then
  export E2B_API_URL="${API_URL}"
  export API_BASE_URL="${API_URL}"
fi

if [[ -n "${API_KEY}" ]]; then
  export E2B_API_KEY="${API_KEY}"
  export API_KEY="${API_KEY}"
fi

export TEMPLATE_ID="${TEMPLATE_ID:-test}"
export CONCURRENT_COUNT="${CONCURRENT_COUNT:-50}"
export TEMPLATE_LIST="${TEMPLATE_LIST:-base,test}"
export TEMPLATES_PER_TEST="${TEMPLATES_PER_TEST:-2}"
export SANDBOXES_PER_TEMPLATE="${SANDBOXES_PER_TEMPLATE:-20}"

# Explicit performance params to avoid single/multi confusion.
export SINGLE_TEMPLATE_ID="${SINGLE_TEMPLATE_ID:-${TEMPLATE_ID}}"
export SINGLE_CONCURRENT_COUNT="${SINGLE_CONCURRENT_COUNT:-${CONCURRENT_COUNT}}"
export MULTI_TEMPLATE_LIST="${MULTI_TEMPLATE_LIST:-${TEMPLATE_LIST}}"
export MULTI_TEMPLATES_PER_TEST="${MULTI_TEMPLATES_PER_TEST:-${TEMPLATES_PER_TEST}}"
export MULTI_SANDBOXES_PER_TEMPLATE="${MULTI_SANDBOXES_PER_TEMPLATE:-${SANDBOXES_PER_TEMPLATE}}"
export MULTI_CONCURRENT_COUNT="${MULTI_CONCURRENT_COUNT:-${CONCURRENT_COUNT}}"

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_DIR="${PROJECT_ROOT}/results"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
REPORT_FILE="${RESULT_DIR}/automation-report-${TIMESTAMP}.md"
mkdir -p "${RESULT_DIR}"

TOTAL=0
PASSED=0
WARNED=0
FAILED=0
WARNED_STEPS=()
FAILED_STEPS=()
WARNED_TIMEOUT=0
WARNED_THRESHOLD=0
FAILED_ERROR=0

log() {
  printf '%s %s\n' "[$(date +%H:%M:%S)]" "$*"
}

record_step() {
  local step_name="$1"
  local step_result="$2"
  local step_log="$3"
  local step_reason="${4:-}"
  local step_exit_code="${5:-}"
  local step_detail="${6:-}"

  TOTAL=$((TOTAL + 1))
  if [[ "${step_result}" == "PASS" ]]; then
    PASSED=$((PASSED + 1))
  elif [[ "${step_result}" == WARN_* ]]; then
    WARNED=$((WARNED + 1))
    WARNED_STEPS+=("${step_name}")
    case "${step_result}" in
      WARN_TIMEOUT) WARNED_TIMEOUT=$((WARNED_TIMEOUT + 1)) ;;
      WARN_THRESHOLD) WARNED_THRESHOLD=$((WARNED_THRESHOLD + 1)) ;;
    esac
  else
    FAILED=$((FAILED + 1))
    FAILED_STEPS+=("${step_name}")
    FAILED_ERROR=$((FAILED_ERROR + 1))
  fi

  {
    echo "- ${step_name}: ${step_result}"
    if [[ -n "${step_log}" ]]; then
      echo "  - log: \`${step_log}\`"
    fi
    if [[ -n "${step_reason}" ]]; then
      echo "  - reason: ${step_reason}"
    fi
    if [[ -n "${step_exit_code}" ]]; then
      echo "  - exit_code: ${step_exit_code}"
    fi
    if [[ -n "${step_detail}" ]]; then
      echo "  - detail: ${step_detail}"
    fi
  } >> "${REPORT_FILE}"
}

extract_threshold_detail() {
  local step_log="$1"
  local crossed_line metric_lines summary

  crossed_line="$(grep -Ei "thresholds on metrics .* crossed|has been crossed" "${step_log}" | tail -1 || true)"
  metric_lines="$(grep -E "创建成功率|就绪成功率|总体成功率|错误率|创建耗时统计|就绪耗时统计|总耗时统计|平均:|最小:|最大:|P90:|P99:|http_req_failed|errors|create_duration|ready_duration|total_duration" "${step_log}" | tail -40 || true)"

  summary=""
  if [[ -n "${crossed_line}" ]]; then
    summary="${crossed_line}"
  fi

  if [[ -n "${metric_lines}" ]]; then
    local one_line
    one_line="$(echo "${metric_lines}" | tr '\n' '; ' | sed 's/[[:space:]]\+/ /g' | sed 's/; $//')"
    if [[ -n "${summary}" ]]; then
      summary="${summary}; metrics=${one_line}"
    else
      summary="metrics=${one_line}"
    fi
  fi

  printf "%s" "${summary}"
}

extract_k6_thresholds_from_script() {
  local script_file="$1"
  [[ -f "${script_file}" ]] || return 0

  awk '
    /thresholds:[[:space:]]*\{/ { in_block=1; next }
    in_block && /^\s*\},\s*$/ { in_block=0; exit }
    in_block { print }
  ' "${script_file}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr '\n' '; ' | sed 's/; $//'
}

build_threshold_detail() {
  local step_log="$1"
  local script_file="$2"
  local crossed_detail threshold_cfg actual_metrics

  crossed_detail="$(extract_threshold_detail "${step_log}")"
  threshold_cfg="$(extract_k6_thresholds_from_script "${script_file}")"
  actual_metrics="$(grep -E "创建成功率|就绪成功率|总体成功率|错误率|平均:|最小:|最大:|P90:|P99:" "${step_log}" | tail -30 | tr '\n' '; ' | sed 's/[[:space:]]\+/ /g' | sed 's/; $//')"

  local merged=""
  [[ -n "${crossed_detail}" ]] && merged="${crossed_detail}"
  [[ -n "${threshold_cfg}" ]] && merged="${merged}${merged:+; }threshold_config=${threshold_cfg}"
  [[ -n "${actual_metrics}" ]] && merged="${merged}${merged:+; }actual_metrics=${actual_metrics}"

  printf "%s" "${merged}"
}

classify_failure() {
  local step_log="$1"
  local exit_code="$2"

  if [[ -f "${step_log}" ]]; then
    if grep -Eqi "thresholds on metrics .* crossed|has been crossed" "${step_log}"; then
      echo "WARN_THRESHOLD|k6 threshold crossed"
      return
    fi

    if grep -Eqi "timeout|timed out|request timeout|context deadline exceeded|i/o timeout|maxduration" "${step_log}"; then
      echo "WARN_TIMEOUT|timeout detected in logs"
      return
    fi
  fi

  echo "FAIL_ERROR|command failed with non-zero exit"
}

run_step() {
  local step_name="$1"
  local threshold_source="${2:-}"
  shift
  shift

  local step_log="${RESULT_DIR}/$(echo "${step_name}" | tr ' ' '_' | tr '/' '_' | tr -cd '[:alnum:]_-').log"
  log "START: ${step_name}"

  "$@" > "${step_log}" 2>&1
  local exit_code=$?
  if [[ ${exit_code} -eq 0 ]]; then
    log "PASS : ${step_name}"
    record_step "${step_name}" "PASS" "${step_log}" "" "0"
    return 0
  fi

  local classify_output
  classify_output="$(classify_failure "${step_log}" "${exit_code}")"
  local fail_type="${classify_output%%|*}"
  local fail_reason="${classify_output#*|}"
  local fail_detail=""

  if [[ "${fail_type}" == "WARN_THRESHOLD" ]]; then
    fail_detail="$(build_threshold_detail "${step_log}" "${threshold_source}")"
  fi

  case "${fail_type}" in
    WARN_TIMEOUT) log "WARN : ${step_name} (timeout)" ;;
    WARN_THRESHOLD) log "WARN : ${step_name} (threshold)" ;;
    *) log "FAIL : ${step_name} (error)" ;;
  esac

  record_step "${step_name}" "${fail_type}" "${step_log}" "${fail_reason}" "${exit_code}" "${fail_detail}"
  if [[ "${fail_type}" == FAIL_* ]]; then
    return 1
  fi
  return 0
}

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    log "Missing command: ${cmd}"
    return 1
  fi
}

trim_spaces() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf "%s" "${s}"
}

template_exists_cli() {
  local alias="$1"
  if ! command -v e2b >/dev/null 2>&1; then
    return 2
  fi

  local output
  if ! output="$(e2b template list 2>/dev/null)"; then
    return 2
  fi

  if [[ -z "${output}" ]]; then
    return 2
  fi

  [[ "${output}" == *"${alias}"* ]]
}

ensure_template_ready() {
  local alias
  alias="$(trim_spaces "$1")"
  [[ -n "${alias}" ]] || return 0

  if template_exists_cli "${alias}"; then
    log "Template exists, skip build: ${alias}"
    return 0
  fi

  local check_rc=$?
  if [[ ${check_rc} -eq 2 ]]; then
    log "Cannot verify template list via CLI, will build: ${alias}"
  else
    log "Template not found, will build: ${alias}"
  fi

  run_step "prebuild_template_${alias}" bash -lc "cd \"${PROJECT_ROOT}\" && TEMPLATE_ALIAS=\"${alias}\" python3 test_template.py"
}

ensure_templates_for_performance() {
  local -A seen=()
  local aliases=("${SINGLE_TEMPLATE_ID}")
  local item

  IFS=',' read -r -a items <<< "${MULTI_TEMPLATE_LIST}"
  for item in "${items[@]}"; do
    item="$(trim_spaces "${item}")"
    [[ -n "${item}" ]] && aliases+=("${item}")
  done

  for item in "${aliases[@]}"; do
    item="$(trim_spaces "${item}")"
    [[ -n "${item}" ]] || continue
    if [[ -z "${seen[${item}]+x}" ]]; then
      seen["${item}"]=1
      ensure_template_ready "${item}" || return 1
    fi
  done
}

init_report() {
  {
    echo "# E2B Test Automation Report"
    echo
    echo "- mode: ${MODE}"
    echo "- start_time: $(date '+%F %T')"
    echo "- api_url: ${E2B_API_URL:-unset}"
    echo "- template_id: ${TEMPLATE_ID}"
    echo
    echo "## Step Results"
  } > "${REPORT_FILE}"
}

finalize_report() {
  {
    echo
    echo "## Summary"
    echo "- total: ${TOTAL}"
    echo "- passed: ${PASSED}"
    echo "- warned: ${WARNED}"
    echo "- failed: ${FAILED}"
    echo "- warned_timeout: ${WARNED_TIMEOUT}"
    echo "- warned_threshold: ${WARNED_THRESHOLD}"
    echo "- failed_error: ${FAILED_ERROR}"
    if (( WARNED > 0 )); then
      echo "- warned_steps: ${WARNED_STEPS[*]}"
    fi
    if (( FAILED > 0 )); then
      echo "- failed_steps: ${FAILED_STEPS[*]}"
    fi
    echo "- end_time: $(date '+%F %T')"
  } >> "${REPORT_FILE}"

  echo
  echo "======================================="
  echo "Automation finished"
  echo "Total:  ${TOTAL}"
  echo "Passed: ${PASSED}"
  echo "Warned: ${WARNED}"
  echo "Failed: ${FAILED}"
  echo "Report: ${REPORT_FILE}"
  echo "======================================="
}

smoke_test() {
  require_cmd python3 || return 1
  [[ -n "${E2B_API_KEY:-}" ]] || { log "E2B_API_KEY is required"; return 1; }

  run_step "smoke_create_exec_kill" "" bash -lc "python3 - <<'PY'
import os
import time
from e2b import Sandbox

api_key = os.getenv('E2B_API_KEY')
if not api_key:
    raise RuntimeError('E2B_API_KEY is missing')

def get_fs(sbx):
    fs = getattr(sbx, 'filesystem', None)
    if fs is None:
        fs = getattr(sbx, '_filesystem')
    return fs

def rw_with_retry(fs, path, val, retries=6, base_delay=1.0):
    for attempt in range(1, retries + 1):
        try:
            fs.write(path, val)
            got = fs.read(path).strip()
            if got != val:
                raise RuntimeError(f'smoke read/write mismatch: expected={val}, got={got}')
            return
        except Exception as exc:
            if attempt == retries:
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), 8.0)
            print(f'rw retry {attempt}/{retries} after {type(exc).__name__}: {exc} -> sleep {delay}s')
            time.sleep(delay)

def print_network_context():
    print('api_url:', os.getenv('E2B_API_URL', 'unset'))
    for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'):
        val = os.getenv(key)
        if val:
            print(f'{key}={val}')

template_id = os.getenv('TEMPLATE_ID', 'test')
print_network_context()
try:
    sbx = Sandbox.create(template_id, timeout=300, allow_internet_access=True)
except TypeError:
    # Backward compatibility for SDK versions without allow_internet_access.
    sbx = Sandbox.create(template_id, timeout=300)
print('created:', sbx.sandbox_id)
print('sandbox_domain:', getattr(sbx, 'sandbox_domain', 'unknown'))
try:
    fs = get_fs(sbx)
    envd_api = getattr(fs, '_envd_api', None)
    envd_base_url = getattr(envd_api, 'base_url', None) if envd_api is not None else None
    if envd_base_url is not None:
        print('envd_api_base_url:', envd_base_url)

    path = '/tmp/smoke_rw.txt'
    val = 'smoke-rw-ok'
    time.sleep(2)
    rw_with_retry(fs, path, val)
    print('smoke read/write ok')

    res = sbx.commands.run('echo smoke-ok && uname -a')
    print(res.stdout)
finally:
    sbx.kill()
    print('killed:', sbx.sandbox_id)
PY"
}

functional_test() {
  require_cmd python3 || return 1

  run_step "functional_template_build" "" bash -lc "cd \"${PROJECT_ROOT}\" && TEMPLATE_ALIAS=\"${TEMPLATE_ID}\" python3 test_template.py"
  run_step "functional_create_pause_resume_rw_same_sandbox" "" bash -lc "cd \"${PROJECT_ROOT}\" && export E2B_SANDBOX_ID=\$(python3 test_sandbox_create.py --id-only) && echo \"sandbox_id=\${E2B_SANDBOX_ID}\" && python3 - <<'PY'
import os
import time
from e2b import Sandbox

sandbox_id = os.getenv('E2B_SANDBOX_ID')
if not sandbox_id:
    raise RuntimeError('E2B_SANDBOX_ID is missing')

def get_fs(sbx):
    fs = getattr(sbx, 'filesystem', None)
    if fs is None:
        fs = getattr(sbx, '_filesystem')
    return fs

def rw_with_retry(fs, path, val, retries=6, base_delay=1.0):
    for attempt in range(1, retries + 1):
        try:
            fs.write(path, val)
            got = fs.read(path).strip()
            if got != val:
                raise RuntimeError(f'pre-pause read/write mismatch: expected={val}, got={got}')
            return
        except Exception as exc:
            if attempt == retries:
                raise
            delay = min(base_delay * (2 ** (attempt - 1)), 8.0)
            print(f'pre-pause rw retry {attempt}/{retries} after {type(exc).__name__}: {exc} -> sleep {delay}s')
            time.sleep(delay)

sbx = Sandbox.connect(sandbox_id, timeout=600)
if hasattr(sbx, 'set_timeout'):
    sbx.set_timeout(600)

fs = get_fs(sbx)
path = '/tmp/pre_pause_rw_test.txt'
val = f'pre-pause-{int(time.time())}'
time.sleep(2)
rw_with_retry(fs, path, val)
print('pre-pause read/write ok')
PY
status=$?; [ \$status -eq 0 ] || exit \$status; python3 test_sandbox_resume.py --pause-first"
}

performance_test() {
  require_cmd bash || return 1
  require_cmd python3 || return 1
  require_cmd k6 || return 1
  [[ -n "${E2B_API_KEY:-}" ]] || { log "E2B_API_KEY is required"; return 1; }

  log "Performance plan: single(template=${SINGLE_TEMPLATE_ID}, concurrent=${SINGLE_CONCURRENT_COUNT})"
  log "Performance plan: multi(list=${MULTI_TEMPLATE_LIST}, templates=${MULTI_TEMPLATES_PER_TEST}, each=${MULTI_SANDBOXES_PER_TEMPLATE}, concurrent=${MULTI_CONCURRENT_COUNT})"

  ensure_templates_for_performance || return 1

  run_step "perf_concurrent_create" "${PROJECT_ROOT}/k6-concurrent-create.js" bash -lc "cd \"${PROJECT_ROOT}\" && CONCURRENT_COUNT=\"${SINGLE_CONCURRENT_COUNT}\" TEMPLATE_ID=\"${SINGLE_TEMPLATE_ID}\" ./run-all-tests.sh concurrent-create \"${E2B_API_URL}\" \"${E2B_API_KEY}\""

  run_step "perf_multi_template_create" "${PROJECT_ROOT}/k6-concurrent-create-multi-template.js" bash -lc "cd \"${PROJECT_ROOT}\" && TEMPLATE_LIST=\"${MULTI_TEMPLATE_LIST}\" TEMPLATES_PER_TEST=\"${MULTI_TEMPLATES_PER_TEST}\" SANDBOXES_PER_TEMPLATE=\"${MULTI_SANDBOXES_PER_TEMPLATE}\" CONCURRENT_COUNT=\"${MULTI_CONCURRENT_COUNT}\" ./run-all-tests.sh multi-template-create \"${E2B_API_URL}\" \"${E2B_API_KEY}\""
}

init_report

EXIT_CODE=0
case "${MODE}" in
  smoke)
    smoke_test || EXIT_CODE=1
    ;;
  functional)
    functional_test || EXIT_CODE=1
    ;;
  performance)
    performance_test || EXIT_CODE=1
    ;;
  all)
    functional_test || EXIT_CODE=1
    performance_test || EXIT_CODE=1
    ;;
  full)
    smoke_test || EXIT_CODE=1
    functional_test || EXIT_CODE=1
    performance_test || EXIT_CODE=1
    ;;
  *)
    echo "Usage: $0 [smoke|functional|performance|all|full] [API_URL] [API_KEY]"
    echo "  all  = functional + performance"
    echo "  full = smoke + functional + performance"
    EXIT_CODE=1
    ;;
esac

finalize_report
exit "${EXIT_CODE}"

