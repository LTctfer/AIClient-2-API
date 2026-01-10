import { promises as fs } from 'fs';
import * as path from 'path';
import * as http from 'http'; // Add http for IncomingMessage and ServerResponse types
import * as crypto from 'crypto'; // Import crypto for MD5 hashing
import { convertData, getOpenAIStreamChunkStop } from './convert.js';
import { ProviderStrategyFactory } from './provider-strategies.js';

// ==================== 网络错误处理 ====================

/**
 * 可重试的网络错误标识列表
 * 这些错误可能出现在 error.code 或 error.message 中
 */
export const RETRYABLE_NETWORK_ERRORS = [
    'ECONNRESET',      // 连接被重置
    'ETIMEDOUT',       // 连接超时
    'ECONNREFUSED',    // 连接被拒绝
    'ENOTFOUND',       // DNS 解析失败
    'ENETUNREACH',     // 网络不可达
    'EHOSTUNREACH',    // 主机不可达
    'EPIPE',           // 管道破裂
    'EAI_AGAIN',       // DNS 临时失败
    'ECONNABORTED',    // 连接中止
    'ESOCKETTIMEDOUT', // Socket 超时
];

/**
 * 检查是否为可重试的网络错误
 * @param {Error} error - 错误对象
 * @returns {boolean} - 是否为可重试的网络错误
 */
export function isRetryableNetworkError(error) {
    if (!error) return false;
    
    const errorCode = error.code || '';
    const errorMessage = error.message || '';
    
    return RETRYABLE_NETWORK_ERRORS.some(errId =>
        errorCode === errId || errorMessage.includes(errId)
    );
}

// ==================== API 常量 ====================

export const API_ACTIONS = {
    GENERATE_CONTENT: 'generateContent',
    STREAM_GENERATE_CONTENT: 'streamGenerateContent',
};

export const MODEL_PROTOCOL_PREFIX = {
    // Model provider constants
    GEMINI: 'gemini',
    OPENAI: 'openai',
    OPENAI_RESPONSES: 'openaiResponses',
    CLAUDE: 'claude',
    OLLAMA: 'ollama',
}

export const MODEL_PROVIDER = {
    // Model provider constants
    GEMINI_CLI: 'gemini-cli-oauth',
    ANTIGRAVITY: 'gemini-antigravity',
    OPENAI_CUSTOM: 'openai-custom',
    OPENAI_CUSTOM_RESPONSES: 'openaiResponses-custom',
    CLAUDE_CUSTOM: 'claude-custom',
    KIRO_API: 'claude-kiro-oauth',
    QWEN_API: 'openai-qwen-oauth',
    IFLOW_API: 'openai-iflow',
}

/**
 * Extracts the protocol prefix from a given model provider string.
 * This is used to determine if two providers belong to the same underlying protocol (e.g., gemini, openai, claude).
 * @param {string} provider - The model provider string (e.g., 'gemini-cli', 'openai-custom').
 * @returns {string} The protocol prefix (e.g., 'gemini', 'openai', 'claude').
 */
export function getProtocolPrefix(provider) {
    const hyphenIndex = provider.indexOf('-');
    if (hyphenIndex !== -1) {
        return provider.substring(0, hyphenIndex);
    }
    return provider; // Return original if no hyphen is found
}

export const ENDPOINT_TYPE = {
    OPENAI_CHAT: 'openai_chat',
    OPENAI_RESPONSES: 'openai_responses',
    GEMINI_CONTENT: 'gemini_content',
    CLAUDE_MESSAGE: 'claude_message',
    OPENAI_MODEL_LIST: 'openai_model_list',
    GEMINI_MODEL_LIST: 'gemini_model_list',
};

export const FETCH_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'fetch_system_prompt.txt');
export const INPUT_SYSTEM_PROMPT_FILE = path.join(process.cwd(), 'configs', 'input_system_prompt.txt');

export function formatExpiryTime(expiryTimestamp) {
    if (!expiryTimestamp || typeof expiryTimestamp !== 'number') return "No expiry date available";
    const diffMs = expiryTimestamp - Date.now();
    if (diffMs <= 0) return "Token has expired";
    let totalSeconds = Math.floor(diffMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    totalSeconds %= 3600;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const pad = (num) => String(num).padStart(2, '0');
    return `${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
}

/**
 * Reads the entire request body from an HTTP request.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @returns {Promise<Object>} A promise that resolves with the parsed JSON request body.
 * @throws {Error} If the request body is not valid JSON.
 */
export function getRequestBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(new Error("Invalid JSON in request body."));
            }
        });
        req.on('error', err => {
            reject(err);
        });
    });
}

export async function logConversation(type, content, logMode, logFilename) {
    if (logMode === 'none') return;
    if (!content) return;

    const timestamp = new Date().toLocaleString();
    const logEntry = `${timestamp} [${type.toUpperCase()}]:\n${content}\n--------------------------------------\n`;

    if (logMode === 'console') {
        console.log(logEntry);
    } else if (logMode === 'file') {
        try {
            // Append to the file
            await fs.appendFile(logFilename, logEntry);
        } catch (err) {
            console.error(`[Error] Failed to write conversation log to ${logFilename}:`, err);
        }
    }
}

/**
 * Checks if the request is authorized based on API key.
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {URL} requestUrl - The parsed URL object.
 * @param {string} REQUIRED_API_KEY - The API key required for authorization.
 * @returns {boolean} True if authorized, false otherwise.
 */
export function isAuthorized(req, requestUrl, REQUIRED_API_KEY) {
    const authHeader = req.headers['authorization'];
    const queryKey = requestUrl.searchParams.get('key');
    const googApiKey = req.headers['x-goog-api-key'];
    const claudeApiKey = req.headers['x-api-key']; // Claude-specific header

    // Check for Bearer token in Authorization header (OpenAI style)
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        if (token === REQUIRED_API_KEY) {
            return true;
        }
    }

    // Check for API key in URL query parameter (Gemini style)
    if (queryKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-goog-api-key header (Gemini style)
    if (googApiKey === REQUIRED_API_KEY) {
        return true;
    }

    // Check for API key in x-api-key header (Claude style)
    if (claudeApiKey === REQUIRED_API_KEY) {
        return true;
    }

    console.log(`[Auth] Unauthorized request denied. Bearer: "${authHeader ? 'present' : 'N/A'}", Query Key: "${queryKey}", x-goog-api-key: "${googApiKey}", x-api-key: "${claudeApiKey}"`);
    return false;
}

/**
 * Handles the common logic for sending API responses (unary and stream).
 * This includes writing response headers, logging conversation, and logging auth token expiry.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Object} responsePayload - The actual response payload (string for unary, object for stream chunks).
 * @param {boolean} isStream - Whether the response is a stream.
 */
export async function handleUnifiedResponse(res, responsePayload, isStream) {
    if (isStream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Transfer-Encoding": "chunked" });
    } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
    }

    if (isStream) {
        // Stream chunks are handled by the calling function that iterates the stream
    } else {
        res.end(responsePayload);
    }
}

export async function handleStreamRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, requestConfig) {
    let fullResponseText = '';
    let fullResponseJson = '';
    let fullOldResponseJson = '';
    let responseClosed = false;

    // fs.writeFile('request'+Date.now()+'.json', JSON.stringify(requestBody));
    // The service returns a stream in its native format (toProvider).
    const addEvent = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.CLAUDE || getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES;
    const openStop = getProtocolPrefix(fromProvider) === MODEL_PROTOCOL_PREFIX.OPENAI ;

    const getHttpStatus = (error) => {
        const status = error?.response?.status ?? error?.statusCode ?? error?.status;
        return typeof status === 'number' ? status : null;
    };
    const is5xx = (status) => typeof status === 'number' && status >= 500 && status < 600;
    // 确定性节点失败：只有认证/权限类错误（401/403）才是节点配置问题
    // 400 Bad Request 可能是请求格式问题，404 可能是模型不存在，都不应标记节点不健康
    const isDeterministicFailure = (status) =>
        status === 401 || status === 403;
    const isTransientFailure = (error, status) =>
        status === 429 || isRetryableNetworkError(error);

    const maxRetries = Number(requestConfig?.REQUEST_MAX_RETRIES ?? 3);
    const baseDelay = Number(requestConfig?.REQUEST_BASE_DELAY ?? 1000);
    const maxDelay = Number(requestConfig?.REQUEST_MAX_DELAY ?? 10_000);

    /**
     * 计算退避延迟：优先使用 Retry-After 头，否则使用指数退避
     * @param {number} attempt - 当前重试次数
     * @param {Error} error - 错误对象（可能包含 Retry-After 头）
     * @returns {number} 延迟毫秒数
     */
    const getBackoffDelay = (attempt, error = null) => {
        // 优先使用 Retry-After 头
        const retryAfterHeader = error?.response?.headers?.['retry-after'];
        if (retryAfterHeader) {
            // Retry-After 可以是秒数或 HTTP 日期
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
                const delayMs = parsed * 1000;
                console.log(`[Retry] Using Retry-After header: ${parsed}s`);
                return Math.min(delayMs, maxDelay);
            }
            // 尝试解析为 HTTP 日期
            const dateMs = Date.parse(retryAfterHeader);
            if (!isNaN(dateMs)) {
                const delayMs = Math.max(0, dateMs - Date.now());
                console.log(`[Retry] Using Retry-After date header: ${retryAfterHeader}`);
                return Math.min(delayMs, maxDelay);
            }
        }
        // 回退到指数退避
        const raw = baseDelay * Math.pow(2, attempt);
        return Math.max(0, Math.min(maxDelay, raw));
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const canFastFailover = (status) =>
        (is5xx(status) || isDeterministicFailure(status)) &&
        Boolean(providerPoolManager) &&
        Boolean(pooluuid) &&
        Boolean(requestConfig?.providerPools) &&
        Boolean(requestConfig?.MODEL_PROVIDER) &&
        Array.isArray(requestConfig.providerPools[requestConfig.MODEL_PROVIDER]);

    // 先拿到首个 chunk 再写响应头：避免上游在首包前 5xx 时无法切换 fallback
    let effectiveService = service;
    let effectiveProvider = toProvider;
    let effectiveUuid = pooluuid;
    let effectiveCustomName = customName;
    let effectiveModel = model;
    let effectiveRequestBody = requestBody;
    let needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(effectiveProvider);
 
    const prefetchFirstChunk = async (svc, provider, mdl, body) => {
        body.model = mdl;
        const stream = await svc.generateContentStream(mdl, body);
        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next(); // 触发真正的上游请求
        if (!first || first.done) {
            throw new Error('Upstream stream ended before first chunk');
        }
        return { iterator, firstChunk: first.value };
    };

    // 调度层重试：仅对 429 / 网络抖动做指数退避重试，不改变号池健康状态
    const prefetchFirstChunkWithRetry = async (svc, provider, mdl, body) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                return await prefetchFirstChunk(svc, provider, mdl, body);
            } catch (error) {
                const status = getHttpStatus(error);
                if (isTransientFailure(error, status) && attempt < maxRetries) {
                    const delay = getBackoffDelay(attempt, error);
                    const tag = status ?? error?.code ?? 'TRANSIENT';
                    console.log(`[Retry] 流式首包前检测到瞬时错误(${tag})，${delay}ms 后重试... (attempt ${attempt + 1}/${maxRetries})`);
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
        // 理论上不可达
        throw new Error('Prefetch retry loop exhausted unexpectedly');
    };

    let iterator = null;
    let firstChunk = null;

    try {
        // 第一次尝试（当前选中的节点）
        try {
            const first = await prefetchFirstChunkWithRetry(effectiveService, effectiveProvider, effectiveModel, effectiveRequestBody);
            iterator = first.iterator;
            firstChunk = first.firstChunk;
        } catch (error) {
            const status = getHttpStatus(error);

            // 仅在首包前的 5xx / 确定性失败 才尝试快速 failover（避免重复发送同一个必然失败的 payload）
            if (canFastFailover(status)) {
                const kind = is5xx(status) ? '5xx' : '确定性失败';
                console.log(`[Provider Pool] 检测到流式首包前 ${status} (${kind})，立即熔断并尝试 failover: ${effectiveProvider} (${pooluuid})`);

                if (is5xx(status)) {
                    if (typeof providerPoolManager.markProviderServerError === 'function') {
                        providerPoolManager.markProviderServerError(effectiveProvider, { uuid: pooluuid }, error.message);
                    } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                        providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: pooluuid }, error.message);
                    } else {
                        providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: pooluuid }, error.message);
                    }
                } else {
                    if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                        providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: pooluuid }, error.message);
                    } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                        providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: pooluuid }, error.message);
                    } else {
                        providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: pooluuid }, error.message);
                    }
                }

                // 尝试重新选择服务（支持 providerFallbackChain/modelFallbackMapping）
                try {
                    const { getApiServiceWithFallback } = await import('./service-manager.js');
                    const result = await getApiServiceWithFallback(requestConfig, effectiveModel);

                    if (result?.service) {
                        const previousProvider = effectiveProvider;
                        effectiveService = result.service;
                        effectiveProvider = result.actualProviderType || effectiveProvider;
                        effectiveUuid = result.uuid || effectiveUuid;
                        effectiveCustomName = result.serviceConfig?.customName || effectiveCustomName;
                        if (result.actualModel && result.actualModel !== effectiveModel) {
                            console.log(`[Content Generation] Model Fallback: ${effectiveModel} -> ${result.actualModel}`);
                            effectiveModel = result.actualModel;
                        }

                        // 若 fallback 导致 backend 协议变化，需要对 requestBody 做二次转换
                        if (getProtocolPrefix(previousProvider) !== getProtocolPrefix(effectiveProvider)) {
                            console.log(`[Request Convert] Fallback 触发，二次转换请求: ${previousProvider} -> ${effectiveProvider}`);
                            try {
                                effectiveRequestBody = convertData(effectiveRequestBody, 'request', previousProvider, effectiveProvider);
                            } catch (convertError) {
                                console.error(`[Request Convert] 二次转换失败: ${convertError.message}`);
                                // 视为确定性失败：避免该节点被反复选中
                                if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                                    providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: effectiveUuid }, `Request convert failed: ${convertError.message}`);
                                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, `Request convert failed: ${convertError.message}`);
                                }
                                throw convertError;
                            }
                        }
                        needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(effectiveProvider);

                        const retryFirst = await prefetchFirstChunkWithRetry(effectiveService, effectiveProvider, effectiveModel, effectiveRequestBody);
                        iterator = retryFirst.iterator;
                        firstChunk = retryFirst.firstChunk;
                    } else {
                        throw error;
                    }
                } catch (failoverError) {
                    throw failoverError;
                }
            } else {
                throw error;
            }
        }

        await handleUnifiedResponse(res, '', true);

        // 标记是否已发送首包后的数据（用于区分首包前/后错误的处理策略）
        let hasStartedStreaming = false;

        // 先发送已预取的首个 chunk
        const processNativeChunk = (nativeChunk) => {
            const chunkText = extractResponseText(nativeChunk, effectiveProvider);
            if (chunkText && !Array.isArray(chunkText)) {
                fullResponseText += chunkText;
            }

            const chunkToSend = needsConversion
                ? convertData(nativeChunk, 'streamChunk', effectiveProvider, fromProvider, effectiveModel)
                : nativeChunk;

            if (!chunkToSend) {
                return;
            }

            const chunksToSend = Array.isArray(chunkToSend) ? chunkToSend : [chunkToSend];
            for (const chunk of chunksToSend) {
                if (addEvent) {
                    res.write(`event: ${chunk.type}\n`);
                }
                res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }
            hasStartedStreaming = true;
        };

        processNativeChunk(firstChunk);

        // 继续发送剩余 chunk
        try {
            while (true) {
                const next = await iterator.next();
                if (next.done) break;
                processNativeChunk(next.value);
            }
        } catch (midStreamError) {
            // 首包后错误：已经向客户端发送了部分数据，不能 failover
            // 只记录错误并标记节点状态，然后发送错误事件结束流
            console.error('\n[Server] Error during mid-stream processing (after first chunk):', midStreamError.message);

            if (providerPoolManager && effectiveUuid) {
                const status = getHttpStatus(midStreamError);
                // 首包后错误使用较轻的惩罚策略：只增加错误计数，不立即熔断
                // 因为可能是网络抖动等临时问题，而非节点本身的问题
                console.log(`[Provider Pool] Mid-stream error (${status ?? midStreamError?.code ?? 'UNKNOWN'}), incrementing error count for: ${effectiveProvider} (${effectiveUuid})`);
                providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, `Mid-stream error: ${midStreamError.message}`);
            }

            // 发送错误事件结束流
            const errorPayload = createStreamErrorResponse(midStreamError, fromProvider);
            res.write(errorPayload);
            res.end();
            responseClosed = true;
            return; // 提前返回，跳过成功处理逻辑
        }

        if (openStop && needsConversion) {
            res.write(`data: ${JSON.stringify(getOpenAIStreamChunkStop(effectiveModel))}\n\n`);
            // console.log(`data: ${JSON.stringify(getOpenAIStreamChunkStop(model))}\n`);
        }

        // 流式请求成功完成，统计使用次数，错误次数重置为0
        if (providerPoolManager && effectiveUuid) {
            const customNameDisplay = effectiveCustomName ? `, ${effectiveCustomName}` : '';
            console.log(`[Provider Pool] Increasing usage count for ${effectiveProvider} (${effectiveUuid}${customNameDisplay}) after successful stream request`);
            providerPoolManager.markProviderHealthy(effectiveProvider, {
                uuid: effectiveUuid
            });
        }

    }  catch (error) {
        console.error('\n[Server] Error during stream processing:', error.stack);
        if (providerPoolManager && effectiveUuid) {
            const status = getHttpStatus(error);

            // 号池健康模型：瞬时错误（429/网络）只退避，不直接判死；确定性失败与 5xx 才熔断
            if (isTransientFailure(error, status)) {
                console.log(`[Provider Pool] 流式错误(${status ?? error?.code ?? 'TRANSIENT'})判定为瞬时错误，不标记节点不健康: ${effectiveProvider} (${effectiveUuid})`);
            } else if (is5xx(status)) {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to 5xx stream error`);
                if (typeof providerPoolManager.markProviderServerError === 'function') {
                    providerPoolManager.markProviderServerError(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            } else if (isDeterministicFailure(status)) {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to deterministic stream error (${status})`);
                if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                    providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            } else {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to stream error`);
                providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
            }
        }

        // 使用新方法创建符合 fromProvider 格式的流式错误响应
        const errorPayload = createStreamErrorResponse(error, fromProvider);
        // 可能尚未写入响应头（首包前失败），确保 SSE 头存在
        if (!res.headersSent) {
            await handleUnifiedResponse(res, '', true);
        }
        res.write(errorPayload);
        res.end();
        responseClosed = true;
    } finally {
        if (!responseClosed) {
            res.end();
        }
        await logConversation('output', fullResponseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        // fs.writeFile('oldResponseChunk'+Date.now()+'.json', fullOldResponseJson);
        // fs.writeFile('responseChunk'+Date.now()+'.json', fullResponseJson);
    }
}


export async function handleUnaryRequest(res, service, model, requestBody, fromProvider, toProvider, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid, customName, requestConfig) {
    const getHttpStatus = (error) => {
        const status = error?.response?.status ?? error?.statusCode ?? error?.status;
        return typeof status === 'number' ? status : null;
    };
    const is5xx = (status) => typeof status === 'number' && status >= 500 && status < 600;
    // 确定性节点失败：只有认证/权限类错误（401/403）才是节点配置问题
    // 400 Bad Request 可能是请求格式问题，404 可能是模型不存在，都不应标记节点不健康
    const isDeterministicFailure = (status) =>
        status === 401 || status === 403;
    const isTransientFailure = (error, status) =>
        status === 429 || isRetryableNetworkError(error);

    const maxRetries = Number(requestConfig?.REQUEST_MAX_RETRIES ?? 3);
    const baseDelay = Number(requestConfig?.REQUEST_BASE_DELAY ?? 1000);
    const maxDelay = Number(requestConfig?.REQUEST_MAX_DELAY ?? 10_000);

    /**
     * 计算退避延迟：优先使用 Retry-After 头，否则使用指数退避
     * @param {number} attempt - 当前重试次数
     * @param {Error} error - 错误对象（可能包含 Retry-After 头）
     * @returns {number} 延迟毫秒数
     */
    const getBackoffDelay = (attempt, error = null) => {
        // 优先使用 Retry-After 头
        const retryAfterHeader = error?.response?.headers?.['retry-after'];
        if (retryAfterHeader) {
            // Retry-After 可以是秒数或 HTTP 日期
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
                const delayMs = parsed * 1000;
                console.log(`[Retry] Using Retry-After header: ${parsed}s`);
                return Math.min(delayMs, maxDelay);
            }
            // 尝试解析为 HTTP 日期
            const dateMs = Date.parse(retryAfterHeader);
            if (!isNaN(dateMs)) {
                const delayMs = Math.max(0, dateMs - Date.now());
                console.log(`[Retry] Using Retry-After date header: ${retryAfterHeader}`);
                return Math.min(delayMs, maxDelay);
            }
        }
        // 回退到指数退避
        const raw = baseDelay * Math.pow(2, attempt);
        return Math.max(0, Math.min(maxDelay, raw));
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const canFastFailover = (status) =>
        (is5xx(status) || isDeterministicFailure(status)) &&
        Boolean(providerPoolManager) &&
        Boolean(pooluuid) &&
        Boolean(requestConfig?.providerPools) &&
        Boolean(requestConfig?.MODEL_PROVIDER) &&
        Array.isArray(requestConfig.providerPools[requestConfig.MODEL_PROVIDER]);

    // 允许在一次请求内进行一次性 failover（避免无上限重试/切换）
    let effectiveService = service;
    let effectiveProvider = toProvider;
    let effectiveUuid = pooluuid;
    let effectiveCustomName = customName;
    let effectiveModel = model;
    let effectiveRequestBody = requestBody;

    // 调度层重试：仅对 429 / 网络抖动做指数退避重试，不改变号池健康状态
    const generateContentWithRetry = async (svc, provider, uuid, mdl, body) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                body.model = mdl;
                return await svc.generateContent(mdl, body);
            } catch (error) {
                const status = getHttpStatus(error);
                if (isTransientFailure(error, status) && attempt < maxRetries) {
                    const delay = getBackoffDelay(attempt, error);
                    const tag = status ?? error?.code ?? 'TRANSIENT';
                    console.log(`[Retry] 一元请求检测到瞬时错误(${tag})，${delay}ms 后重试... (attempt ${attempt + 1}/${maxRetries}) ${provider} (${uuid})`);
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
        // 理论上不可达
        throw new Error('Unary retry loop exhausted unexpectedly');
    };

    try{
        const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(effectiveProvider);
        const nativeResponse = await generateContentWithRetry(effectiveService, effectiveProvider, effectiveUuid, effectiveModel, effectiveRequestBody);
        const responseText = extractResponseText(nativeResponse, effectiveProvider);

        let clientResponse = nativeResponse;
        if (needsConversion) {
            console.log(`[Response Convert] Converting response from ${effectiveProvider} to ${fromProvider}`);
            clientResponse = convertData(nativeResponse, 'response', effectiveProvider, fromProvider, effectiveModel);
        }

        await handleUnifiedResponse(res, JSON.stringify(clientResponse), false);
        await logConversation('output', responseText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
        
        if (providerPoolManager && effectiveUuid) {
            const customNameDisplay = effectiveCustomName ? `, ${effectiveCustomName}` : '';
            console.log(`[Provider Pool] Increasing usage count for ${effectiveProvider} (${effectiveUuid}${customNameDisplay}) after successful unary request`);
            providerPoolManager.markProviderHealthy(effectiveProvider, { uuid: effectiveUuid });
        }
    } catch (error) {
        const status = getHttpStatus(error);

        // 确定性失败 / 5xx：立即熔断并尝试在同一次请求内 failover 重试一次
        if (canFastFailover(status)) {
            const kind = is5xx(status) ? '5xx' : '确定性失败';
            console.log(`[Provider Pool] 检测到一元请求 ${status} (${kind})，立即熔断并尝试 failover: ${effectiveProvider} (${effectiveUuid})`);

            if (is5xx(status)) {
                if (typeof providerPoolManager.markProviderServerError === 'function') {
                    providerPoolManager.markProviderServerError(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            } else {
                if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                    providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            }

            try {
                const { getApiServiceWithFallback } = await import('./service-manager.js');
                const result = await getApiServiceWithFallback(requestConfig, effectiveModel);
                if (result?.service) {
                    const previousProvider = effectiveProvider;
                    effectiveService = result.service;
                    effectiveProvider = result.actualProviderType || effectiveProvider;
                    effectiveUuid = result.uuid || effectiveUuid;
                    effectiveCustomName = result.serviceConfig?.customName || effectiveCustomName;
                    if (result.actualModel && result.actualModel !== effectiveModel) {
                        console.log(`[Content Generation] Model Fallback: ${effectiveModel} -> ${result.actualModel}`);
                        effectiveModel = result.actualModel;
                    }

                    if (getProtocolPrefix(previousProvider) !== getProtocolPrefix(effectiveProvider)) {
                        console.log(`[Request Convert] Fallback 触发，二次转换请求: ${previousProvider} -> ${effectiveProvider}`);
                        try {
                            effectiveRequestBody = convertData(effectiveRequestBody, 'request', previousProvider, effectiveProvider);
                        } catch (convertError) {
                            console.error(`[Request Convert] 二次转换失败: ${convertError.message}`);
                            // 视为确定性失败：避免该节点被反复选中
                            if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                                providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: effectiveUuid }, `Request convert failed: ${convertError.message}`);
                            } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                                providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, `Request convert failed: ${convertError.message}`);
                            }
                            throw convertError;
                        }
                    }

                    const needsConversion = getProtocolPrefix(fromProvider) !== getProtocolPrefix(effectiveProvider);
                    const retryNativeResponse = await generateContentWithRetry(effectiveService, effectiveProvider, effectiveUuid, effectiveModel, effectiveRequestBody);
                    const retryText = extractResponseText(retryNativeResponse, effectiveProvider);

                    let retryClientResponse = retryNativeResponse;
                    if (needsConversion) {
                        console.log(`[Response Convert] Converting response from ${effectiveProvider} to ${fromProvider}`);
                        retryClientResponse = convertData(retryNativeResponse, 'response', effectiveProvider, fromProvider, effectiveModel);
                    }

                    await handleUnifiedResponse(res, JSON.stringify(retryClientResponse), false);
                    await logConversation('output', retryText, PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);

                    if (providerPoolManager && effectiveUuid) {
                        const customNameDisplay = effectiveCustomName ? `, ${effectiveCustomName}` : '';
                        console.log(`[Provider Pool] Increasing usage count for ${effectiveProvider} (${effectiveUuid}${customNameDisplay}) after successful unary request (failover)`);
                        providerPoolManager.markProviderHealthy(effectiveProvider, { uuid: effectiveUuid });
                    }
                    return;
                }
            } catch (failoverError) {
                // failover 过程出错，走统一错误返回
                error = failoverError;
            }
        }

        console.error('\n[Server] Error during unary processing:', error.stack);
        if (providerPoolManager && effectiveUuid) {
            const finalStatus = getHttpStatus(error);
            if (isTransientFailure(error, finalStatus)) {
                console.log(`[Provider Pool] 一元错误(${finalStatus ?? error?.code ?? 'TRANSIENT'})判定为瞬时错误，不标记节点不健康: ${effectiveProvider} (${effectiveUuid})`);
            } else if (is5xx(finalStatus)) {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to 5xx unary error`);
                if (typeof providerPoolManager.markProviderServerError === 'function') {
                    providerPoolManager.markProviderServerError(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            } else if (isDeterministicFailure(finalStatus)) {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to deterministic unary error (${finalStatus})`);
                if (typeof providerPoolManager.markProviderDeterministicFailure === 'function') {
                    providerPoolManager.markProviderDeterministicFailure(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else if (typeof providerPoolManager.markProviderUnhealthyImmediate === 'function') {
                    providerPoolManager.markProviderUnhealthyImmediate(effectiveProvider, { uuid: effectiveUuid }, error.message);
                } else {
                    providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
                }
            } else {
                console.log(`[Provider Pool] Marking ${effectiveProvider} as unhealthy due to unary error`);
                providerPoolManager.markProviderUnhealthy(effectiveProvider, { uuid: effectiveUuid }, error.message);
            }
        }

        const errorResponse = createErrorResponse(error, fromProvider);
        await handleUnifiedResponse(res, JSON.stringify(errorResponse), false);
    }
}

/**
 * Handles requests for listing available models. It fetches models from the
 * service, transforms them to the format expected by the client (OpenAI, Claude, etc.),
 * and sends the JSON response.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_MODEL_LIST).
 * @param {Object} CONFIG - The server configuration object.
 */
export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    try{
        const clientProviderMap = {
            [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
            [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
        };


        const fromProvider = clientProviderMap[endpointType];
        const toProvider = CONFIG.MODEL_PROVIDER;

        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        // 1. Get the model list in the backend's native format.
        const nativeModelList = await service.listModels();
                
        // 2. Convert the model list to the client's expected format, if necessary.
        let clientModelList = nativeModelList;
        if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
            console.log(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
            clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
        } else {
            console.log(`[ModelList Convert] Model list format matches. No conversion needed.`);
        }

        console.log(`[ModelList Response] Sending model list to client: ${JSON.stringify(clientModelList)}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        console.error('\n[Server] Error during model list processing:', error.stack);
        if (providerPoolManager) {
            // 如果是号池模式，并且请求处理失败，则标记当前使用的提供者为不健康
            providerPoolManager.markProviderUnhealthy(toProvider, {
                uuid: pooluuid
            });
        }
    }
}

/**
 * Handles requests for content generation (both unary and streaming). This function
 * orchestrates request body parsing, conversion to the internal Gemini format,
 * logging, and dispatching to the appropriate stream or unary handler.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {http.ServerResponse} res The HTTP response object.
 * @param {string} endpointType The type of endpoint being called (e.g., OPENAI_CHAT).
 * @param {Object} CONFIG - The server configuration object.
 * @param {string} PROMPT_LOG_FILENAME - The prompt log filename.
 */
export async function handleContentGenerationRequest(req, res, service, endpointType, CONFIG, PROMPT_LOG_FILENAME, providerPoolManager, pooluuid) {
    const originalRequestBody = await getRequestBody(req);
    if (!originalRequestBody) {
        throw new Error("Request body is missing for content generation.");
    }

    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_CHAT]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.OPENAI_RESPONSES]: MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES,
        [ENDPOINT_TYPE.CLAUDE_MESSAGE]: MODEL_PROTOCOL_PREFIX.CLAUDE,
        [ENDPOINT_TYPE.GEMINI_CONTENT]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];
    // 使用实际的提供商类型（可能是 fallback 后的类型）
    let toProvider = CONFIG.actualProviderType || CONFIG.MODEL_PROVIDER;
    let actualUuid = pooluuid;
    
    if (!fromProvider) {
        throw new Error(`Unsupported endpoint type for content generation: ${endpointType}`);
    }

    // 2. Extract model and determine if the request is for streaming.
    let { model, isStream } = _extractModelAndStreamInfo(req, originalRequestBody, fromProvider);

    if (!model) {
        throw new Error("Could not determine the model from the request.");
    }
    console.log(`[Content Generation] Model: ${model}, Stream: ${isStream}`);

    let actualCustomName = CONFIG.customName;

    // 2.5. 如果使用了提供商池，根据模型重新选择提供商（支持 Fallback）
    // 注意：这里使用 skipUsageCount: true，因为初次选择时已经增加了 usageCount
    if (providerPoolManager && CONFIG.providerPools && CONFIG.providerPools[CONFIG.MODEL_PROVIDER]) {
        const { getApiServiceWithFallback } = await import('./service-manager.js');
        const result = await getApiServiceWithFallback(CONFIG, model);
        
        service = result.service;
        toProvider = result.actualProviderType;
        actualUuid = result.uuid || pooluuid;
        actualCustomName = result.serviceConfig?.customName || CONFIG.customName;
        
        // 如果发生了模型级别的 fallback，需要更新请求使用的模型
        if (result.actualModel && result.actualModel !== model) {
            console.log(`[Content Generation] Model Fallback: ${model} -> ${result.actualModel}`);
            model = result.actualModel;
        }

        if (result.isFallback) {
            console.log(`[Content Generation] Fallback activated: ${CONFIG.MODEL_PROVIDER} -> ${toProvider} (uuid: ${actualUuid})`);
        } else {
            console.log(`[Content Generation] Re-selected service adapter based on model: ${model}`);
        }
    }

    // 1. Convert request body from client format to backend format, if necessary.
    let processedRequestBody = originalRequestBody;
    // fs.writeFile('originalRequestBody'+Date.now()+'.json', JSON.stringify(originalRequestBody));
    if (getProtocolPrefix(fromProvider) !== getProtocolPrefix(toProvider)) {
        console.log(`[Request Convert] Converting request from ${fromProvider} to ${toProvider}`);
        processedRequestBody = convertData(originalRequestBody, 'request', fromProvider, toProvider);
    } else {
        console.log(`[Request Convert] Request format matches backend provider. No conversion needed.`);
    }

    // 3. Apply system prompt from file if configured.
    processedRequestBody = await _applySystemPromptFromFile(CONFIG, processedRequestBody, toProvider);
    await _manageSystemPrompt(processedRequestBody, toProvider);

    // 4. Log the incoming prompt (after potential conversion to the backend's format).
    const promptText = extractPromptText(processedRequestBody, toProvider);
    await logConversation('input', promptText, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME);
    
    // 5. Call the appropriate stream or unary handler, passing the provider info.
    if (isStream) {
        await handleStreamRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, CONFIG);
    } else {
        await handleUnaryRequest(res, service, model, processedRequestBody, fromProvider, toProvider, CONFIG.PROMPT_LOG_MODE, PROMPT_LOG_FILENAME, providerPoolManager, actualUuid, actualCustomName, CONFIG);
    }
}

/**
 * Helper function to extract model and stream information from the request.
 * @param {http.IncomingMessage} req The HTTP request object.
 * @param {Object} requestBody The parsed request body.
 * @param {string} fromProvider The type of endpoint being called.
 * @returns {{model: string, isStream: boolean}} An object containing the model name and stream status.
 */
function _extractModelAndStreamInfo(req, requestBody, fromProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(fromProvider));
    return strategy.extractModelAndStreamInfo(req, requestBody);
}

async function _applySystemPromptFromFile(config, requestBody, toProvider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(toProvider));
    return strategy.applySystemPromptFromFile(config, requestBody);
}

export async function _manageSystemPrompt(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    await strategy.manageSystemPrompt(requestBody);
}

// Helper functions for content extraction and conversion (from convert.js, but needed here)
export function extractResponseText(response, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractResponseText(response);
}

export function extractPromptText(requestBody, provider) {
    const strategy = ProviderStrategyFactory.getStrategy(getProtocolPrefix(provider));
    return strategy.extractPromptText(requestBody);
}

export function handleError(res, error, provider = null) {
    const statusCode = error.response?.status || error.statusCode || error.status || error.code || 500;
    let errorMessage = error.message;
    let suggestions = [];

    // 仅在没有传入错误信息时，才使用默认消息；否则只添加建议
    const hasOriginalMessage = error.message && error.message.trim() !== '';

    // 根据提供商获取适配的错误信息和建议
    const providerSuggestions = _getProviderSpecificSuggestions(statusCode, provider);
    
    // Provide detailed information and suggestions for different error types
    switch (statusCode) {
        case 401:
            errorMessage = 'Authentication failed. Please check your credentials.';
            suggestions = providerSuggestions.auth;
            break;
        case 403:
            errorMessage = 'Access forbidden. Insufficient permissions.';
            suggestions = providerSuggestions.permission;
            break;
        case 429:
            errorMessage = 'Too many requests. Rate limit exceeded.';
            suggestions = providerSuggestions.rateLimit;
            break;
        case 500:
        case 502:
        case 503:
        case 504:
            errorMessage = 'Server error occurred. This is usually temporary.';
            suggestions = providerSuggestions.serverError;
            break;
        default:
            if (statusCode >= 400 && statusCode < 500) {
                errorMessage = `Client error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.clientError;
            } else if (statusCode >= 500) {
                errorMessage = `Server error (${statusCode}): ${error.message}`;
                suggestions = providerSuggestions.serverError;
            }
    }

    errorMessage = hasOriginalMessage ? error.message.trim() : errorMessage;
    console.error(`\n[Server] Request failed (${statusCode}): ${errorMessage}`);
    if (suggestions.length > 0) {
        console.error('[Server] Suggestions:');
        suggestions.forEach((suggestion, index) => {
            console.error(`  ${index + 1}. ${suggestion}`);
        });
    }
    console.error('[Server] Full error details:', error.stack);

    if (!res.headersSent) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    }

    const errorPayload = {
        error: {
            message: errorMessage,
            code: statusCode,
            suggestions: suggestions,
            details: error.response?.data
        }
    };
    res.end(JSON.stringify(errorPayload));
}

/**
 * 根据提供商类型获取适配的错误建议
 * @param {number} statusCode - HTTP 状态码
 * @param {string|null} provider - 提供商类型
 * @returns {Object} 包含各类错误建议的对象
 */
function _getProviderSpecificSuggestions(statusCode, provider) {
    const protocolPrefix = provider ? getProtocolPrefix(provider) : null;
    
    // 默认/通用建议
    const defaultSuggestions = {
        auth: [
            'Verify your API key or credentials are valid',
            'Check if your credentials have expired',
            'Ensure the API key has the necessary permissions'
        ],
        permission: [
            'Check if your account has the necessary permissions',
            'Verify the API endpoint is accessible with your credentials',
            'Contact your administrator if permissions are restricted'
        ],
        rateLimit: [
            'The request has been automatically retried with exponential backoff',
            'If the issue persists, try reducing the request frequency',
            'Consider upgrading your API quota if available'
        ],
        serverError: [
            'The request has been automatically retried',
            'If the issue persists, try again in a few minutes',
            'Check the service status page for outages'
        ],
        clientError: [
            'Check your request format and parameters',
            'Verify the model name is correct',
            'Ensure all required fields are provided'
        ]
    };
    
    // 根据提供商返回特定建议
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            return {
                auth: [
                    'Verify your OAuth credentials are valid',
                    'Try re-authenticating by deleting the credentials file',
                    'Check if your Google Cloud project has the necessary permissions'
                ],
                permission: [
                    'Ensure your Google Cloud project has the Gemini API enabled',
                    'Check if your account has the necessary permissions',
                    'Verify the project ID is correct'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Google Cloud API quota'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Google Cloud status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Gemini model',
                    'Ensure all required fields are provided'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI:
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            return {
                auth: [
                    'Verify your OpenAI API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the API key is correctly formatted (starts with sk-)'
                ],
                permission: [
                    'Check if your OpenAI account has access to the requested model',
                    'Verify your organization settings allow this operation',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your OpenAI usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check OpenAI status page (status.openai.com) for outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid OpenAI model',
                    'Ensure the message format is correct (role and content fields)'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            return {
                auth: [
                    'Verify your Anthropic API key is valid',
                    'Check if your API key has expired or been revoked',
                    'Ensure the x-api-key header is correctly set'
                ],
                permission: [
                    'Check if your Anthropic account has access to the requested model',
                    'Verify your account is in good standing',
                    'Ensure you have sufficient credits in your account'
                ],
                rateLimit: [
                    'The request has been automatically retried with exponential backoff',
                    'If the issue persists, try reducing the request frequency',
                    'Consider upgrading your Anthropic usage tier for higher limits'
                ],
                serverError: [
                    'The request has been automatically retried',
                    'If the issue persists, try again in a few minutes',
                    'Check Anthropic status page for service outages'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is a valid Claude model',
                    'Ensure the message format follows Anthropic API specifications'
                ]
            };
            
        case MODEL_PROTOCOL_PREFIX.OLLAMA:
            return {
                auth: [
                    'Ollama typically does not require authentication',
                    'If using a custom setup, verify your credentials',
                    'Check if the Ollama server requires authentication'
                ],
                permission: [
                    'Verify the Ollama server is accessible',
                    'Check if the requested model is available locally',
                    'Ensure the Ollama server allows the requested operation'
                ],
                rateLimit: [
                    'The local Ollama server may be overloaded',
                    'Try reducing concurrent requests',
                    'Consider increasing server resources if running locally'
                ],
                serverError: [
                    'Check if the Ollama server is running',
                    'Verify the server address and port are correct',
                    'Check Ollama server logs for detailed error information'
                ],
                clientError: [
                    'Check your request format and parameters',
                    'Verify the model name is available in your Ollama installation',
                    'Try pulling the model first with: ollama pull <model-name>'
                ]
            };
            
        default:
            return defaultSuggestions;
    }
}

/**
 * 从请求体中提取系统提示词。
 * @param {Object} requestBody - 请求体对象。
 * @param {string} provider - 提供商类型（'openai', 'gemini', 'claude'）。
 * @returns {string} 提取到的系统提示词字符串。
 */
export function extractSystemPromptFromRequestBody(requestBody, provider) {
    let incomingSystemText = '';
    switch (provider) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            const openaiSystemMessage = requestBody.messages?.find(m => m.role === 'system');
            if (openaiSystemMessage?.content) {
                incomingSystemText = openaiSystemMessage.content;
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system message
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    incomingSystemText = userMessage.content;
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            const geminiSystemInstruction = requestBody.system_instruction || requestBody.systemInstruction;
            if (geminiSystemInstruction?.parts) {
                incomingSystemText = geminiSystemInstruction.parts
                    .filter(p => p?.text)
                    .map(p => p.text)
                    .join('\n');
            } else if (requestBody.contents?.length > 0) {
                // Fallback to first user content if no system instruction
                const userContent = requestBody.contents[0];
                if (userContent?.parts) {
                    incomingSystemText = userContent.parts
                        .filter(p => p?.text)
                        .map(p => p.text)
                        .join('\n');
                }
            }
            break;
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            if (typeof requestBody.system === 'string') {
                incomingSystemText = requestBody.system;
            } else if (typeof requestBody.system === 'object') {
                incomingSystemText = JSON.stringify(requestBody.system);
            } else if (requestBody.messages?.length > 0) {
                // Fallback to first user message if no system property
                const userMessage = requestBody.messages.find(m => m.role === 'user');
                if (userMessage) {
                    if (Array.isArray(userMessage.content)) {
                        incomingSystemText = userMessage.content.map(block => block.text).join('');
                    } else {
                        incomingSystemText = userMessage.content;
                    }
                }
            }
            break;
        default:
            console.warn(`[System Prompt] Unknown provider: ${provider}`);
            break;
    }
    return incomingSystemText;
}

/**
 * Generates an MD5 hash for a given object by first converting it to a JSON string.
 * @param {object} obj - The object to hash.
 * @returns {string} The MD5 hash of the object's JSON string representation.
 */
export function getMD5Hash(obj) {
    const jsonString = JSON.stringify(obj);
    return crypto.createHash('md5').update(jsonString).digest('hex');
}


/**
 * 创建符合 fromProvider 格式的错误响应（非流式）
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {Object} 格式化的错误响应对象
 */
function createErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = error.status || error.code || 500;
    const errorMessage = error.message || "An error occurred during processing.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 非流式错误格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)  // OpenAI 使用 code 字段作为核心判断
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 非流式错误格式
            return {
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 非流式错误格式（外层有 type 标记）
            return {
                type: "error",  // 核心区分标记
                error: {
                    type: getErrorType(statusCode),  // Claude 使用 error.type 作为核心判断
                    message: errorMessage
                }
            };
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 非流式错误格式（遵循 Google Cloud 标准）
            return {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)  // Gemini 使用 status 作为核心判断
                }
            };
            
        default:
            // 默认使用 OpenAI 格式
            return {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: getErrorType(statusCode)
                }
            };
    }
}

/**
 * 创建符合 fromProvider 格式的流式错误响应
 * @param {Error} error - 错误对象
 * @param {string} fromProvider - 客户端期望的提供商格式
 * @returns {string} 格式化的流式错误响应字符串
 */
function createStreamErrorResponse(error, fromProvider) {
    const protocolPrefix = getProtocolPrefix(fromProvider);
    const statusCode = error.status || error.code || 500;
    const errorMessage = error.message || "An error occurred during streaming.";
    
    // 根据 HTTP 状态码映射错误类型
    const getErrorType = (code) => {
        if (code === 401) return 'authentication_error';
        if (code === 403) return 'permission_error';
        if (code === 429) return 'rate_limit_error';
        if (code >= 500) return 'server_error';
        return 'invalid_request_error';
    };
    
    // 根据 HTTP 状态码映射 Gemini 的 status
    const getGeminiStatus = (code) => {
        if (code === 400) return 'INVALID_ARGUMENT';
        if (code === 401) return 'UNAUTHENTICATED';
        if (code === 403) return 'PERMISSION_DENIED';
        if (code === 404) return 'NOT_FOUND';
        if (code === 429) return 'RESOURCE_EXHAUSTED';
        if (code >= 500) return 'INTERNAL';
        return 'UNKNOWN';
    };
    
    switch (protocolPrefix) {
        case MODEL_PROTOCOL_PREFIX.OPENAI:
            // OpenAI 流式错误格式（SSE data 块）
            const openaiError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(openaiError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.OPENAI_RESPONSES:
            // OpenAI Responses API 流式错误格式（SSE event + data）
            const responsesError = {
                id: `resp_${Date.now()}`,
                object: "error",
                created: Math.floor(Date.now() / 1000),
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage,
                    code: getErrorType(statusCode)
                }
            };
            return `event: error\ndata: ${JSON.stringify(responsesError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.CLAUDE:
            // Claude 流式错误格式（SSE event + data）
            const claudeError = {
                type: "error",
                error: {
                    type: getErrorType(statusCode),
                    message: errorMessage
                }
            };
            return `event: error\ndata: ${JSON.stringify(claudeError)}\n\n`;
            
        case MODEL_PROTOCOL_PREFIX.GEMINI:
            // Gemini 流式错误格式
            // 注意：虽然 Gemini 原生使用 JSON 数组，但在我们的实现中已经转换为 SSE 格式
            // 所以这里也需要使用 data: 前缀，保持与正常流式响应一致
            const geminiError = {
                error: {
                    code: statusCode,
                    message: errorMessage,
                    status: getGeminiStatus(statusCode)
                }
            };
            return `data: ${JSON.stringify(geminiError)}\n\n`;
            
        default:
            // 默认使用 OpenAI SSE 格式
            const defaultError = {
                error: {
                    message: errorMessage,
                    type: getErrorType(statusCode),
                    code: null
                }
            };
            return `data: ${JSON.stringify(defaultError)}\n\n`;
    }
}
