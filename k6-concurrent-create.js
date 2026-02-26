import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const createDuration = new Trend('create_duration');
const readyDuration = new Trend('ready_duration');
const totalDuration = new Trend('total_duration');
const sandboxCreated = new Counter('sandboxes_created');
const sandboxReady = new Counter('sandboxes_ready');
const sandboxFailed = new Counter('sandboxes_failed');

const CONCURRENT_COUNT = parseInt(__ENV.CONCURRENT_COUNT || __ENV.VUS || '10', 10);

export const options = {
    scenarios: {
        [`create_${CONCURRENT_COUNT}_sandboxes`]: {
            executor: 'per-vu-iterations',
            vus: CONCURRENT_COUNT,
            iterations: 1,
            maxDuration: '5m',
        },
    },
    thresholds: {
        create_duration: ['p(50)<3000', 'p(95)<10000', 'p(99)<20000'],
        ready_duration: ['p(50)<10000', 'p(95)<30000', 'p(99)<60000'],
        total_duration: ['p(50)<15000', 'p(95)<40000', 'p(99)<80000'],
        http_req_failed: ['rate<0.1'],
        errors: ['rate<0.1'],
    },
};

const API_BASE_URL = __ENV.E2B_API_URL || __ENV.API_BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.E2B_API_KEY || __ENV.API_KEY || '';
const TEMPLATE_ID = __ENV.TEMPLATE_ID || 'base';
const MAX_WAIT_TIME = parseInt(__ENV.MAX_WAIT_TIME || '180000');

if (!API_KEY) {
    throw new Error('E2B_API_KEY or API_KEY is required for concurrent create test');
}

export default function () {
    const totalStartTime = Date.now();
    const createStartTime = Date.now();
    let sandboxId = null;

    try {
        // 1. 创建 sandbox
        const createRes = createSandbox();
        if (!createRes.success || !createRes.sandboxId) {
            errorRate.add(1);
            sandboxFailed.add(1);
            const failRecord = {
                type: 'sandbox_record',
                sandboxId: null,
                createDuration: Date.now() - createStartTime,
                readyDuration: 0,
                totalDuration: Date.now() - totalStartTime,
                success: false,
                error: createRes.error || 'Create failed',
                httpStatus: createRes.status || null,
                timestamp: new Date().toISOString(),
            };
            console.log(`SANDBOX_RECORD:${JSON.stringify(failRecord)}`);
            return;
        }

        sandboxId = createRes.sandboxId;
        const createDurationMs = Date.now() - createStartTime;
        createDuration.add(createDurationMs);
        sandboxCreated.add(1);

        // 2. 等待 sandbox ready
        const readyStartTime = Date.now();
        const ready = waitForSandboxReady(sandboxId);

        if (!ready) {
            errorRate.add(1);
            sandboxFailed.add(1);
            const timeoutRecord = {
                type: 'sandbox_record',
                sandboxId: sandboxId,
                createDuration: createDurationMs,
                readyDuration: Date.now() - readyStartTime,
                totalDuration: Date.now() - totalStartTime,
                success: false,
                error: 'Ready timeout or failed',
                timestamp: new Date().toISOString(),
            };
            console.log(`SANDBOX_RECORD:${JSON.stringify(timeoutRecord)}`);
            return;
        }

        const readyDurationMs = Date.now() - readyStartTime;
        readyDuration.add(readyDurationMs);
        sandboxReady.add(1);

        const totalDurationMs = Date.now() - totalStartTime;
        totalDuration.add(totalDurationMs);

        const record = {
            type: 'sandbox_record',
            sandboxId: sandboxId,
            createDuration: createDurationMs,
            readyDuration: readyDurationMs,
            totalDuration: totalDurationMs,
            success: true,
            error: null,
            timestamp: new Date().toISOString(),
        };

        console.log(`[${sandboxId}] 创建耗时: ${createDurationMs}ms | 就绪耗时: ${readyDurationMs}ms | 总耗时: ${totalDurationMs}ms`);
        console.log(`SANDBOX_RECORD:${JSON.stringify(record)}`);

    } catch (error) {
        errorRate.add(1);
        sandboxFailed.add(1);
        const errorRecord = {
            type: 'sandbox_record',
            sandboxId: sandboxId,
            createDuration: sandboxId ? Date.now() - createStartTime : 0,
            readyDuration: 0,
            totalDuration: Date.now() - totalStartTime,
            success: false,
            error: error.toString(),
            timestamp: new Date().toISOString(),
        };
        console.log(`SANDBOX_RECORD:${JSON.stringify(errorRecord)}`);
        console.error(`Error creating sandbox: ${error}`);
    }
}

function createSandbox() {
    const payload = JSON.stringify({
        templateID: TEMPLATE_ID,
        timeout: 60,
    });

    const res = http.post(`${API_BASE_URL}/sandboxes`, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'CreateSandbox' },
    });

    const success = check(res, {
        'create sandbox status is 201 or 200': (r) => r.status === 201 || r.status === 200,
    });

    let sandboxId = null;
    if (success) {
        try {
            const body = JSON.parse(res.body);
            sandboxId = body.sandboxID || body.id || body.data?.sandboxID || body.data?.id;
        } catch (e) {
            console.error('Failed to parse sandbox response:', e);
        }
    } else {
        // 输出详细的错误信息用于调试
        let errorMsg = `HTTP ${res.status}`;
        try {
            const errorBody = JSON.parse(res.body);
            if (errorBody.message || errorBody.error) {
                errorMsg += `: ${errorBody.message || errorBody.error}`;
            } else {
                errorMsg += `: ${res.body.substring(0, 200)}`;
            }
        } catch (e) {
            errorMsg += `: ${res.body.substring(0, 200)}`;
        }
        console.error(`Create sandbox failed - ${errorMsg}`);
    }

    return { success, sandboxId, status: res.status, error: success ? null : `HTTP ${res.status}` };
}

function waitForSandboxReady(sandboxId, maxWaitMs = MAX_WAIT_TIME) {
    const startTime = Date.now();
    const pollInterval = 2000;
    let lastStatus = 'unknown';
    let pollCount = 0;

    while (Date.now() - startTime < maxWaitMs) {
        const res = getSandboxDetails(sandboxId);
        pollCount++;

        if (res.success && (res.status === 'ready' || res.status === 'running')) {
            return true;
        }

        if (res.status === 'failed' || res.status === 'not_found') {
            console.log(`Sandbox ${sandboxId} failed or not found, status: ${res.status}`);
            return false;
        }

        if (res.status !== lastStatus) {
            console.log(`Sandbox ${sandboxId} status changed: ${lastStatus} -> ${res.status}`);
            lastStatus = res.status;
        }

        if (pollCount % 10 === 0) {
            const elapsed = Date.now() - startTime;
            console.log(`Sandbox ${sandboxId} still waiting... status=${res.status}, elapsed=${elapsed}ms`);
        }

        sleep(pollInterval / 1000);
    }

    const elapsed = Date.now() - startTime;
    console.log(`Sandbox ${sandboxId} timeout after ${elapsed}ms, last status: ${lastStatus}`);
    return false;
}

function getSandboxDetails(sandboxId) {
    const res = http.get(`${API_BASE_URL}/sandboxes/${sandboxId}`, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'GetSandboxDetails' },
    });

    if (res.status === 404) {
        return { success: false, status: 'not_found' };
    }

    const success = check(res, {
        'get sandbox status is 200': (r) => r.status === 200,
    });

    let status = 'unknown';
    if (success) {
        try {
            const body = JSON.parse(res.body);
            status = body.state || body.status || body.State || body.Status || 'unknown';
            status = status.toLowerCase();
        } catch (e) {
            console.error('Failed to parse sandbox details:', e);
        }
    }

    return { success, status };
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonOutput = JSON.stringify(data, null, 2);
    const textOutput = textSummary(data);

    const outputDir = __ENV.OUTPUT_DIR || '/tmp/e2b-load-test-results';
    const filename = `concurrent-create-summary-${timestamp}.json`;

    const jsonFilePath = `${outputDir}/${filename}`;

    return {
        'stdout': textOutput,
        [jsonFilePath]: jsonOutput,
    };
}

function textSummary(data) {
    // 获取实际的并发数量（从 metrics 或环境变量）
    const actualCount = data.metrics?.sandboxes_created?.values?.count || CONCURRENT_COUNT;
    let summary = `\n并发创建 ${CONCURRENT_COUNT} 个 Sandbox 压测结果\n`;
    summary += '====================================\n\n';

    // 安全访问 metrics，防止 undefined 错误
    const safeGet = (metric, defaultValue = 0) => {
        if (!data.metrics || !data.metrics[metric] || !data.metrics[metric].values) {
            return defaultValue;
        }
        return data.metrics[metric].values;
    };

    const created = safeGet('sandboxes_created', { count: 0 });
    const ready = safeGet('sandboxes_ready', { count: 0 });
    const failed = safeGet('sandboxes_failed', { count: 0 });
    const errors = safeGet('errors', { rate: 0 });

    // 总请求数 = 成功创建数 + 失败数
    const totalRequests = (created.count || 0) + (failed.count || 0);
    // 如果总请求数为0，使用配置的并发数
    const actualTotal = totalRequests > 0 ? totalRequests : CONCURRENT_COUNT;

    // 创建成功率 = 成功创建数 / 总请求数
    const createSuccessRate = actualTotal > 0 ? ((created.count || 0) / actualTotal * 100).toFixed(2) : '0.00';
    // 就绪成功率 = 成功就绪数 / 成功创建数（如果创建成功）
    const readySuccessRate = created.count > 0 ? ((ready.count || 0) / created.count * 100).toFixed(2) : '0.00';
    // 总体成功率 = 成功就绪数 / 总请求数
    const overallSuccessRate = actualTotal > 0 ? ((ready.count || 0) / actualTotal * 100).toFixed(2) : '0.00';

    summary += `总请求数: ${actualTotal}\n`;
    summary += `成功创建数: ${created.count || 0}\n`;
    summary += `成功就绪数: ${ready.count || 0}\n`;
    summary += `失败数: ${failed.count || 0}\n`;
    summary += `创建成功率: ${createSuccessRate}%\n`;
    summary += `就绪成功率: ${readySuccessRate}% (基于成功创建的)\n`;
    summary += `总体成功率: ${overallSuccessRate}% (就绪数/总请求数)\n`;
    summary += `错误率: ${((errors.rate || 0) * 100).toFixed(2)}%\n\n`;

    // 创建耗时统计
    const createDuration = safeGet('create_duration');
    if (createDuration && createDuration.avg !== undefined) {
        summary += `创建耗时统计:\n`;
        summary += `  - 平均: ${(createDuration.avg || 0).toFixed(2)}ms\n`;
        summary += `  - 最小: ${(createDuration.min || 0).toFixed(2)}ms\n`;
        summary += `  - 最大: ${(createDuration.max || 0).toFixed(2)}ms\n`;
        if (createDuration['p(90)'] !== undefined) {
            summary += `  - P90: ${createDuration['p(90)'].toFixed(2)}ms\n`;
        }
        const p99 = createDuration['p(99)'] !== undefined ? createDuration['p(99)'] :
            (createDuration.p99 !== undefined ? createDuration.p99 : undefined);
        if (p99 !== undefined) {
            summary += `  - P99: ${p99.toFixed(2)}ms\n`;
        } else {
            summary += `  - P99: ${(createDuration.max || 0).toFixed(2)}ms (使用最大值近似)\n`;
        }
        summary += '\n';
    }

    // 就绪耗时统计
    const readyDuration = safeGet('ready_duration');
    if (readyDuration && readyDuration.avg !== undefined && readyDuration.avg > 0) {
        summary += `就绪耗时统计:\n`;
        summary += `  - 平均: ${(readyDuration.avg || 0).toFixed(2)}ms\n`;
        summary += `  - 最小: ${(readyDuration.min || 0).toFixed(2)}ms\n`;
        summary += `  - 最大: ${(readyDuration.max || 0).toFixed(2)}ms\n`;
        if (readyDuration['p(90)'] !== undefined) {
            summary += `  - P90: ${readyDuration['p(90)'].toFixed(2)}ms\n`;
        }
        const p99 = readyDuration['p(99)'] !== undefined ? readyDuration['p(99)'] :
            (readyDuration.p99 !== undefined ? readyDuration.p99 : undefined);
        if (p99 !== undefined) {
            summary += `  - P99: ${p99.toFixed(2)}ms\n`;
        } else {
            summary += `  - P99: ${(readyDuration.max || 0).toFixed(2)}ms (使用最大值近似)\n`;
        }
        summary += '\n';
    }

    // 总耗时统计
    const totalDuration = safeGet('total_duration');
    if (totalDuration && totalDuration.avg !== undefined && totalDuration.avg > 0) {
        summary += `总耗时统计（创建+就绪）:\n`;
        summary += `  - 平均: ${(totalDuration.avg || 0).toFixed(2)}ms\n`;
        summary += `  - 最小: ${(totalDuration.min || 0).toFixed(2)}ms\n`;
        summary += `  - 最大: ${(totalDuration.max || 0).toFixed(2)}ms\n`;
        if (totalDuration['p(90)'] !== undefined) {
            summary += `  - P90: ${totalDuration['p(90)'].toFixed(2)}ms\n`;
        }
        const p99 = totalDuration['p(99)'] !== undefined ? totalDuration['p(99)'] :
            (totalDuration.p99 !== undefined ? totalDuration.p99 : undefined);
        if (p99 !== undefined) {
            summary += `  - P99: ${p99.toFixed(2)}ms\n`;
        } else {

            summary += `  - P99: ${(totalDuration.max || 0).toFixed(2)}ms (使用最大值近似)\n`;
        }
        summary += '\n';
    }

    // 如果有失败，提示查看日志了解详细原因
    if (failed.count > 0) {
        summary += '提示: 有失败的请求，请查看日志文件了解详细错误信息。\n';
        summary += '     日志文件位置: /tmp/e2b-load-test-results/k6-concurrent-create-*.log\n';
        summary += '     可以运行: grep "Create sandbox failed" /tmp/e2b-load-test-results/k6-concurrent-create-*.log | head -20\n';
        summary += '     或者查看: grep "SANDBOX_RECORD" /tmp/e2b-load-test-results/k6-concurrent-create-*.log | grep "success.*false"\n\n';
    }

    return summary;
}