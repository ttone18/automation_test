# E2B 自动化测试

## 1. 测试目标

- 验证模板构建流程可用（build 能成功，支持 base 镜像与私有镜像）
- 验证 sandbox 生命周期核心能力（创建、读写、pause、resume、销毁）
- 验证网络访问、Git、错误处理、沙箱隔离等能力
- 验证 tail 流式输出重连场景
- 验证并发创建能力（单模板与多模板）
- 输出统一测试报告与步骤日志，便于复盘和 CI 接入

## 2. 脚本入口

- **主入口**：`test-automation.sh`（支持 `-c config.yaml` 从 YAML 加载参数）
- **配置文件**：`config.example.yaml`（复制为 config.yaml 后编辑）、`load_config.py`（解析器）
- **子脚本**：
  - `test_template.py` - 模板构建（支持 `TEMPLATE_SOURCE=base` 免私有镜像）
  - `test_template_large_image.py` - 大镜像模板构建（可选）
  - `test_sandbox_create.py` - 创建 sandbox 并返回 ID
  - `test_sandbox_resume.py` - pause/resume 读写验证
  - `test_sandbox_tail_reconnect.py` - tail 流重连测试
  - `test_sandbox_network.py` - 网络访问（DNS、curl）
  - `test_sandbox_git.py` - Git 克隆
  - `test_sandbox_errors.py` - 错误路径（读不存在文件、无效命令）
  - `test_sandbox_isolation.py` - 多沙箱隔离验证
  - `test_tail.py` - tail -f 场景压力测试（独立运行）
  - `run-all-tests.sh` - k6 性能子脚本
  - `k6-concurrent-create.js` - 单模板并发
  - `k6-concurrent-create-multi-template.js` - 多模板并发

## 3. 模式说明

| 模式 | 说明 |
|------|------|
| smoke | 快速冒烟（创建、命令执行、读写、销毁） |
| functional | 功能测试（模板构建 + 生命周期 + 网络 + Git + 错误 + 隔离 + 大镜像可选） |
| performance | 性能测试（单模板并发 + 多模板并发） |
| all | functional + performance（推荐“全量”） |
| full | smoke + functional + performance（完整回归） |

## 4. YAML 配置文件（推荐）

将参数写入 YAML 文件，避免长命令。复制 `config.example.yaml` 为 `config.yaml` 并编辑：

```bash
cp config.example.yaml config.yaml
# 编辑 config.yaml，填入 E2B_API_KEY 等
```

运行示例：
```bash
# 使用配置文件，命令更简洁
./test-automation.sh -c config.yaml performance
./test-automation.sh --config config.yaml all
```

配置文件中的参数可被命令行参数覆盖，如 `./test-automation.sh -c config.yaml performance "" "$E2B_API_KEY"` 会用环境变量的 API_KEY 覆盖配置文件中的值。

## 5. 常用命令

### 冒烟测试
```bash
# 使用配置文件
./test-automation.sh -c config.yaml smoke

# 或传统方式
TEMPLATE_ID=test ./test-automation.sh smoke "" "$E2B_API_KEY"
```

### 功能测试
```bash
# 使用配置文件
./test-automation.sh -c config.yaml functional

# 或传统方式
TEMPLATE_ID=test ./test-automation.sh functional "" "$E2B_API_KEY"
```

### 功能测试（含大镜像构建）
```bash
ENABLE_LARGE_IMAGE_BUILD_TEST=1 \
TEMPLATE_LARGE_IMAGE=your-registry/large-image:tag \
TEMPLATE_REGISTRY_USERNAME=user \
TEMPLATE_REGISTRY_PASSWORD=pass \
TEMPLATE_ID=test ./test-automation.sh functional "" "$E2B_API_KEY"
```

### 性能测试
```bash
SINGLE_TEMPLATE_ID=test \
SINGLE_CONCURRENT_COUNT=60 \
MULTI_TEMPLATE_LIST="test1,test2,test3" \
MULTI_TEMPLATES_PER_TEST=3 \
MULTI_SANDBOXES_PER_TEMPLATE=20 \
MULTI_CONCURRENT_COUNT=60 \
./test-automation.sh performance "" "$E2B_API_KEY"
```

### 性能 + 稳定性测试（含多并发长时间压测）
```bash
# 使用配置文件（在 config.yaml 中设置 ENABLE_STRESS_TEST: 1 等）
./test-automation.sh -c config.yaml performance

# 或传统方式
ENABLE_STRESS_TEST=1 \
STRESS_TRAFFIC_DURATION=5m \
MULTI_TEMPLATE_STRESS_DURATION=15m \
TEMPLATE_ID=test \
./test-automation.sh performance "" "$E2B_API_KEY"
```

### 功能 + 性能（all）
```bash
SINGLE_TEMPLATE_ID=test \
SINGLE_CONCURRENT_COUNT=60 \
MULTI_TEMPLATE_LIST="test1,test2,test3" \
MULTI_TEMPLATES_PER_TEST=3 \
MULTI_SANDBOXES_PER_TEMPLATE=20 \
MULTI_CONCURRENT_COUNT=60 \
TEMPLATE_ID=test \
./test-automation.sh all "" "$E2B_API_KEY"
```

### 完整回归（full）
```bash
TEMPLATE_ID=test ./test-automation.sh full "" "$E2B_API_KEY"
```

## 6. 参数说明

### 通用参数
- `TEMPLATE_ID`：功能测试默认模板别名
- 第 2 个位置参数：`API_URL`（可传空字符串，使用环境变量）
- 第 3 个位置参数：`API_KEY`（一般传 `"$E2B_API_KEY"`）

### 模板构建
- `TEMPLATE_SOURCE`：`image`（默认，私有镜像）或 `base`（免私有镜像）
- `TEMPLATE_ALIAS` / `TEMPLATE_ALIASES`：构建目标别名（多别名逗号分隔）
- `TEMPLATE_IMAGE`：私有镜像地址（`TEMPLATE_SOURCE=image` 时）
- `TEMPLATE_REGISTRY_USERNAME` / `TEMPLATE_REGISTRY_PASSWORD`：镜像仓库认证

### 大镜像测试（可选）
- `ENABLE_LARGE_IMAGE_BUILD_TEST`：`1` 时执行大镜像构建
- `TEMPLATE_LARGE_IMAGE`：大镜像地址（必填）
- `TEMPLATE_LARGE_ALIAS`：大镜像模板别名（默认 `large-image-test`）
- `TEMPLATE_LARGE_CPU` / `TEMPLATE_LARGE_MEMORY_MB`：构建资源配置

### 网络测试
- `NETWORK_WEB_HOST`：用于 curl 校验的主机（默认 `www.baidu.com`）
- `NETWORK_MAX_SECONDS`：curl 超时阈值（秒，默认 `12`）

### Git 测试
- `GIT_TEST_REPO`：克隆的 Git 仓库（默认 `https://github.com/octocat/Hello-World.git`）

### 性能参数（单模板）
- `SINGLE_TEMPLATE_ID`：单模板并发测试所用模板
- `SINGLE_CONCURRENT_COUNT`：单模板并发数

### 稳定性测试（可选，`ENABLE_STRESS_TEST=1` 启用）
- `ENABLE_STRESS_TEST`：`1` 时在 performance 阶段追加长时间稳定性测试
- `STRESS_SANDBOX_COUNT`：stress-100 创建的 sandbox 数（默认 100）
- `STRESS_TRAFFIC_VUS`：stress-100 流量并发数（默认 100）
- `STRESS_TRAFFIC_DURATION`：stress-100 流量持续时间（默认 `3m`）
- `MULTI_TEMPLATE_STRESS_DURATION`：多模板压力测试持续时间（默认 `30m`）
- `MULTI_TEMPLATE_STRESS_RATE`：多模板压力请求速率（请求/分钟，默认 60）

### 性能参数（多模板）
- `MULTI_TEMPLATE_LIST`：多模板候选列表，逗号分隔
- `MULTI_TEMPLATES_PER_TEST`：本次测试实际使用模板数
- `MULTI_SANDBOXES_PER_TEMPLATE`：每个模板创建的 sandbox 数
- `MULTI_CONCURRENT_COUNT`：多模板场景并发数

## 7. 执行流程

### 冒烟测试
- 创建 1 个 sandbox
- 执行简单命令、读写
- 停止/销毁 sandbox
- 输出简报（PASS/FAIL）

### 功能测试
1. 构建模板（`test_template.py`）
2. 创建 sandbox，pre-pause 读写检查
3. pause/resume 后再次验证（`test_sandbox_resume.py`）
4. tail 流重连（`test_sandbox_tail_reconnect.py`）
5. 网络访问（DNS、curl）
6. Git 克隆
7. 错误路径（读不存在文件、无效命令）
8. 沙箱隔离
9. 大镜像构建（`ENABLE_LARGE_IMAGE_BUILD_TEST=1` 时）

### 性能测试
- 检查所需模板是否存在，不存在则自动 build
- 运行单模板并发创建
- 运行多模板并发创建
- （可选）`ENABLE_STRESS_TEST=1` 时追加：
  - **stress-100**：创建 N 个 sandbox，持续发流量（默认 3m）
  - **multi-template-stress**：多模板长时间压力测试（默认 30m）
- 生成报告和日志

### 报告与状态定义

**报告路径**：
- 总报告：`results/automation-report-*.md`
- 步骤日志：`results/*.log`

**步骤状态**：
- `PASS`：执行成功
- `WARN_TIMEOUT`：超时告警，不计入失败
- `WARN_THRESHOLD`：性能阈值未达标，不计入失败
- `FAIL_ERROR`：执行错误，影响退出码

**汇总字段**：
- passed / warned / failed
- warned_timeout / warned_threshold / failed_error
