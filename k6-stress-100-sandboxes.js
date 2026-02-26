import { check, sleep } from 'k6';
import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const requestDuration = new Trend('request_duration');
const createDuration = new Trend('create_duration');
const sandboxCreated = new Counter('sandboxes_created');
const sandboxReady = new Counter('sandboxes_ready');
const requestsSent = new Counter('requests_sent');
const requestsFailed = new Counter('requests_failed');
const availableSandboxes = new Counter('available_sandboxes'); // 记录可用的sandbox数量
const uniqueSandboxesHit = new Set(); // 记录被请求的不同sandbox ID（用于日志显示）

// 从环境变量读取配置
const SANDBOX_COUNT = parseInt(__ENV.SANDBOX_COUNT || __ENV.CREATE_COUNT || '100', 10);
const TRAFFIC_VUS = parseInt(__ENV.TRAFFIC_VUS || __ENV.VUS || '100', 10);
const TRAFFIC_DURATION = __ENV.TRAFFIC_DURATION || '3m';

export const options = {
    scenarios: {
        // 第一步：创建指定数量的sandbox
        create_sandboxes: {
            executor: 'per-vu-iterations',
            vus: SANDBOX_COUNT,
            iterations: 1, // 每个VU创建1个sandbox
            maxDuration: '10m',
            exec: 'createSandboxes',
            gracefulStop: '0s',
        },
        // 第二步：等待sandbox就绪并获取列表
        fetch_sandboxes: {
            executor: 'shared-iterations',
            vus: 1,
            iterations: 1,
            maxDuration: '2m',
            exec: 'fetchReadySandboxes',
            startTime: '30s', // 创建30秒后开始获取列表（创建通常很快完成）
        },
        // 第三步：给所有sandbox均匀发流量
        send_traffic: {
            executor: 'constant-vus',
            vus: TRAFFIC_VUS,
            duration: TRAFFIC_DURATION,
            exec: 'sendTraffic',
            startTime: '1m', // 获取列表30秒后开始发送流量（给足够时间获取列表）
            gracefulStop: '10s',
        },
    },
    thresholds: {
        request_duration: ['p(95)<5000', 'p(99)<10000'],
        http_req_failed: ['rate<0.15'],
        errors: ['rate<0.15'],
    },
};

const API_BASE_URL = __ENV.E2B_API_URL || __ENV.API_BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.E2B_API_KEY || __ENV.API_KEY || '';
const TEMPLATE_ID = __ENV.TEMPLATE_ID || 'base';
const MAX_WAIT_TIME = parseInt(__ENV.MAX_WAIT_TIME || '180000', 10); // 3分钟超时

if (!API_KEY) {
    throw new Error('E2B_API_KEY or API_KEY is required for stress test');
}

// 全局共享的sandbox列表
let allSandboxIds = [];
let nextIndex = 0; // 用于轮询确保每个sandbox都被请求

export function setup() {
    return {};
}

export function createSandboxes() {
    const createStartTime = Date.now();
    let sandboxId = null;

    try {
        const payload = JSON.stringify({
            templateID: TEMPLATE_ID,
            timeout: 3600, // 1小时超时，确保压测期间不会过期
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
                sandboxId = body.sandboxID || body.id || body.data?.sandboxID || body.data?.id;
                if (sandboxId) {
                    sandboxCreated.add(1);
                    // 等待sandbox就绪
                    if (waitForSandboxReady(sandboxId)) {
                        sandboxReady.add(1);
                    }
                    console.log(`[创建] ${sandboxId} (${createDurationMs}ms)`);
                }
            } catch (e) {
                console.error('Failed to parse sandbox response:', e);
                errorRate.add(1);
            }
        } else {
            errorRate.add(1);
            console.error(`创建失败: HTTP ${res.status}`);
        }
    } catch (error) {
        errorRate.add(1);
        console.error(`创建错误: ${error}`);
    }
}

function waitForSandboxReady(sandboxId, maxWaitMs = MAX_WAIT_TIME) {
    const startTime = Date.now();
    const pollInterval = 2000; // 每2秒检查一次

    while (Date.now() - startTime < maxWaitMs) {
        const res = http.get(`${API_BASE_URL}/sandboxes/${sandboxId}`, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY,
            },
            tags: { name: 'GetSandboxStatus' },
        });

        if (res.status === 200) {
            try {
                const body = JSON.parse(res.body);
                const status = (body.state || body.status || '').toLowerCase();
                if (status === 'ready' || status === 'running') {
                    return true;
                }
                if (status === 'failed') {
                    return false;
                }
            } catch (e) {
                // 忽略解析错误，继续轮询
            }
        }

        sleep(pollInterval / 1000);
    }

    return false;
}

export function fetchReadySandboxes() {
    console.log('正在获取所有 ready 的 Sandbox 列表...');

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

        allSandboxIds = sandboxes
            .filter(sb => {
                const status = (sb.state || sb.status || 'unknown').toLowerCase();
                return status === 'ready' || status === 'running';
            })
            .map(sb => sb.sandboxID || sb.id)
            .filter(Boolean);

        // 记录可用的sandbox数量到metric中
        availableSandboxes.add(allSandboxIds.length);

        console.log(`找到 ${allSandboxIds.length} 个 ready 的 Sandbox，准备发送流量...`);
        if (allSandboxIds.length > 0) {
            console.log(`前10个 Sandbox IDs: ${allSandboxIds.slice(0, 10).join(', ')}${allSandboxIds.length > 10 ? '...' : ''}`);
            console.log(`[fetchReadySandboxes] allSandboxIds 已填充，长度: ${allSandboxIds.length}`);
        } else {
            console.warn(`[fetchReadySandboxes] 警告: 没有找到 ready 的 Sandbox！`);
        }
    } catch (e) {
        console.error('解析 Sandbox 列表失败:', e);
        errorRate.add(1);
    }
}

export function sendTraffic() {
    // 如果还没有sandbox列表，尝试获取一次（因为 k6 中 VU 之间不共享全局变量）
    if (allSandboxIds.length === 0) {
        // 尝试获取 sandbox 列表
        const res = http.get(`${API_BASE_URL}/sandboxes`, {
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': API_KEY,
            },
            tags: { name: 'ListSandboxes' },
        });

        if (res.status === 200) {
            try {
                const body = JSON.parse(res.body);
                let sandboxes = [];

                if (body.data && Array.isArray(body.data)) {
                    sandboxes = body.data;
                } else if (Array.isArray(body)) {
                    sandboxes = body;
                }

                allSandboxIds = sandboxes
                    .filter(sb => {
                        const status = (sb.state || sb.status || 'unknown').toLowerCase();
                        return status === 'ready' || status === 'running';
                    })
                    .map(sb => sb.sandboxID || sb.id)
                    .filter(Boolean);

                if (allSandboxIds.length > 0) {
                    console.log(`[sendTraffic VU${__VU || 1}] 获取到 ${allSandboxIds.length} 个 sandbox`);
                }
            } catch (e) {
                console.error(`[sendTraffic VU${__VU || 1}] 解析列表失败:`, e);
            }
        }

        // 如果还是没有，等待一下再重试
        if (allSandboxIds.length === 0) {
            sleep(1);
            return;
        }
    }

    // 轮询方式选择sandbox，确保所有sandbox都能被访问到
    // 使用 VU 编号和索引的组合来选择sandbox
    const vuId = __VU || 1;
    const timestamp = Date.now();
    const selectedIndex = (vuId * 997 + nextIndex + Math.floor(timestamp % 1000)) % allSandboxIds.length;
    const sandboxId = allSandboxIds[selectedIndex];
    nextIndex = (selectedIndex + 1) % allSandboxIds.length;

    if (!sandboxId) {
        sleep(0.5);
        return;
    }

    const requestStartTime = Date.now();

    try {
        // 随机选择请求类型，模拟真实场景
        const requestType = Math.random();
        let success = false;
        let duration = 0;

        if (requestType < 0.6) {
            // 60%: 获取sandbox详情（主要请求类型）
            const res = http.get(`${API_BASE_URL}/sandboxes/${sandboxId}`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': API_KEY,
                },
                tags: { name: 'GetSandboxDetails' },
            });

            duration = Date.now() - requestStartTime;

            // 404 可能是 sandbox 已过期被删除，这是正常情况，不算错误
            if (res.status === 404) {
                // Sandbox 可能已过期，从列表中移除（如果存在）
                const index = allSandboxIds.indexOf(sandboxId);
                if (index > -1) {
                    allSandboxIds.splice(index, 1);
                }
                // 不算错误，但也不算成功
                success = false;
            } else {
                success = check(res, {
                    'get sandbox status is 200': (r) => r.status === 200,
                });

                if (success) {
                    // 记录被请求的sandbox（使用简单的字符串记录）
                    uniqueSandboxesHit.add(sandboxId);
                }
            }
        } else if (requestType < 0.85) {
            // 25%: 列出所有sandboxes
            const res = http.get(`${API_BASE_URL}/sandboxes`, {
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': API_KEY,
                },
                tags: { name: 'ListSandboxes' },
            });

            success = check(res, {
                'list sandboxes status is 200': (r) => r.status === 200,
            });

            duration = Date.now() - requestStartTime;
        } else {
            // 15%: 健康检查
            const res = http.get(`${API_BASE_URL}/health`, {
                headers: { 'Content-Type': 'application/json' },
                tags: { name: 'HealthCheck' },
            });

            success = check(res, {
                'health check status is 200': (r) => r.status === 200,
            });

            duration = Date.now() - requestStartTime;
        }

        // 处理 404 情况：sandbox 可能已过期被删除，这是正常情况
        if (!success && requestType < 0.6) {
            // 对于 GetSandboxDetails 请求，404 不算错误（sandbox 可能已过期）
            // 其他请求的失败仍然算错误
            requestDuration.add(duration);
            // 不增加 requestsSent 和 errorRate，因为这是预期的行为
        } else if (success) {
            requestDuration.add(duration);
            requestsSent.add(1);
        } else {
            errorRate.add(1);
            requestsFailed.add(1);
            requestDuration.add(duration);
        }
    } catch (error) {
        errorRate.add(1);
        requestsFailed.add(1);
        const duration = Date.now() - requestStartTime;
        requestDuration.add(duration);
    }

    // 随机间隔，模拟真实用户行为
    sleep(Math.random() * 0.5 + 0.1); // 100-600ms
}

export function handleSummary(data) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jsonOutput = JSON.stringify(data, null, 2);
    const textOutput = textSummary(data);

    // 尝试使用 OUTPUT_DIR 环境变量，否则使用 /tmp
    const outputDir = __ENV.OUTPUT_DIR || '/tmp/e2b-load-test-results';
    const filename = `stress-${SANDBOX_COUNT}-sandboxes-summary-${timestamp}.json`;
    const jsonFilePath = `${outputDir}/${filename}`;

    return {
        'stdout': textOutput,
        [jsonFilePath]: jsonOutput,
    };
}

function textSummary(data) {
    let summary = `\n${SANDBOX_COUNT}个Sandbox流量压力测试结果\n`;
    summary += '====================================\n';
    summary += `场景: 创建 ${SANDBOX_COUNT} 个 Sandbox 后，同时发送流量（流量并发数: ${TRAFFIC_VUS}，持续时间: ${TRAFFIC_DURATION}）\n`;
    summary += '====================================\n\n';

    const safeGet = (metric, defaultValue = 0) => {
        if (!data.metrics || !data.metrics[metric] || !data.metrics[metric].values) {
            return defaultValue;
        }
        return data.metrics[metric].values;
    };

    // 创建阶段统计
    const created = safeGet('sandboxes_created', { count: 0 });
    const ready = safeGet('sandboxes_ready', { count: 0 });
    const createDuration = safeGet('create_duration');

    summary += `创建阶段:\n`;
    summary += `  - 创建的 Sandbox 数: ${created.count || 0} / ${SANDBOX_COUNT}\n`;
    summary += `  - 成功就绪数: ${ready.count || 0}\n`;
    if (createDuration && createDuration.avg !== undefined) {
        summary += `  - 创建平均耗时: ${(createDuration.avg || 0).toFixed(2)}ms\n`;
    }
    summary += '\n';

    // 流量发送统计
    const requests = safeGet('requests_sent', { count: 0 });
    const failed = safeGet('requests_failed', { count: 0 });
    const errors = safeGet('errors', { rate: 0 });
    const available = safeGet('available_sandboxes', { count: 0 });
    // 如果 available_sandboxes 为 0，尝试使用 sandboxReady 作为备用值
    // 因为如果获取列表失败，至少我们知道创建了多少个 ready 的 sandbox
    let availableCount = available.count || 0;
    if (availableCount === 0 && ready.count > 0) {
        availableCount = ready.count;
    }

    summary += `流量发送阶段:\n`;
    summary += `  - 可用的 Sandbox 数: ${availableCount}\n`;
    summary += `  - 发送请求总数: ${requests.count || 0}\n`;
    summary += `  - 失败请求数: ${failed.count || 0}\n`;

    // 计算请求失败率（基于实际请求数）
    let requestErrorRate = 0;
    if (requests.count > 0) {
        requestErrorRate = (failed.count / requests.count) * 100;
    }
    summary += `  - 请求失败率: ${requestErrorRate.toFixed(2)}%\n`;

    if (requests.count > 0) {
        const successRate = (((requests.count - failed.count) / requests.count) * 100).toFixed(2);
        summary += `  - 请求成功率: ${successRate}%\n`;
        // 估算每个sandbox的平均请求数
        if (availableCount > 0) {
            const avgRequestsPerSandbox = (requests.count / availableCount).toFixed(2);
            summary += `  - 平均每个Sandbox请求数: ${avgRequestsPerSandbox}\n`;
        }
    }
    summary += '\n';

    // 请求耗时统计
    const requestDuration = safeGet('request_duration');
    if (requestDuration && requestDuration.avg !== undefined && requestDuration.avg > 0) {
        summary += `请求耗时统计:\n`;
        summary += `  - 平均: ${(requestDuration.avg || 0).toFixed(2)}ms\n`;
        summary += `  - 最小: ${(requestDuration.min || 0).toFixed(2)}ms\n`;
        summary += `  - 最大: ${(requestDuration.max || 0).toFixed(2)}ms\n`;
        if (requestDuration['p(25)'] !== undefined) {
            summary += `  - P25: ${requestDuration['p(25)'].toFixed(2)}ms\n`;
        }
        if (requestDuration['p(50)'] !== undefined) {
            summary += `  - P50: ${requestDuration['p(50)'].toFixed(2)}ms\n`;
        }
        if (requestDuration['p(75)'] !== undefined) {
            summary += `  - P75: ${requestDuration['p(75)'].toFixed(2)}ms\n`;
        }
        if (requestDuration['p(90)'] !== undefined) {
            summary += `  - P90: ${requestDuration['p(90)'].toFixed(2)}ms\n`;
        }
        if (requestDuration['p(95)'] !== undefined) {
            summary += `  - P95: ${requestDuration['p(95)'].toFixed(2)}ms\n`;
        }
        if (requestDuration['p(99)'] !== undefined) {
            summary += `  - P99: ${requestDuration['p(99)'].toFixed(2)}ms\n`;
        }
        summary += '\n';
    }

    // 系统稳定性评估（基于请求失败率）
    summary += '系统稳定性评估:\n';
    // 使用请求失败率而不是总的错误率
    const errorRateValue = requestErrorRate;
    if (errorRateValue < 1) {
        summary += '  ✓ 系统表现优秀，错误率很低，可以承受该压力\n';
    } else if (errorRateValue < 5) {
        summary += '  ⚠️  系统表现良好，但有少量错误，需要关注\n';
    } else if (errorRateValue < 15) {
        summary += '  ⚠️  系统承受压力，错误率较高，建议优化\n';
    } else {
        summary += '  ✗ 系统可能存在问题，错误率很高，需要立即排查\n';
    }

    return summary;
}

