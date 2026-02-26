import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const deleteDuration = new Trend('delete_duration');
const createDuration = new Trend('create_duration');
const totalDuration = new Trend('total_duration'); // 从创建到删除完成的总耗时
const sandboxCreated = new Counter('sandboxes_created');
const sandboxDeleted = new Counter('sandboxes_deleted');
const deleteFailed = new Counter('delete_failed');
const totalSandboxesFound = new Counter('total_sandboxes_found');

// 从环境变量读取配置
const CONCURRENT_DELETE_VUS = parseInt(__ENV.CONCURRENT_COUNT || __ENV.VUS || '50', 10);
const CREATE_COUNT = parseInt(__ENV.CREATE_COUNT || '0', 10); // 如果设置，先创建指定数量的sandbox
const TEMPLATE_ID = __ENV.TEMPLATE_ID || 'base';

// 根据是否需要创建sandbox来动态构建scenarios
const scenarios = {};

if (CREATE_COUNT > 0) {
    // 如果需要先创建sandbox，添加创建场景
    scenarios.create_sandboxes = {
        executor: 'per-vu-iterations',
        vus: CREATE_COUNT,
        iterations: 1,
        maxDuration: '10m',
        exec: 'createSandboxes',
    };
    scenarios.fetch_sandboxes = {
        executor: 'shared-iterations',
        vus: 1,
        iterations: 1,
        maxDuration: '30s',
        exec: 'fetchSandboxes',
        startTime: '30s', // 创建完成后等待30秒再获取列表
    };
    scenarios.delete_all = {
        executor: 'constant-vus',
        vus: CONCURRENT_DELETE_VUS,
        duration: '10m',
        exec: 'deleteSandboxes',
        startTime: '35s', // 获取列表5秒后开始删除
        gracefulStop: '10s',
    };
} else {
    // 不需要创建，直接从现有列表删除
    scenarios.fetch_sandboxes = {
        executor: 'shared-iterations',
        vus: 1,
        iterations: 1,
        maxDuration: '30s',
        exec: 'fetchSandboxes',
    };
    scenarios.delete_all = {
        executor: 'constant-vus',
        vus: CONCURRENT_DELETE_VUS,
        duration: '5m',
        exec: 'deleteSandboxes',
        startTime: '3s',
        gracefulStop: '10s',
    };
}

export const options = {
    scenarios: scenarios,
    thresholds: {
        delete_duration: ['p(50)<1000', 'p(95)<5000', 'p(99)<10000'],
        http_req_failed: ['rate<0.1'],
        errors: ['rate<0.1'],
    },
};

const API_BASE_URL = __ENV.E2B_API_URL || __ENV.API_BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.E2B_API_KEY || __ENV.API_KEY || '';

if (!API_KEY) {
    throw new Error('E2B_API_KEY or API_KEY is required for quick delete all test');
}

// 全局共享的sandbox列表（在fetch阶段填充）
let sandboxIds = [];
let nextIndex = 0; // 使用原子性更好的方式
let testStartTime = Date.now(); // 测试开始时间（在setup阶段设置）
let deleteStartTime = null; // 删除开始时间
let deleteEndTime = null; // 删除结束时间
let allDeleted = false; // 标记是否全部删除完成

export function setup() {
    // 记录测试开始时间
    testStartTime = Date.now();
    return {};
}

export function createSandboxes() {
    const createStartTime = Date.now();
    const payload = JSON.stringify({
        templateID: TEMPLATE_ID,
        timeout: 300,
    });

    const res = http.post(`${API_BASE_URL}/sandboxes`, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'CreateSandbox' },
    });

    const createDurationMs = Date.now() - createStartTime;
    createDuration.add(createDurationMs);

    const success = check(res, {
        'create sandbox status is 201 or 200': (r) => r.status === 201 || r.status === 200,
    });

    if (success) {
        try {
            const body = JSON.parse(res.body);
            const sandboxId = body.sandboxID || body.id || body.data?.sandboxID || body.data?.id;
            sandboxCreated.add(1);
            console.log(`[创建] ${sandboxId} (${createDurationMs}ms)`);
        } catch (e) {
            console.error('Failed to parse sandbox response:', e);
            errorRate.add(1);
        }
    } else {
        errorRate.add(1);
        console.error(`创建失败: HTTP ${res.status}`);
    }
}

export function fetchSandboxes() {
    console.log('正在获取所有 Sandbox 列表...');

    const res = http.get(`${API_BASE_URL}/sandboxes`, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'ListSandboxes' },
    });

    if (res.status !== 200) {
        console.error(`获取 Sandbox 列表失败: HTTP ${res.status}`);
        errorRate.add(1);
        return;
    }

    try {
        const body = JSON.parse(res.body);
        let sandboxes = [];

        if (body.data && Array.isArray(body.data)) {
            sandboxes = body.data;
        } else if (Array.isArray(body)) {
            sandboxes = body;
        }

        sandboxIds = sandboxes
            .map(sb => sb.sandboxID || sb.id)
            .filter(Boolean);

        totalSandboxesFound.add(sandboxIds.length);
        console.log(`找到 ${sandboxIds.length} 个 Sandbox，准备并发删除...`);
        console.log(`Sandbox IDs: ${sandboxIds.slice(0, 10).join(', ')}${sandboxIds.length > 10 ? '...' : ''}`);

        // 记录删除开始时间
        if (deleteStartTime === null) {
            deleteStartTime = Date.now();
            console.log(`删除开始时间: ${new Date(deleteStartTime).toISOString()}`);
        }
    } catch (e) {
        console.error('解析 Sandbox 列表失败:', e);
        errorRate.add(1);
    }
}

export function deleteSandboxes() {
    // 如果列表为空，等待获取
    if (sandboxIds.length === 0) {
        sleep(1);
        return;
    }

    // 记录删除开始时间（第一次进入时）
    if (deleteStartTime === null) {
        deleteStartTime = Date.now();
    }

    // 使用 VU 编号和当前时间戳的组合来选择要删除的 sandbox
    // 这样可以减少并发冲突，虽然不能完全避免
    const vuId = __VU || 1;
    const timestamp = Date.now();
    const selectedIndex = (vuId * 997 + nextIndex + Math.floor(timestamp % 1000)) % sandboxIds.length;
    const sandboxId = sandboxIds[selectedIndex];

    if (!sandboxId) {
        sleep(0.5);
        return;
    }

    // 原子性更新索引（虽然不是完全原子，但在实际使用中足够好）
    nextIndex = (selectedIndex + 1) % sandboxIds.length;

    const deleteRequestStartTime = Date.now();

    try {
        const res = http.del(`${API_BASE_URL}/sandboxes/${sandboxId}`, null, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY,
            },
            tags: { name: 'DeleteSandbox' },
        });

        const success = check(res, {
            'delete sandbox status is valid': (r) => r.status === 204 || r.status === 200 || r.status === 404,
        });

        const deleteDurationMs = Date.now() - deleteRequestStartTime;

        if (success) {
            deleteDuration.add(deleteDurationMs);
            sandboxDeleted.add(1);

            // 404也算成功（可能已经被其他VU删除了）
            if (res.status === 404) {
                // 静默处理 404，因为可能已被其他 VU 删除
                return;
            }

            // 输出结构化记录
            const record = {
                type: 'delete_record',
                sandboxId: sandboxId,
                deleteDuration: deleteDurationMs,
                success: true,
                httpStatus: res.status,
                timestamp: new Date().toISOString(),
            };
            console.log(`[删除] ${sandboxId} (${deleteDurationMs}ms)`);
            console.log(`DELETE_RECORD:${JSON.stringify(record)}`);
        } else {
            errorRate.add(1);
            deleteFailed.add(1);

            const record = {
                type: 'delete_record',
                sandboxId: sandboxId,
                deleteDuration: deleteDurationMs,
                success: false,
                httpStatus: res.status,
                error: `HTTP ${res.status}`,
                timestamp: new Date().toISOString(),
            };
            console.log(`DELETE_RECORD:${JSON.stringify(record)}`);
        }
    } catch (error) {
        errorRate.add(1);
        deleteFailed.add(1);
        const deleteDurationMs = Date.now() - deleteRequestStartTime;

        const record = {
            type: 'delete_record',
            sandboxId: sandboxId,
            deleteDuration: deleteDurationMs,
            success: false,
            error: error.toString(),
            timestamp: new Date().toISOString(),
        };
        console.log(`DELETE_RECORD:${JSON.stringify(record)}`);
    }

    sleep(0.1); // 短暂休息，避免过快
}

export function teardown(data) {
    // 在测试结束时计算总耗时
    if (CREATE_COUNT > 0 && testStartTime && deleteStartTime && !allDeleted) {
        const endTime = Date.now();
        const totalTime = endTime - testStartTime;
        totalDuration.add(totalTime);
        allDeleted = true;
    }
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonOutput = JSON.stringify(data, null, 2);
    const textOutput = textSummary(data);

    // 尝试使用 OUTPUT_DIR 环境变量，否则使用 /tmp
    const outputDir = __ENV.OUTPUT_DIR || '/tmp/e2b-load-test-results';
    const filename = `quick-delete-all-summary-${timestamp}.json`;
    const jsonFilePath = `${outputDir}/${filename}`;

    // 在summary中添加总耗时（如果还没计算）
    if (CREATE_COUNT > 0 && testStartTime && deleteStartTime) {
        const endTime = Date.now();
        const totalTime = endTime - testStartTime;
        // 如果 metrics 中没有总耗时，手动添加
        if (!data.metrics || !data.metrics.total_duration || !data.metrics.total_duration.values) {
            totalDuration.add(totalTime);
        }
    }

    return {
        'stdout': textOutput,
        [jsonFilePath]: jsonOutput,
    };
}

function textSummary(data) {
    let summary = `\n一键删除所有 Sandbox 压测结果\n`;
    summary += '====================================\n';
    if (CREATE_COUNT > 0) {
        summary += `场景: 创建 ${CREATE_COUNT} 个 Sandbox 后，一次性删除（删除并发数: ${CONCURRENT_DELETE_VUS}）\n`;
    } else {
        summary += `场景: 删除现有所有 Sandbox（删除并发数: ${CONCURRENT_DELETE_VUS}）\n`;
    }
    summary += '====================================\n\n';

    const safeGet = (metric, defaultValue = 0) => {
        if (!data.metrics || !data.metrics[metric] || !data.metrics[metric].values) {
            return defaultValue;
        }
        return data.metrics[metric].values;
    };

    // 创建阶段统计
    if (CREATE_COUNT > 0) {
        const created = safeGet('sandboxes_created', { count: 0 });
        const createDuration = safeGet('create_duration');
        summary += `创建阶段:\n`;
        summary += `  - 创建数量: ${created.count || 0} / ${CREATE_COUNT}\n`;
        if (createDuration && createDuration.avg !== undefined) {
            summary += `  - 创建平均耗时: ${(createDuration.avg || 0).toFixed(2)}ms\n`;
        }
        summary += '\n';
    }

    // 删除阶段统计
    const found = safeGet('total_sandboxes_found', { count: 0 });
    const deleted = safeGet('sandboxes_deleted', { count: 0 });
    const failed = safeGet('delete_failed', { count: 0 });
    const errors = safeGet('errors', { rate: 0 });

    summary += `删除阶段:\n`;
    summary += `  - 发现的 Sandbox 总数: ${found.count || 0}\n`;
    summary += `  - 成功删除数: ${deleted.count || 0}\n`;
    summary += `  - 删除失败数: ${failed.count || 0}\n`;
    summary += `  - 错误率: ${((errors.rate || 0) * 100).toFixed(2)}%\n`;

    if (found.count > 0) {
        const successRate = ((deleted.count / found.count) * 100).toFixed(2);
        summary += `  - 删除成功率: ${successRate}%\n`;
        if (deleted.count < found.count) {
            summary += `  - 注意: 还有 ${found.count - deleted.count} 个 Sandbox 未被删除\n`;
        }
    }
    summary += '\n';

    // 总耗时统计（仅在有创建阶段时显示）
    if (CREATE_COUNT > 0 && testStartTime) {
        // 计算实际的总耗时（从测试开始到当前时间，减去删除开始前的时间差）
        const currentTime = Date.now();
        let actualTotalTime = 0;

        if (deleteStartTime) {
            // 如果删除已经开始，总耗时 = 删除开始时间 - 测试开始时间 + 预计删除完成时间
            // 这里简化处理，使用当前时间作为结束时间
            actualTotalTime = currentTime - testStartTime;
        } else {
            // 如果删除还没开始，总耗时 = 当前时间 - 测试开始时间
            actualTotalTime = currentTime - testStartTime;
        }

        // 尝试从metrics获取，如果没有则使用计算值
        const totalDuration = safeGet('total_duration');
        let totalTimeMs = actualTotalTime;
        if (totalDuration && totalDuration.avg !== undefined) {
            totalTimeMs = totalDuration.avg;
        }

        summary += `总耗时（从创建开始到测试结束）:\n`;
        summary += `  - 总耗时: ${(totalTimeMs / 1000).toFixed(2)}s (${totalTimeMs.toFixed(0)}ms)\n`;
        if (deleteStartTime) {
            const deleteTimeMs = deleteStartTime - testStartTime;
            summary += `  - 创建阶段耗时: ${(deleteTimeMs / 1000).toFixed(2)}s (${deleteTimeMs.toFixed(0)}ms)\n`;
            const remainingTimeMs = totalTimeMs - deleteTimeMs;
            summary += `  - 删除阶段耗时: ${(remainingTimeMs / 1000).toFixed(2)}s (${remainingTimeMs.toFixed(0)}ms)\n`;
        }
        summary += '\n';
    }

    const deleteDuration = safeGet('delete_duration');
    if (deleteDuration && deleteDuration.avg !== undefined && deleteDuration.avg > 0) {
        summary += `删除耗时统计:\n`;
        summary += `  - 平均: ${(deleteDuration.avg || 0).toFixed(2)}ms\n`;
        summary += `  - 最小: ${(deleteDuration.min || 0).toFixed(2)}ms\n`;
        summary += `  - 最大: ${(deleteDuration.max || 0).toFixed(2)}ms\n`;
        if (deleteDuration['p(25)'] !== undefined) {
            summary += `  - P25: ${deleteDuration['p(25)'].toFixed(2)}ms\n`;
        }
        if (deleteDuration['p(50)'] !== undefined) {
            summary += `  - P50: ${deleteDuration['p(50)'].toFixed(2)}ms\n`;
        }
        if (deleteDuration['p(75)'] !== undefined) {
            summary += `  - P75: ${deleteDuration['p(75)'].toFixed(2)}ms\n`;
        }
        if (deleteDuration['p(90)'] !== undefined) {
            summary += `  - P90: ${deleteDuration['p(90)'].toFixed(2)}ms\n`;
        }
        if (deleteDuration['p(95)'] !== undefined) {
            summary += `  - P95: ${deleteDuration['p(95)'].toFixed(2)}ms\n`;
        }
        if (deleteDuration['p(99)'] !== undefined) {
            summary += `  - P99: ${deleteDuration['p(99)'].toFixed(2)}ms\n`;
        }
        summary += '\n';
    }

    return summary;
}

