1. 测试目标
- 验证模板构建流程可用（build 能成功）
- 验证 sandbox 生命周期核心能力（创建、写读、pause、resume、销毁）
- 验证并发创建能力（单模板与多模板）
- 输出统一测试报告与步骤日志，便于复盘和 CI 接入
2. 脚本入口
- 主入口：test-automation.sh
- 子脚本：
  - test_template.py
  - test_sandbox_create.py
  - test_sandbox_resume.py
  - run-all-tests.sh
  - k6-concurrent-create.js
  - k6-concurrent-create-multi-template.js
3. 模式说明
- smoke：快速冒烟（创建、命令执行、读写、销毁）
- functional：功能测试（模板构建 + 生命周期链路）
- performance：性能测试（单模板并发 + 多模板并发）
- all：functional + performance（推荐“全量”）
4. 常用命令
冒烟测试
```bash
TEMPLATE_ID=test ./test-automation.sh smoke "" "$E2B_API_KEY"
```
功能测试
```bash
TEMPLATE_ID=test ./test-automation.sh functional "" "$E2B_API_KEY"
```
性能测试
```bash
SINGLE_TEMPLATE_ID=test \
SINGLE_CONCURRENT_COUNT=60 \
MULTI_TEMPLATE_LIST="test1,test2,test3" \
MULTI_TEMPLATES_PER_TEST=3 \
MULTI_SANDBOXES_PER_TEMPLATE=20 \
MULTI_CONCURRENT_COUNT=60 \
./test-automation.sh performance "" "$E2B_API_KEY"
```
功能 + 性能（all)
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
5. 参数说明
通用参数
- TEMPLATE_ID：功能测试默认模板别名
- 第 2 个位置参数：API_URL（可传空字符串，使用环境变量）
- 第 3 个位置参数：API_KEY（一般传 "$E2B_API_KEY"）
性能参数（单模板）
- SINGLE_TEMPLATE_ID：单模板并发测试所用模板
- SINGLE_CONCURRENT_COUNT：单模板并发数
性能参数（多模板）
- MULTI_TEMPLATE_LIST：多模板候选列表，逗号分隔
- MULTI_TEMPLATES_PER_TEST：本次测试实际使用模板数
- MULTI_SANDBOXES_PER_TEMPLATE：每个模板创建的 sandbox 数
- MULTI_CONCURRENT_COUNT：多模板场景并发数
6. 执行流程
冒烟测试
- 创建 1 个 sandbox
- 执行简单命令(read/write)
- 停止/销毁 sandbox
- 输出简报（PASS/FAIL）
功能测试
- 构建模板（test_template.py）
- 创建 sandbox 并进行读写检查
- pause/resume 后再次验证
- 生成报告和日志
性能测试
检查性能
- 测试需要的模板是否存在，不存在则自动 build
- 运行单模板并发创建
- 运行多模板并发创建
- 生成报告和日志
- 报告与状态定义
报告路径：
- 总报告：results/automation-report-*.md
- 步骤日志：results/*.log
步骤状态：
- PASS：执行成功，且没有被识别为阈值/超时问题
- WARN_THRESHOLD：执行成功但性能阈值未达标（告警，不计入失败）
- FAIL_ERROR：执行错误（计入失败，并影响退出码）
汇总字段：
- passed：通过数
- warned：告警数
- failed：失败数（仅硬失败）
