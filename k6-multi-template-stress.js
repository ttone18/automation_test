import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const createDuration = new Trend('create_duration');
const sandboxCreated = new Counter('sandboxes_created');
const sandboxFailed = new Counter('sandboxes_failed');

const API_URL = __ENV.E2B_API_URL || __ENV.API_BASE_URL || 'http://localhost:3000';
const API_KEY = __ENV.E2B_API_KEY || __ENV.API_KEY;
const TEMPLATES = (__ENV.TEMPLATE_LIST || 'base').split(',').map(t => t.trim());
const CONCURRENT_COUNT = parseInt(__ENV.CONCURRENT_COUNT || '60');
const TRAFFIC_DURATION = __ENV.TRAFFIC_DURATION || '30m';
const MAX_RETRIES = parseInt(__ENV.MAX_RETRIES || '3');
const RETRY_DELAY_MS = parseInt(__ENV.RETRY_DELAY_MS || '2000');

console.log('=== K6 Multi-Template Stress Test Configuration ===');
console.log('API_URL:', API_URL);
console.log('API_KEY:', API_KEY ? `${API_KEY.substring(0, 15)}...` : 'NOT SET');
console.log('TEMPLATES:', TEMPLATES);
console.log('CONCURRENT_COUNT:', CONCURRENT_COUNT);
console.log('TRAFFIC_DURATION:', TRAFFIC_DURATION);
console.log('MAX_RETRIES:', MAX_RETRIES);
console.log('===================================================');

if (!API_KEY) {
    throw new Error('API_KEY is required');
}

export let options = {
    scenarios: {
        stress_test: {
            executor: 'constant-arrival-rate',
            rate: CONCURRENT_COUNT,
            timeUnit: '1m',
            duration: TRAFFIC_DURATION,
            preAllocatedVUs: CONCURRENT_COUNT * 2,
            maxVUs: CONCURRENT_COUNT * 3,
            gracefulStop: '30s',
        },
    },
    thresholds: {
        http_req_duration: ['p(95)<30000'],
        http_req_failed: ['rate<0.15'],
        errors: ['rate<0.15'],
    },
};

export default function () {
    const templateId = TEMPLATES[Math.floor(Math.random() * TEMPLATES.length)];
    const startTime = Date.now();
    
    // 创建 sandbox（带重试）
    let createRes = createSandbox(templateId);
    let retryCount = 0;

    while (!createRes.success && 
           createRes.status >= 500 && 
           retryCount < MAX_RETRIES) {
        retryCount++;
        const isNodesError = createRes.error && 
            createRes.error.includes('no nodes available');
        const delayMs = isNoNodesError ? RETRY_DELAY_MS * 2 : RETRY_DELAY_MS;
        
        console.log(`[${templateId}] Retry ${retryCount}/${MAX_RETRIES} after ${delayMs}ms...`);
        sleep(delayMs / 1000);
        createRes = createSandbox(templateId);
    }

    const duration = Date.now() - startTime;
    createDuration.add(duration);

    const record = {
        type: 'SANDBOX_RECORD',
        templateId: templateId,
        success: createRes.success,
        status: createRes.status,
        duration: duration,
        timestamp: new Date().toISOString(),
        retryCount: retryCount,
    };

    if (createRes.success && createRes.sandboxId) {
        record.sandboxId = createRes.sandboxId;
        sandboxCreated.add(1);
        console.log(JSON.stringify(record));
    } else {
        record.error = createRes.error || 'Unknown error';
        record.errorDetails = createRes.errorDetails;
        sandboxFailed.add(1);
        errorRate.add(1);
        console.log(JSON.stringify(record));
    }

    sleep(1);
}

function createSandbox(templateId) {
    const payload = JSON.stringify({
        templateID: templateId,
        timeout: 120,
    });

    const res = http.post(`${API_URL}/sandboxes`, payload, {
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': API_KEY,
        },
        tags: { name: 'CreateSandbox' },
        timeout: '120s',
    });

    const success = check(res, {
        'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
    });

    let sandboxId = null;
    let detailedError = null;

    if (success) {
        try {
            const body = JSON.parse(res.body);
            sandboxId = body.sandboxID || body.id || body.data?.sandboxID || body.data?.id;
        } catch (e) {
            console.error('Failed to parse response:', e);
        }
    } else {
        let errorMsg = `HTTP ${res.status}`;
        const bodyStr = res.body || '';

        if (res.status === 0 || !res.body) {
            errorMsg += ': Request timeout or network error';
            detailedError = 'Request timeout or network error';
        } else {
            try {
                const errorBody = JSON.parse(bodyStr);
                detailedError = errorBody.message || errorBody.error || errorBody.errorMessage;
                if (detailedError) {
                    errorMsg += `: ${detailedError}`;
                }
            } catch (e) {
                const bodyPreview = bodyStr.length > 200 ? bodyStr.substring(0, 200) + '...' : bodyStr;
                detailedError = bodyPreview;
                errorMsg += `: ${bodyPreview}`;
            }
        }
        
        console.error(`[${templateId}] Create failed - ${errorMsg}`);
    }

    return {
        success,
        sandboxId,
        status: res.status,
        error: detailedError,
        errorDetails: success ? null : {
            status: res.status,
            message: detailedError,
            body: res.body ? (res.body.length > 500 ? res.body.substring(0, 500) + '...' : res.body) : null
        }
    };
}

export function handleSummary(data) {
    let summary = '========== Multi-Template Stress Test Summary ==========';
    summary += `Templates: ${TEMPLATES.join(', ')}`;
    summary += `Duration: ${TRAFFIC_DURATION}`;
    summary += `Target Rate: ${CONCURRENT_COUNT} requests/min`;
    summary += `Max Retries: ${MAX_RETRIES}`;
    summary += '========================================================';
    
    const created = data.metrics.sandboxes_created?.values?.count || 0;
    const failed = data.metrics.sandboxes_failed?.values?.count || 0;
    const total = created + failed;
    const errorRateValue = data.metrics.errors?.values?.rate || 0;
    const createDurationValues = data.metrics.create_duration?.values || {};
    
    summary += `请求统计:`;
    summary += `  - 总请求数: ${total}`;
    summary += `  - 成功创建: ${created}`;
    summary += `  - 失败数: ${failed}`;
    summary += `  - 成功率: ${total > 0 ? ((created / total) * 100).toFixed(2) : 0}%\n`;
    summary += `  - 错误率: ${(errorRateValue * 100).toFixed(2)}%`;
    
    if (createDurationValues.avg !== undefined) {
        summary += `\n创建耗时:`;
        summary += `  - 平均: ${createDurationValues.avg.toFixed(2)}ms`;
        summary += `  - 最小: ${(createDurationValues.min || 0).toFixed(2)}ms`;
        summary += `  - 最大: ${(createDurationValues.max || 0).toFixed(2)}ms`;
        summary += `  - P50: ${(createDurationValues.med || createDurationValues['p(50)'] || 0).toFixed(2)}ms`;
        summary += `  - P95: ${(createDurationValues['p(95)'] || 0).toFixed(2)}ms`;
        summary += `  - P99: ${(createDurationValues['p(99)'] || 0).toFixed(2)}ms`;
    }
    
    summary += '\n========================================================';
    
    return {
        'stdout': summary,
    };
}
