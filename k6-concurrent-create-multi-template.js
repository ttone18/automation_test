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

// 配置：可通过环境变量调整模板和sandbox数量
const TEMPLATES_PER_TEST = parseInt(__ENV.TEMPLATES_PER_TEST || '16', 10);
const SANDBOXES_PER_TEMPLATE = parseInt(__ENV.SANDBOXES_PER_TEMPLATE || '8', 10);
const TOTAL_SANDBOXES = TEMPLATES_PER_TEST * SANDBOXES_PER_TEMPLATE;

const CONCURRENT_COUNT = parseInt(__ENV.CONCURRENT_COUNT || __ENV.VUS || TOTAL_SANDBOXES.toString(), 10);

export const options = {
    scenarios: {
        [`create_${TOTAL_SANDBOXES}_sandboxes_multi_template`]: {
            executor: 'per-vu-iterations',
            vus: CONCURRENT_COUNT,
            iterations: 1,
            maxDuration: '10m', // 增加最大持续时间，给重试更多时间
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
const TEMPLATE_LIST_STR = __ENV.TEMPLATE_LIST || '';
const TEMPLATE_LIST_FILE = __ENV.TEMPLATE_LIST_FILE || '';
const MAX_WAIT_TIME = parseInt(__ENV.MAX_WAIT_TIME || '180000');
const MAX_RETRIES = parseInt(__ENV.MAX_RETRIES || '0');
const RETRY_DELAY_MS = parseInt(__ENV.RETRY_DELAY_MS || '1000');
const SANDBOX_TIMEOUT = parseInt(__ENV.SANDBOX_TIMEOUT || '120');
const HTTP_REQUEST_TIMEOUT = parseInt(__ENV.HTTP_REQUEST_TIMEOUT || '120'); // HTTP请求超时时间（秒），默认120秒

if (!API_KEY) {
    throw new Error('E2B_API_KEY or API_KEY is required for concurrent create test');
}

// 解析模板列表，并将点号(.)替换为连字符(-)
// 注意：open()函数只能在init阶段（全局作用域）使用
let allTemplates = [];

// 优先从文件读取，如果没有文件则从环境变量读取
if (TEMPLATE_LIST_FILE) {
    try {
        const fileContent = open(TEMPLATE_LIST_FILE);
        if (fileContent) {
            // 支持两种格式：每行一个模板ID，或者逗号分隔
            const lines = fileContent.split('\n');
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) { // 忽略空行和注释行
                    // 如果行中包含逗号，按逗号分割；否则整行作为一个模板ID
                    if (trimmed.includes(',')) {
                        const templates = trimmed.split(',')
                            .map(t => t.trim())
                            .filter(t => t.length > 0);
                        allTemplates = allTemplates.concat(templates);
                    } else {
                        allTemplates.push(trimmed);
                    }
                }
            }
            // 只在第一个VU时输出一次（通过检查是否已加载来避免重复）
            if (allTemplates.length > 0) {
                // 使用一个简单的标记来避免重复输出（虽然全局代码只执行一次，但为保险起见）
                console.log(`Loaded ${allTemplates.length} templates from file: ${TEMPLATE_LIST_FILE}`);
            }
        }
    } catch (e) {
        throw new Error(`Failed to read template list file ${TEMPLATE_LIST_FILE}: ${e.message}`);
    }
} else if (TEMPLATE_LIST_STR) {
    allTemplates = TEMPLATE_LIST_STR.split(',')
        .map(t => t.trim())
        .filter(t => t.length > 0);
}

// 将所有点号替换为连字符
allTemplates = allTemplates.map(t => t.replace(/\./g, '-'));

if (allTemplates.length === 0) {
    throw new Error('TEMPLATE_LIST or TEMPLATE_LIST_FILE is required and must contain at least one template ID');
}

if (allTemplates.length < TEMPLATES_PER_TEST) {
    console.warn(`Warning: Only ${allTemplates.length} templates provided, but need ${TEMPLATES_PER_TEST}. Will use available templates.`);
}

// 全局变量：存储选中的模板列表和模板分配
let selectedTemplates = [];
let templateAssignment = []; // 每个VU对应的模板ID

// Setup函数：随机选择模板并分配
export function setup() {
    // 随机选择TEMPLATES_PER_TEST个模板
    const shuffled = [...allTemplates].sort(() => Math.random() - 0.5);
    selectedTemplates = shuffled.slice(0, Math.min(TEMPLATES_PER_TEST, shuffled.length));

    // 如果模板数量不足，循环使用
    while (selectedTemplates.length < TEMPLATES_PER_TEST) {
        selectedTemplates = selectedTemplates.concat(selectedTemplates.slice(0, TEMPLATES_PER_TEST - selectedTemplates.length));
    }
    selectedTemplates = selectedTemplates.slice(0, TEMPLATES_PER_TEST);

    // 为每个VU分配模板：VU 0-7用模板0，VU 8-15用模板1，以此类推
    templateAssignment = [];
    for (let i = 0; i < CONCURRENT_COUNT; i++) {
        const templateIndex = Math.floor(i / SANDBOXES_PER_TEMPLATE) % selectedTemplates.length;
        templateAssignment.push(selectedTemplates[templateIndex]);
    }

    console.log(`Selected ${selectedTemplates.length} templates: ${selectedTemplates.join(', ')}`);
    console.log(`Template distribution: ${selectedTemplates.map((t, idx) => `${t}: ${templateAssignment.filter(a => a === t).length}`).join(', ')}`);

    return {
        selectedTemplates: selectedTemplates,
        templateAssignment: templateAssignment
    };
}

export default function (data) {
    const vuId = __VU - 1; // VU ID从1开始，转换为0-based索引
    const templateId = data.templateAssignment[vuId] || selectedTemplates[vuId % selectedTemplates.length];

    // 错开启动：根据模板ID计算延迟，避免所有模板同时准备
    // 相同模板的VU会使用相同的延迟，不同模板会错开
    const templateIndex = selectedTemplates.indexOf(templateId);
    if (templateIndex >= 0) {
        // 动态计算模板之间的错开延迟：模板越多，延迟越大
        // 基础延迟：每个模板错开500ms（16个模板总共错开8秒）
        // 如果模板数量少，可以减少延迟
        const baseDelayPerTemplate = Math.max(300, Math.min(800, TEMPLATES_PER_TEST * 30)); // 300-800ms之间
        const templateBaseDelay = templateIndex * baseDelayPerTemplate;

        // 同一模板内的VU错开：避免同一模板的所有sandbox同时请求
        const vuIndexInTemplate = vuId % SANDBOXES_PER_TEMPLATE;
        const vuDelay = vuIndexInTemplate * 100; // 每个VU错开100ms

        const staggerDelay = templateBaseDelay + vuDelay;
        if (staggerDelay > 0) {
            sleep(staggerDelay / 1000); // k6的sleep使用秒
        }
    }

    const totalStartTime = Date.now();
    const createStartTime = Date.now();
    let sandboxId = null;

    try {
        // 1. 创建 sandbox（带重试机制）
        let createRes = createSandbox(templateId);
        let retryCount = 0;

        // 如果失败且是5xx错误，且配置了重试，则重试
        // 对于"no nodes available"错误，使用更长的延迟
        while (!createRes.success &&
            createRes.status >= 500 &&
            retryCount < MAX_RETRIES) {
            retryCount++;

            // 检查是否是"no nodes available"错误，使用更长的延迟
            const isNoNodesError = createRes.error &&
                (createRes.error.includes('no nodes available') ||
                    createRes.error.includes('no node available'));
            const delayMs = isNoNodesError ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS; // 节点不可用时延迟加倍

            console.log(`[Template: ${templateId}] Retry ${retryCount}/${MAX_RETRIES} after ${delayMs}ms delay${isNoNodesError ? ' (no nodes available, using longer delay)' : ''}...`);
            sleep(delayMs / 1000);
            createRes = createSandbox(templateId);
        }

        if (!createRes.success || !createRes.sandboxId) {
            errorRate.add(1);
            sandboxFailed.add(1);
            const failRecord = {
                type: 'sandbox_record',
                sandboxId: null,
                templateId: templateId,
                createDuration: Date.now() - createStartTime,
                readyDuration: 0,
                totalDuration: Date.now() - totalStartTime,
                success: false,
                error: createRes.error || 'Create failed',
                httpStatus: createRes.status || null,
                errorDetails: createRes.errorDetails || null,
                retryCount: retryCount,
                timestamp: new Date().toISOString(),
            };
            console.log(`SANDBOX_RECORD:${JSON.stringify(failRecord)}`);
            return;
        }

        if (retryCount > 0) {
            console.log(`[${createRes.sandboxId}] [Template: ${templateId}] Created successfully after ${retryCount} retries`);
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
                templateId: templateId,
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
            templateId: templateId,
            createDuration: createDurationMs,
            readyDuration: readyDurationMs,
            totalDuration: totalDurationMs,
            success: true,
            error: null,
            timestamp: new Date().toISOString(),
        };

        console.log(`[${sandboxId}] [Template: ${templateId}] 创建耗时: ${createDurationMs}ms | 就绪耗时: ${readyDurationMs}ms | 总耗时: ${totalDurationMs}ms`);
        console.log(`SANDBOX_RECORD:${JSON.stringify(record)}`);

    } catch (error) {
        errorRate.add(1);
        sandboxFailed.add(1);
        const errorRecord = {
            type: 'sandbox_record',
            sandboxId: sandboxId,
            templateId: templateId,
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

function createSandbox(templateId) {
    const payload = JSON.stringify({
        templateID: templateId,
        timeout: SANDBOX_TIMEOUT,
    });

    const res = http.post(`${API_BASE_URL}/sandboxes`, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'CreateSandbox' },
        timeout: `${HTTP_REQUEST_TIMEOUT}s`, // 设置HTTP请求超时时间
    });

    const success = check(res, {
        'create sandbox status is 201 or 200': (r) => r.status === 201 || r.status === 200,
    });

    let sandboxId = null;
    let detailedError = null;

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
        const bodyStr = res.body || '';

        // 处理超时或网络错误
        if (res.status === 0 || !res.body) {
            errorMsg += ': Request timeout or network error';
            detailedError = 'Request timeout or network error';
        } else {
            try {
                const errorBody = JSON.parse(bodyStr);
                if (errorBody.message || errorBody.error) {
                    errorMsg += `: ${errorBody.message || errorBody.error}`;
                    detailedError = errorBody.message || errorBody.error;
                } else if (errorBody.errorMessage) {
                    errorMsg += `: ${errorBody.errorMessage}`;
                    detailedError = errorBody.errorMessage;
                } else {
                    // 显示完整响应体（限制长度避免日志过长）
                    const bodyPreview = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '...' : bodyStr;
                    errorMsg += `: ${bodyPreview}`;
                    detailedError = bodyPreview;
                }
            } catch (e) {
                // 如果无法解析JSON，显示原始响应（限制长度）
                const bodyPreview = bodyStr.length > 500 ? bodyStr.substring(0, 500) + '...' : bodyStr;
                errorMsg += `: ${bodyPreview || '(empty response)'}`;
                detailedError = bodyPreview || '(empty response)';
            }
        }
        console.error(`[Template: ${templateId}] Create sandbox failed - ${errorMsg}`);

        // 对于5xx错误，输出更多调试信息
        if (res.status >= 500 && bodyStr) {
            console.error(`  Response headers: ${JSON.stringify(res.headers)}`);
            console.error(`  Response body length: ${bodyStr.length} bytes`);
        }
    }

    return {
        success,
        sandboxId,
        status: res.status,
        error: success ? null : (detailedError || `HTTP ${res.status}`),
        errorDetails: success ? null : {
            status: res.status,
            message: detailedError,
            body: res.body ? (res.body.length > 1000 ? res.body.substring(0, 1000) + '...' : res.body) : '(empty response)'
        }
    };
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
        timeout: '30s', // GET请求超时时间
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
    const filename = `concurrent-create-multi-template-summary-${timestamp}.json`;

    const jsonFilePath = `${outputDir}/${filename}`;

    return {
        'stdout': textOutput,
        [jsonFilePath]: jsonOutput,
    };
}

function textSummary(data) {
    const actualCount = data.metrics?.sandboxes_created?.values?.count || TOTAL_SANDBOXES;
    let summary = `\n多模板并发创建 ${TOTAL_SANDBOXES} 个 Sandbox 压测结果\n`;
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
    const actualTotal = totalRequests > 0 ? totalRequests : TOTAL_SANDBOXES;

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
    summary += `就绪成功率: ${readySuccessRate}%\n`;
    summary += `总体成功率: ${overallSuccessRate}%\n`;
    summary += `错误率: ${((errors.rate || 0) * 100).toFixed(2)}%\n\n`;

    if (selectedTemplates && selectedTemplates.length > 0) {
        summary += `使用的模板 (${selectedTemplates.length}个): ${selectedTemplates.join(', ')}\n\n`;
    }

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
            summary += `  - P99: ${(createDuration.max || 0).toFixed(2)}ms\n`;
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
            summary += `  - P99: ${(readyDuration.max || 0).toFixed(2)}ms\n`;
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
            summary += `  - P99: ${(totalDuration.max || 0).toFixed(2)}ms\n`;
        }
        summary += '\n';
    }

    // 如果有失败，提示查看日志了解详细原因
    if (failed.count > 0) {
        summary += '提示: 有失败的请求，请查看日志文件了解详细错误信息。\n';
        summary += '     日志文件位置: /tmp/e2b-load-test-results/k6-concurrent-create-multi-template-*.log\n';
        summary += '     可以运行: grep "Create sandbox failed" /tmp/e2b-load-test-results/k6-concurrent-create-multi-template-*.log | head -20\n';
        summary += '     或者查看: grep "SANDBOX_RECORD" /tmp/e2b-load-test-results/k6-concurrent-create-multi-template-*.log | grep "success.*false"\n\n';
    }

    return summary;
}
