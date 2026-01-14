import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { getProviderModels } from '../provider-models.js';
import { countTokens } from '@anthropic-ai/tokenizer';
import { configureAxiosProxy } from '../proxy-utils.js';
import { CLAUDE_DEFAULT_MAX_TOKENS } from '../converters/utils.js';

const KIRO_THINKING = {
    MAX_BUDGET_TOKENS: 24576,
    DEFAULT_BUDGET_TOKENS: 20000,
    START_TAG: '<thinking>',
    END_TAG: '</thinking>',
    MODE_TAG: '<thinking_mode>',
    MAX_LEN_TAG: '<max_thinking_length>',
};

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
    AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
    USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
    DEFAULT_MODEL_NAME: 'claude-opus-4-5',
    AXIOS_TIMEOUT: 300000, // 5 minutes timeout (increased from 2 minutes)
    USER_AGENT: 'KiroIDE',
    KIRO_VERSION: '0.7.5',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
};

// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels('claude-kiro-oauth');

// 完整的模型映射表
const FULL_MODEL_MAPPING = {
    "claude-opus-4-5": "claude-opus-4.5",
    "claude-opus-4-5-20251101": "claude-opus-4.5",
    "claude-haiku-4-5": "claude-haiku-4.5",
    "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-5-20250929": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",
    "claude-3-7-sonnet-20250219": "CLAUDE_3_7_SONNET_20250219_V1_0"
};

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

/**
 * 根据当前配置生成唯一的机器码（Machine ID）
 * 确保每个配置对应一个唯一且不变的 ID
 * @param {Object} credentials - 当前凭证信息
 * @returns {string} SHA256 格式的机器码
 */
function generateMachineIdFromConfig(credentials) {
    // 优先级：节点UUID > profileArn > clientId > fallback
    const uniqueKey = credentials.uuid || credentials.profileArn || credentials.clientId || "KIRO_DEFAULT_MACHINE";
    return crypto.createHash('sha256').update(uniqueKey).digest('hex');
}

/**
 * 实时获取系统配置信息，用于生成 User-Agent
 * @returns {Object} 包含 osName, nodeVersion 等信息
 */
function getSystemRuntimeInfo() {
    const osPlatform = os.platform();
    const osRelease = os.release();
    const nodeVersion = process.version.replace('v', '');

    let osName = osPlatform;
    if (osPlatform === 'win32') osName = `windows#${osRelease}`;
    else if (osPlatform === 'darwin') osName = `macos#${osRelease}`;
    else osName = `${osPlatform}#${osRelease}`;

    return {
        osName,
        nodeVersion
    };
}

// =============================================================================
// 基于权重的上下文压缩系统 - 消息分类打分策略
// =============================================================================

/**
 * 权重压缩配置常量
 */
const WEIGHT_COMPRESSION_CONFIG = {
    // 摘要 API 地址（使用本地代理）
    SUMMARY_API_URL: 'http://localhost:3060/claude-kiro-oauth/v1/messages',

    // 摘要模型
    SUMMARY_MODEL: 'claude-opus-4-5-20251101',
    SUMMARY_MODEL_ID: 'claude-opus-4.5',

    // 消息分类权重
    WEIGHTS: {
        USER_INSTRUCTION: 100,      // 用户指令：最高优先级
        KEY_STATE: 80,              // 关键状态：代码修改、文件操作、重要决策
        INTERMEDIATE_REASONING: 40, // 中间推理：查询、分析、思考
        FAILURE_RECORD: 20          // 失败记录：错误、异常、失败的尝试
    },

    // 压缩阈值
    HIGH_SCORE_THRESHOLD: 70,       // 高分阈值：完整保留
    LOW_SCORE_THRESHOLD: 30,        // 低分阈值：合并摘要

    // 时间加成（越新的消息加分越多）
    MAX_RECENCY_BONUS: 20,

    // 摘要配置
    LOW_SCORE_SUMMARY_MAX_TOKENS: 2000,

    // 保留最近 N 条消息不压缩
    KEEP_RECENT_COUNT: 10,

    // 代码块保留设置
    MAX_CODE_BLOCKS_TO_KEEP: 10,
    MAX_CODE_BLOCK_LINES: 50,

    // 缓存设置
    CACHE_MAX_SIZE: 200,              // 增加缓存容量
    CACHE_TTL_MS: 2 * 60 * 60 * 1000, // 2 小时（延长缓存时间）
};

// 关键词定义
const CLASSIFICATION_KEYWORDS = {
    // 用户指令关键词
    USER_INSTRUCTION: [
        '帮我', '请', '修改', '实现', '添加', '删除', '创建', '修复', '优化',
        '怎么', '如何', '为什么', '什么是', '能不能', '可以',
        'help', 'please', 'fix', 'add', 'remove', 'create', 'implement',
        'how', 'what', 'why', 'can you', 'could you', 'would you'
    ],
    // 关键状态工具（修改类操作）
    KEY_STATE_TOOLS: ['Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite'],
    // 用户确认关键词
    USER_CONFIRMATION: [
        '好的', '确认', '同意', '可以', '行', '对', '是的', '没问题',
        'ok', 'yes', 'sure', 'confirmed', 'agree', 'approved', 'lgtm'
    ],
    // 失败关键词
    FAILURE: [
        'error', 'failed', 'exception', 'Error', 'Failed', 'Exception',
        'TypeError', 'SyntaxError', 'ReferenceError', 'cannot', 'unable',
        '错误', '失败', '异常', '不行', '无法', '报错', '出错'
    ],
    // 查询类工具（中间推理）
    QUERY_TOOLS: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task']
};

// 兼容旧配置名（向后兼容）
const SUMMARY_CONFIG = WEIGHT_COMPRESSION_CONFIG;

// =============================================================================
// 语义去重系统 - 合并重复的工具调用结果
// =============================================================================

/**
 * 语义去重配置常量
 */
const DEDUP_CONFIG = {
    // 启用开关
    ENABLE_DEDUPLICATION: true,

    // 相似度阈值
    EXACT_MATCH_THRESHOLD: 1.0,       // 完全匹配
    HIGH_SIMILARITY_THRESHOLD: 0.9,   // 高相似度（去重+引用）
    LOW_SIMILARITY_THRESHOLD: 0.5,    // 低相似度（保留差异摘要）

    // 幂等工具列表（可安全去重）
    IDEMPOTENT_TOOLS: ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'],

    // 修改类工具列表（触发文件失效）
    MODIFYING_TOOLS: ['Edit', 'Write', 'NotebookEdit'],

    // 只读 Bash 命令白名单
    READONLY_BASH_COMMANDS: [
        'ls', 'cat', 'head', 'tail', 'find', 'grep', 'pwd', 'which', 'echo',
        'wc', 'du', 'df', 'file', 'stat', 'tree', 'less', 'more', 'diff',
        'git status', 'git log', 'git diff', 'git branch', 'git show',
        'npm list', 'npm ls', 'node -v', 'npm -v', 'python --version'
    ],

    // 写入 Bash 命令黑名单关键词
    WRITE_BASH_KEYWORDS: [
        '>', '>>', 'rm ', 'rm\t', 'mv ', 'cp ', 'mkdir ', 'touch ',
        'sed -i', 'awk -i', 'chmod ', 'chown ', 'npm install', 'npm i ',
        'pip install', 'apt ', 'yum ', 'brew '
    ],

    // 引用模板
    REFERENCE_TEMPLATE: '[此结果与消息 #{index} 相同，已省略约 {tokens} tokens]',
    DIFF_TEMPLATE: '[文件已变化] 相比消息 #{index}: {summary}'
};

/**
 * 文件修改追踪器
 * 追踪哪些文件在对话中被修改过，用于判断旧的 Read 结果是否过期
 */
class FileModificationTracker {
    constructor() {
        // 文件路径 → 最后修改的消息索引
        this.modifications = new Map();
    }

    /**
     * 记录文件修改
     * @param {string} filePath - 文件路径
     * @param {number} messageIndex - 消息索引
     */
    recordModification(filePath, messageIndex) {
        if (!filePath) return;
        // 标准化路径
        const normalizedPath = this._normalizePath(filePath);
        const existing = this.modifications.get(normalizedPath);
        if (!existing || existing < messageIndex) {
            this.modifications.set(normalizedPath, messageIndex);
        }
    }

    /**
     * 检查某个文件的读取结果是否已失效
     * @param {string} filePath - 文件路径
     * @param {number} readIndex - 读取操作的消息索引
     * @returns {boolean} 是否已失效
     */
    isInvalidated(filePath, readIndex) {
        if (!filePath) return false;
        const normalizedPath = this._normalizePath(filePath);
        const lastModified = this.modifications.get(normalizedPath);
        // 如果文件在读取之后被修改过，则该读取结果已失效
        return lastModified !== undefined && lastModified > readIndex;
    }

    /**
     * 获取文件最后修改的消息索引
     * @param {string} filePath - 文件路径
     * @returns {number|undefined}
     */
    getLastModification(filePath) {
        if (!filePath) return undefined;
        return this.modifications.get(this._normalizePath(filePath));
    }

    /**
     * 标准化文件路径
     */
    _normalizePath(filePath) {
        // 统一使用正斜杠，去除首尾空格
        return filePath.trim().replace(/\\/g, '/').toLowerCase();
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            trackedFiles: this.modifications.size,
            files: Array.from(this.modifications.entries())
        };
    }
}

/**
 * 去重索引表
 * 维护工具调用指纹到消息记录的映射
 */
class DeduplicationIndex {
    constructor() {
        // 指纹 → 调用记录列表
        this.index = new Map();
    }

    /**
     * 添加工具调用记录
     * @param {string} fingerprint - 工具调用指纹
     * @param {Object} record - 调用记录
     */
    add(fingerprint, record) {
        if (!this.index.has(fingerprint)) {
            this.index.set(fingerprint, []);
        }
        this.index.get(fingerprint).push(record);
    }

    /**
     * 查找相同指纹的记录
     * @param {string} fingerprint - 工具调用指纹
     * @returns {Array} 记录列表
     */
    find(fingerprint) {
        return this.index.get(fingerprint) || [];
    }

    /**
     * 获取统计信息
     */
    getStats() {
        let totalRecords = 0;
        let duplicateFingerprints = 0;
        for (const records of this.index.values()) {
            totalRecords += records.length;
            if (records.length > 1) {
                duplicateFingerprints++;
            }
        }
        return {
            uniqueFingerprints: this.index.size,
            totalRecords,
            duplicateFingerprints
        };
    }
}

/**
 * 从消息中提取工具调用详情
 * @param {Object} message - 消息对象
 * @param {number} messageIndex - 消息索引
 * @returns {Array<Object>} 工具调用列表
 */
function extractToolCallDetails(message, messageIndex) {
    const toolCalls = [];

    if (!Array.isArray(message.content)) {
        return toolCalls;
    }

    // 先收集所有 tool_use
    const toolUseMap = new Map();
    for (const part of message.content) {
        if (part.type === 'tool_use' && part.id) {
            toolUseMap.set(part.id, {
                toolName: part.name,
                params: part.input || {},
                toolUseId: part.id
            });
        }
    }

    // 再收集 tool_result 并关联
    for (const part of message.content) {
        if (part.type === 'tool_result' && part.tool_use_id) {
            const toolUse = toolUseMap.get(part.tool_use_id);
            const resultContent = typeof part.content === 'string'
                ? part.content
                : JSON.stringify(part.content || '');

            toolCalls.push({
                toolName: toolUse?.toolName || '__unknown__',
                params: toolUse?.params || {},
                toolUseId: part.tool_use_id,
                resultContent,
                resultContentHash: crypto.createHash('md5').update(resultContent).digest('hex'),
                messageIndex,
                isError: part.is_error || false
            });
        }
    }

    // 处理只有 tool_use 没有 tool_result 的情况（assistant 消息）
    if (message.role === 'assistant') {
        for (const part of message.content) {
            if (part.type === 'tool_use' && part.id) {
                toolCalls.push({
                    toolName: part.name,
                    params: part.input || {},
                    toolUseId: part.id,
                    resultContent: null,
                    resultContentHash: null,
                    messageIndex,
                    isToolUseOnly: true
                });
            }
        }
    }

    return toolCalls;
}

/**
 * 生成工具调用的指纹
 * @param {Object} toolCall - 工具调用对象
 * @returns {string|null} 指纹字符串，如果不支持去重则返回 null
 */
function generateToolFingerprint(toolCall) {
    const { toolName, params } = toolCall;

    // 检查是否为幂等工具
    if (!DEDUP_CONFIG.IDEMPOTENT_TOOLS.includes(toolName) && toolName !== 'Bash') {
        return null;
    }

    switch (toolName) {
        case 'Read':
            // Read: 基于文件路径
            return `read:${params.file_path || params.path || ''}`;

        case 'Grep':
            // Grep: 基于 pattern + path + 主要选项
            return `grep:${params.pattern || ''}:${params.path || ''}:${params.glob || ''}`;

        case 'Glob':
            // Glob: 基于 pattern + path
            return `glob:${params.pattern || ''}:${params.path || ''}`;

        case 'WebFetch':
            // WebFetch: 基于 URL
            return `webfetch:${params.url || ''}`;

        case 'WebSearch':
            // WebSearch: 基于查询
            return `websearch:${params.query || ''}`;

        case 'Bash':
            // Bash: 只对只读命令生成指纹
            const command = params.command || '';
            if (isReadOnlyBashCommand(command)) {
                return `bash:${crypto.createHash('md5').update(command).digest('hex')}`;
            }
            return null;

        default:
            return null;
    }
}

/**
 * 判断 Bash 命令是否为只读命令
 * @param {string} command - Bash 命令
 * @returns {boolean}
 */
function isReadOnlyBashCommand(command) {
    if (!command) return false;

    const trimmedCommand = command.trim().toLowerCase();

    // 检查是否包含写入关键词
    for (const keyword of DEDUP_CONFIG.WRITE_BASH_KEYWORDS) {
        if (trimmedCommand.includes(keyword.toLowerCase())) {
            return false;
        }
    }

    // 检查是否以只读命令开头
    for (const readonlyCmd of DEDUP_CONFIG.READONLY_BASH_COMMANDS) {
        if (trimmedCommand.startsWith(readonlyCmd.toLowerCase())) {
            return true;
        }
    }

    return false;
}

/**
 * 从工具调用中提取受影响的文件路径
 * @param {Object} toolCall - 工具调用对象
 * @returns {Array<string>} 受影响的文件路径列表
 */
function extractAffectedFiles(toolCall) {
    const { toolName, params, resultContent } = toolCall;
    const files = [];

    switch (toolName) {
        case 'Edit':
        case 'Write':
        case 'Read':
            if (params.file_path) files.push(params.file_path);
            if (params.path) files.push(params.path);
            break;

        case 'NotebookEdit':
            if (params.notebook_path) files.push(params.notebook_path);
            break;

        case 'Bash':
            // 尝试从命令中提取文件路径
            const command = params.command || '';
            const filePatterns = extractFilesFromBashCommand(command);
            files.push(...filePatterns);
            break;
    }

    return files.filter(f => f && typeof f === 'string');
}

/**
 * 从 Bash 命令中提取可能被修改的文件路径
 * @param {string} command - Bash 命令
 * @returns {Array<string>}
 */
function extractFilesFromBashCommand(command) {
    const files = [];
    if (!command) return files;

    // 匹配重定向目标文件
    const redirectMatch = command.match(/>\s*["']?([^"'\s>]+)["']?/g);
    if (redirectMatch) {
        for (const match of redirectMatch) {
            const file = match.replace(/^>\s*["']?/, '').replace(/["']?$/, '');
            if (file && !file.startsWith('/dev/')) {
                files.push(file);
            }
        }
    }

    // 匹配 sed -i 的目标文件
    const sedMatch = command.match(/sed\s+-i[^\s]*\s+['"][^'"]*['"]\s+["']?([^"'\s]+)["']?/);
    if (sedMatch && sedMatch[1]) {
        files.push(sedMatch[1]);
    }

    return files;
}

/**
 * 计算两个字符串的相似度（基于行的比较）
 * @param {string} str1 - 字符串1
 * @param {string} str2 - 字符串2
 * @returns {{similarity: number, diffSummary: string}}
 */
function calculateSimilarity(str1, str2) {
    if (!str1 && !str2) return { similarity: 1.0, diffSummary: '' };
    if (!str1 || !str2) return { similarity: 0, diffSummary: '内容完全不同' };

    // 完全相同
    if (str1 === str2) {
        return { similarity: 1.0, diffSummary: '' };
    }

    // 基于行的比较
    const lines1 = str1.split('\n');
    const lines2 = str2.split('\n');

    // 使用简单的 LCS 近似计算
    const set1 = new Set(lines1);
    const set2 = new Set(lines2);

    let commonLines = 0;
    for (const line of set1) {
        if (set2.has(line)) {
            commonLines++;
        }
    }

    const totalUniqueLines = new Set([...lines1, ...lines2]).size;
    const similarity = totalUniqueLines > 0 ? commonLines / totalUniqueLines : 0;

    // 生成差异摘要
    const addedLines = lines2.filter(l => !set1.has(l)).length;
    const removedLines = lines1.filter(l => !set2.has(l)).length;
    const diffSummary = `+${addedLines}行 -${removedLines}行`;

    return {
        similarity: Math.round(similarity * 100) / 100,
        diffSummary
    };
}

/**
 * 估算文本的 token 数量（简单估算）
 * @param {string} text - 文本
 * @returns {number}
 */
function estimateTokens(text) {
    if (!text) return 0;
    // 简单估算：英文约 4 字符/token，中文约 2 字符/token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 2 + otherChars / 4);
}

/**
 * 语义去重主函数
 * 扫描消息数组，合并重复的工具调用结果
 *
 * @param {Array} messages - 原始消息数组
 * @param {Object} config - 配置选项
 * @returns {{messages: Array, stats: Object}}
 */
function deduplicateToolResults(messages, config = {}) {
    const enableDedup = config.KIRO_ENABLE_DEDUPLICATION ?? DEDUP_CONFIG.ENABLE_DEDUPLICATION;

    if (!enableDedup || !messages || messages.length === 0) {
        return {
            messages,
            stats: { enabled: false, processed: 0, deduplicated: 0, tokensSaved: 0 }
        };
    }

    console.log(`[Kiro Dedup] Starting semantic deduplication for ${messages.length} messages...`);

    // 初始化追踪器和索引
    const tracker = new FileModificationTracker();
    const index = new DeduplicationIndex();

    // 第一遍：扫描所有消息，建立索引和追踪修改
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const toolCalls = extractToolCallDetails(message, i);

        for (const call of toolCalls) {
            // 检查是否为修改类工具
            if (DEDUP_CONFIG.MODIFYING_TOOLS.includes(call.toolName)) {
                const affectedFiles = extractAffectedFiles(call);
                for (const file of affectedFiles) {
                    tracker.recordModification(file, i);
                }
            } else if (call.toolName === 'Bash') {
                // Bash 命令需要检查是否为写入操作
                const command = call.params.command || '';
                if (!isReadOnlyBashCommand(command)) {
                    const affectedFiles = extractAffectedFiles(call);
                    for (const file of affectedFiles) {
                        tracker.recordModification(file, i);
                    }
                }
            }

            // 为幂等工具生成指纹并加入索引
            const fingerprint = generateToolFingerprint(call);
            if (fingerprint && call.resultContent) {
                index.add(fingerprint, {
                    messageIndex: i,
                    content: call.resultContent,
                    contentHash: call.resultContentHash,
                    toolUseId: call.toolUseId,
                    params: call.params
                });
            }
        }
    }

    console.log(`[Kiro Dedup] File tracker stats:`, tracker.getStats());
    console.log(`[Kiro Dedup] Index stats:`, index.getStats());

    // 第二遍：执行去重
    const resultMessages = [];
    let deduplicatedCount = 0;
    let tokensSaved = 0;

    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        const toolCalls = extractToolCallDetails(message, i);

        // 如果没有工具调用，直接保留
        if (toolCalls.length === 0 || !Array.isArray(message.content)) {
            resultMessages.push(message);
            continue;
        }

        // 深拷贝消息
        const newMessage = JSON.parse(JSON.stringify(message));
        let messageModified = false;

        // 处理每个 tool_result
        for (let j = 0; j < newMessage.content.length; j++) {
            const part = newMessage.content[j];
            if (part.type !== 'tool_result' || !part.tool_use_id) {
                continue;
            }

            // 找到对应的工具调用信息
            const call = toolCalls.find(c => c.toolUseId === part.tool_use_id);
            if (!call || !call.resultContent) {
                continue;
            }

            // 生成指纹
            const fingerprint = generateToolFingerprint(call);
            if (!fingerprint) {
                continue; // 不支持去重的工具
            }

            // 查找之前的相同调用
            const previousCalls = index.find(fingerprint);
            const earlierCalls = previousCalls.filter(c => c.messageIndex < i);

            if (earlierCalls.length === 0) {
                continue; // 没有之前的调用
            }

            // 获取文件路径（用于检查失效）
            const filePath = call.params.file_path || call.params.path || null;

            // 过滤掉已失效的记录
            const validCalls = earlierCalls.filter(c => {
                if (!filePath) return true;
                return !tracker.isInvalidated(filePath, c.messageIndex);
            });

            if (validCalls.length === 0) {
                continue; // 所有之前的调用都已失效
            }

            // 找到最近的有效调用
            const nearest = validCalls[validCalls.length - 1];

            // 计算相似度
            const { similarity, diffSummary } = calculateSimilarity(call.resultContent, nearest.content);

            // 根据相似度决定处理方式
            if (similarity >= DEDUP_CONFIG.HIGH_SIMILARITY_THRESHOLD) {
                // 高相似度：替换为引用
                const savedTokens = estimateTokens(call.resultContent);
                const reference = DEDUP_CONFIG.REFERENCE_TEMPLATE
                    .replace('{index}', nearest.messageIndex + 1)
                    .replace('{tokens}', savedTokens);

                newMessage.content[j] = {
                    type: 'tool_result',
                    tool_use_id: part.tool_use_id,
                    content: reference
                };

                messageModified = true;
                deduplicatedCount++;
                tokensSaved += savedTokens;

                console.log(`[Kiro Dedup] Deduplicated: ${call.toolName} at msg#${i + 1} -> ref msg#${nearest.messageIndex + 1} (similarity: ${similarity}, saved: ${savedTokens} tokens)`);

            } else if (similarity >= DEDUP_CONFIG.LOW_SIMILARITY_THRESHOLD) {
                // 中等相似度：保留差异摘要
                const diffNote = DEDUP_CONFIG.DIFF_TEMPLATE
                    .replace('{index}', nearest.messageIndex + 1)
                    .replace('{summary}', diffSummary);

                // 在内容前添加差异说明
                const originalContent = typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                newMessage.content[j] = {
                    type: 'tool_result',
                    tool_use_id: part.tool_use_id,
                    content: `${diffNote}\n\n${originalContent}`
                };

                messageModified = true;
                console.log(`[Kiro Dedup] Added diff note: ${call.toolName} at msg#${i + 1} (similarity: ${similarity})`);
            }
            // 低相似度：不处理
        }

        resultMessages.push(messageModified ? newMessage : message);
    }

    const stats = {
        enabled: true,
        processed: messages.length,
        deduplicated: deduplicatedCount,
        tokensSaved,
        trackerStats: tracker.getStats(),
        indexStats: index.getStats()
    };

    console.log(`[Kiro Dedup] Deduplication complete: ${deduplicatedCount} tool results deduplicated, ~${tokensSaved} tokens saved`);

    return { messages: resultMessages, stats };
}

/**
 * 摘要缓存类 - 基于消息哈希的 LRU 缓存
 * 支持增量缓存：当新消息是旧消息的超集时，可复用部分缓存
 */
class SummaryCache {
    constructor(maxSize = SUMMARY_CONFIG.CACHE_MAX_SIZE, ttlMs = SUMMARY_CONFIG.CACHE_TTL_MS) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttlMs = ttlMs;
        this.hits = 0;
        this.misses = 0;
    }

    /**
     * 生成消息数组的哈希键
     */
    _generateKey(messages) {
        const content = messages.map(m => {
            const text = typeof m.content === 'string' ? m.content :
                (Array.isArray(m.content) ? m.content.map(c => c.text || c.thinking || '').join('') : '');
            return `${m.role}:${text.slice(0, 500)}`; // 只取前500字符用于哈希
        }).join('|');
        return crypto.createHash('md5').update(content).digest('hex');
    }

    /**
     * 生成消息数组的前缀哈希（用于增量缓存匹配）
     */
    _generatePrefixKeys(messages) {
        const keys = [];
        // 生成不同长度前缀的哈希，用于部分匹配
        const checkpoints = [
            Math.floor(messages.length * 0.5),
            Math.floor(messages.length * 0.7),
            Math.floor(messages.length * 0.9)
        ].filter(n => n > 0);

        for (const len of checkpoints) {
            const prefix = messages.slice(0, len);
            keys.push({
                key: this._generateKey(prefix),
                length: len
            });
        }
        return keys;
    }

    /**
     * 获取缓存的摘要
     */
    get(messages) {
        const key = this._generateKey(messages);
        const entry = this.cache.get(key);

        if (entry && Date.now() - entry.timestamp <= this.ttlMs) {
            // 完全匹配
            this.cache.delete(key);
          this.cache.set(key, entry);
            this.hits++;
            console.log(`[Kiro Cache] Hit (exact match), total hits: ${this.hits}, misses: ${this.misses}`);
            return entry.summary;
        }

        if (entry) {
            this.cache.delete(key); // 过期，删除
        }

        this.misses++;
        return null;
    }

    /**
     * 获取部分匹配的缓存（增量缓存）
     * 返回最长匹配的前缀摘要和未覆盖的消息
     */
    getPartial(messages) {
        const prefixKeys = this._generatePrefixKeys(messages);

        // 从长到短查找匹配
        for (let i = prefixKeys.length - 1; i >= 0; i--) {
            const { key, length } = prefixKeys[i];
            const entry = this.cache.get(key);

            if (entry && Date.now() - entry.timestamp <= this.ttlMs) {
                // 找到部分匹配
                this.hits++;
                console.log(`[Kiro Cache] Partial hit (${length}/${messages.length} messages), total hits: ${this.hits}`);
                return {
                    summary: entry.summary,
                    coveredLength: length,
                    uncoveredMessages: messages.slice(length)
                };
            }
        }

        return null;
    }

    /**
     * 设置缓存
     */
    set(messages, summary) {
        const key = this._generateKey(messages);

        // 如果超过最大容量，删除最旧的条目
        if (this.cache.size >= this.maxSize) {
            const oldestKey = this.cache.keys().next().value;
            this.cache.delete(oldestKey);
        }

        this.cache.set(key, {
            summary,
            timestamp: Date.now(),
            messageCount: messages.length
        });

        console.log(`[Kiro Cache] Stored summary for ${messages.length} messages, cache size: ${this.cache.size}`);
    }

    /**
     * 清理过期缓存
     */
    cleanup() {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.ttlMs) {
                this.cache.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`[Kiro Cache] Cleaned ${cleaned} expired entries`);
        }
    }

    /**
     * 获取缓存统计信息
     */
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            hits: this.hits,
            misses: this.misses,
            hitRate: this.hits + this.misses > 0
                ? Math.round(this.hits / (this.hits + this.misses) * 100)
                : 0
        };
    }
}

// 全局摘要缓存实例
const summaryCache = new SummaryCache();

// =============================================================================
// 消息分类与打分系统
// =============================================================================

/**
 * 提取消息的文本内容
 * @param {Object} message - 消息对象
 * @returns {string} 文本内容
 */
function extractMessageText(message) {
    if (typeof message.content === 'string') {
        return message.content;
    }
    if (Array.isArray(message.content)) {
        return message.content.map(part => {
            if (part.type === 'text') return part.text || '';
            if (part.type === 'thinking') return part.thinking || '';
            if (part.type === 'tool_result') {
                return typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
            }
            if (part.type === 'tool_use') return `[Tool: ${part.name}]`;
            return '';
        }).join('\n');
    }
    return '';
}

/**
 * 检测消息中包含的工具调用
 * @param {Object} message - 消息对象
 * @returns {Array<string>} 工具名称列表
 */
function extractToolNames(message) {
    const tools = [];
    if (Array.isArray(message.content)) {
        for (const part of message.content) {
            if (part.type === 'tool_use' && part.name) {
                tools.push(part.name);
            }
            if (part.type === 'tool_result' && part.tool_use_id) {
                // tool_result 不直接包含工具名，但可以标记为有工具结果
                tools.push('__tool_result__');
            }
        }
    }
    return tools;
}

/**
 * 检查文本是否包含关键词
 * @param {string} text - 文本内容
 * @param {Array<string>} keywords - 关键词列表
 * @returns {boolean}
 */
function containsKeywords(text, keywords) {
    const lowerText = text.toLowerCase();
    return keywords.some(kw => lowerText.includes(kw.toLowerCase()));
}

/**
 * 消息分类枚举
 */
const MessageCategory = {
    USER_INSTRUCTION: 'USER_INSTRUCTION',
    KEY_STATE: 'KEY_STATE',
    INTERMEDIATE_REASONING: 'INTERMEDIATE_REASONING',
    FAILURE_RECORD: 'FAILURE_RECORD'
};

/**
 * 对单条消息进行分类
 * @param {Object} message - 消息对象
 * @param {number} index - 消息索引
 * @param {number} totalMessages - 消息总数
 * @param {Object} config - 配置对象
 * @returns {{category: string, baseScore: number, reason: string}}
 */
function classifyMessage(message, index, totalMessages, config = {}) {
    const weights = config.WEIGHTS || WEIGHT_COMPRESSION_CONFIG.WEIGHTS;
    const text = extractMessageText(message);
    const tools = extractToolNames(message);
    const role = message.role;

    // 1. 检查是否为失败记录（优先级最高，因为失败需要被识别出来）
    if (containsKeywords(text, CLASSIFICATION_KEYWORDS.FAILURE)) {
        return {
            category: MessageCategory.FAILURE_RECORD,
            baseScore: weights.FAILURE_RECORD,
            reason: '包含错误/失败关键词'
        };
    }

    // 2. 检查是否为用户指令
    if (role === 'user') {
        // 排除纯工具结果的用户消息
        const hasOnlyToolResult = message.content &&
            Array.isArray(message.content) &&
            message.content.every(p => p.type === 'tool_result');

        if (!hasOnlyToolResult) {
            // 检查是否包含指令关键词或是问句
            if (containsKeywords(text, CLASSIFICATION_KEYWORDS.USER_INSTRUCTION) ||
                text.includes('?') || text.includes('？')) {
                return {
                    category: MessageCategory.USER_INSTRUCTION,
                    baseScore: weights.USER_INSTRUCTION,
                    reason: '用户指令/问题'
                };
            }
            // 检查是否为用户确认
            if (containsKeywords(text, CLASSIFICATION_KEYWORDS.USER_CONFIRMATION)) {
                return {
                    category: MessageCategory.KEY_STATE,
                    baseScore: weights.KEY_STATE,
                    reason: '用户确认/决策'
                };
            }
        }
    }

    // 3. 检查是否为关键状态（包含修改类工具）
    const hasKeyStateTool = tools.some(t =>
        CLASSIFICATION_KEYWORDS.KEY_STATE_TOOLS.includes(t)
    );
    if (hasKeyStateTool) {
        return {
            category: MessageCategory.KEY_STATE,
            baseScore: weights.KEY_STATE,
            reason: `包含关键工具: ${tools.filter(t => CLASSIFICATION_KEYWORDS.KEY_STATE_TOOLS.includes(t)).join(', ')}`
        };
    }

    // 4. 检查是否为查询类操作（中间推理）
    const hasQueryTool = tools.some(t =>
        CLASSIFICATION_KEYWORDS.QUERY_TOOLS.includes(t)
    );
    if (hasQueryTool || tools.includes('__tool_result__')) {
        return {
            category: MessageCategory.INTERMEDIATE_REASONING,
            baseScore: weights.INTERMEDIATE_REASONING,
            reason: '查询/分析操作'
        };
    }

    // 5. 默认分类
    if (role === 'user') {
        // 用户消息默认为指令（可能是简短的指令）
        return {
            category: MessageCategory.USER_INSTRUCTION,
            baseScore: weights.USER_INSTRUCTION * 0.8, // 稍低一点
            reason: '用户消息（默认）'
        };
    }

    // AI 回复默认为中间推理
    return {
        category: MessageCategory.INTERMEDIATE_REASONING,
        baseScore: weights.INTERMEDIATE_REASONING,
        reason: 'AI 回复（默认）'
    };
}

/**
 * 对消息数组进行批量分类打分
 * @param {Array} messages - 消息数组
 * @param {Object} config - 配置对象
 * @returns {Array<{message: Object, category: string, baseScore: number, finalScore: number, reason: string, index: number}>}
 */
function scoreMessages(messages, config = {}) {
    const maxRecencyBonus = config.MAX_RECENCY_BONUS || WEIGHT_COMPRESSION_CONFIG.MAX_RECENCY_BONUS;
    const totalMessages = messages.length;

    return messages.map((message, index) => {
        const classification = classifyMessage(message, index, totalMessages, config);

        // 计算时间加成：越新的消息加分越多
        const recencyRatio = totalMessages > 1 ? index / (totalMessages - 1) : 1;
        const recencyBonus = recencyRatio * maxRecencyBonus;

        const finalScore = classification.baseScore + recencyBonus;

        return {
            message,
            index,
            category: classification.category,
            baseScore: classification.baseScore,
            recencyBonus: Math.round(recencyBonus * 10) / 10,
            finalScore: Math.round(finalScore * 10) / 10,
            reason: classification.reason
        };
    });
}

/**
 * 按分数分组消息
 * @param {Array} scoredMessages - 打分后的消息数组
 * @param {Object} config - 配置对象
 * @returns {{highScore: Array, lowScore: Array}}
 */
function groupMessagesByScore(scoredMessages, config = {}) {
    const highThreshold = config.HIGH_SCORE_THRESHOLD || WEIGHT_COMPRESSION_CONFIG.HIGH_SCORE_THRESHOLD;

    const highScore = [];
    const lowScore = [];

    for (const scored of scoredMessages) {
        if (scored.finalScore >= highThreshold) {
            highScore.push(scored);
        } else {
            lowScore.push(scored);
        }
    }

    return { highScore, lowScore };
}

/**
 * 格式化低分消息用于摘要生成
 * @param {Array} lowScoreMessages - 低分消息数组
 * @returns {string}
 */
function formatLowScoreMessagesForSummary(lowScoreMessages) {
    if (lowScoreMessages.length === 0) return '';

    // 按类别分组
    const byCategory = {
        [MessageCategory.INTERMEDIATE_REASONING]: [],
        [MessageCategory.FAILURE_RECORD]: []
    };

    for (const scored of lowScoreMessages) {
        if (byCategory[scored.category]) {
            byCategory[scored.category].push(scored);
        } else {
            byCategory[MessageCategory.INTERMEDIATE_REASONING].push(scored);
        }
    }

    let result = '';

    // 中间推理
    if (byCategory[MessageCategory.INTERMEDIATE_REASONING].length > 0) {
        result += `\n### 中间推理过程 (${byCategory[MessageCategory.INTERMEDIATE_REASONING].length} 条):\n`;
        for (const scored of byCategory[MessageCategory.INTERMEDIATE_REASONING].slice(0, 20)) {
            const text = extractMessageText(scored.message);
            const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
            result += `- [${scored.message.role}] ${truncated}\n`;
        }
        if (byCategory[MessageCategory.INTERMEDIATE_REASONING].length > 20) {
            result += `... 还有 ${byCategory[MessageCategory.INTERMEDIATE_REASONING].length - 20} 条消息省略\n`;
        }
    }

    // 失败记录
    if (byCategory[MessageCategory.FAILURE_RECORD].length > 0) {
        result += `\n### 失败记录 (${byCategory[MessageCategory.FAILURE_RECORD].length} 条):\n`;
        for (const scored of byCategory[MessageCategory.FAILURE_RECORD].slice(0, 10)) {
            const text = extractMessageText(scored.message);
            const truncated = text.length > 300 ? text.slice(0, 300) + '...' : text;
            result += `- [${scored.message.role}] ${truncated}\n`;
        }
    }

    return result;
}

/**
 * 将低分消息格式化为精简的上下文块（供当前模型自行理解）
 * 不使用规则提取，而是保留关键结构让模型自己分析
 * @param {Array} lowScoreMessages - 低分消息数组
 * @param {Object} config - 配置对象
 * @returns {string} 格式化后的压缩上下文
 */
function formatCompressedContext(lowScoreMessages, config = {}) {
    if (lowScoreMessages.length === 0) {
        return '';
    }

    const maxCharsPerMessage = config.KIRO_COMPRESSED_MSG_MAX_CHARS ?? 300;
    const maxTotalChars = config.KIRO_COMPRESSED_TOTAL_MAX_CHARS ?? 8000;

    const parts = [];
    let totalChars = 0;

    // 按类别分组
    const byCategory = {
        [MessageCategory.INTERMEDIATE_REASONING]: [],
        [MessageCategory.FAILURE_RECORD]: []
    };

    for (const scored of lowScoreMessages) {
        const category = byCategory[scored.category] ? scored.category : MessageCategory.INTERMEDIATE_REASONING;
        byCategory[category].push(scored);
    }

    // 格式化中间推理消息
    if (byCategory[MessageCategory.INTERMEDIATE_REASONING].length > 0) {
        parts.push(`<compressed_context type="intermediate_reasoning" count="${byCategory[MessageCategory.INTERMEDIATE_REASONING].length}">`);

        for (const scored of byCategory[MessageCategory.INTERMEDIATE_REASONING]) {
            if (totalChars >= maxTotalChars) {
                parts.push(`... (${byCategory[MessageCategory.INTERMEDIATE_REASONING].length - parts.length + 1} more messages omitted)`);
                break;
            }

            const message = scored.message;
            let content = '';

            // 提取消息内容
            if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part.type === 'text' && part.text) {
                        content += part.text + '\n';
                    } else if (part.type === 'tool_use') {
                        content += `[Tool: ${part.name}${part.input?.file_path ? ` file="${part.input.file_path}"` : ''}${part.input?.pattern ? ` pattern="${part.input.pattern}"` : ''}${part.input?.command ? ` cmd="${part.input.command.slice(0, 50)}"` : ''}]\n`;
                    } else if (part.type === 'tool_result') {
                        const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
                        // 工具结果只保留前几行
                        const lines = resultText.split('\n').slice(0, 5);
                        content += `[Result: ${lines.join(' ').slice(0, 150)}${resultText.length > 150 ? '...' : ''}]\n`;
                    }
                }
            } else if (typeof message.content === 'string') {
                content = message.content;
            }

            // 截断过长的内容
            if (content.length > maxCharsPerMessage) {
                content = content.slice(0, maxCharsPerMessage) + '...';
            }

            if (content.trim()) {
                parts.push(`[${message.role}#${scored.index}] ${content.trim()}`);
                totalChars += content.length;
            }
        }

        parts.push('</compressed_context>');
    }

    // 格式化失败记录
    if (byCategory[MessageCategory.FAILURE_RECORD].length > 0) {
        parts.push(`<compressed_context type="failure_records" count="${byCategory[MessageCategory.FAILURE_RECORD].length}">`);

        for (const scored of byCategory[MessageCategory.FAILURE_RECORD]) {
            if (totalChars >= maxTotalChars) {
                parts.push(`... (${byCategory[MessageCategory.FAILURE_RECORD].length} failure records, details omitted)`);
                break;
            }

            const message = scored.message;
            const text = extractMessageText(message);
            const truncated = text.length > maxCharsPerMessage ? text.slice(0, maxCharsPerMessage) + '...' : text;

            if (truncated.trim()) {
                parts.push(`[${message.role}#${scored.index}] ${truncated.trim()}`);
                totalChars += truncated.length;
            }
        }

        parts.push('</compressed_context>');
    }

    return parts.join('\n');
}

/**
 * 生成低分消息的统一摘要
 * 使用格式化的压缩上下文，让当前模型自行理解
 * @param {Array} lowScoreMessages - 低分消息数组
 * @param {Object|null} service - Kiro API 服务实例（可选，用于 API 摘要）
 * @param {Object} config - 配置对象
 * @returns {Promise<string>}
 */
async function generateLowScoreSummary(lowScoreMessages, service = null, config = {}) {
    if (lowScoreMessages.length === 0) {
        return '';
    }

    // 使用格式化的压缩上下文（让当前模型自行理解）
    console.log(`[Kiro Weight Compression] Formatting ${lowScoreMessages.length} low-score messages for model comprehension...`);
    return formatCompressedContext(lowScoreMessages, config);
}

// =============================================================================
// 代码块提取函数
// =============================================================================

/**
 * 从文本中提取代码块
 * @param {string} text - 输入文本
 * @returns {Array<{language: string, code: string, startLine: number}>} 代码块数组
 */
function extractCodeBlocks(text) {
    const codeBlocks = [];
    // 匹配 markdown 代码块
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
        const language = match[1] || 'text';
        const code = match[2];
        const lines = code.split('\n');

        // 如果代码块太长，只保留前后部分
        if (lines.length > SUMMARY_CONFIG.MAX_CODE_BLOCK_LINES) {
            const keepLines = Math.floor(SUMMARY_CONFIG.MAX_CODE_BLOCK_LINES / 2);
            const truncatedCode = [
                ...lines.slice(0, keepLines),
                `\n... [${lines.length - SUMMARY_CONFIG.MAX_CODE_BLOCK_LINES} lines omitted] ...\n`,
                ...lines.slice(-keepLines)
            ].join('\n');
            codeBlocks.push({ language, code: truncatedCode, original: code });
        } else {
            codeBlocks.push({ language, code, original: code });
        }
    }

    return codeBlocks;
}

/**
 * 从消息数组中提取重要的代码块
 * @param {Array} messages - 消息数组
 * @returns {string} 格式化的代码块摘要
 */
function extractImportantCodeBlocks(messages) {
    const allCodeBlocks = [];

    for (const msg of messages) {
        const content = typeof msg.content === 'string' ? msg.content :
            (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('\n') : '');

        const blocks = extractCodeBlocks(content);
        for (const block of blocks) {
            allCodeBlocks.push({
                role: msg.role,
                ...block
            });
        }
    }

    // 只保留最近的 N 个代码块
    const recentBlocks = allCodeBlocks.slice(-SUMMARY_CONFIG.MAX_CODE_BLOCKS_TO_KEEP);

    if (recentBlocks.length === 0) return '';

    let result = '\n\n### Key Code Snippets from History:\n';
    for (const block of recentBlocks) {
        result += `\n**[${block.role}] ${block.language}:**\n\`\`\`${block.language}\n${block.code}\n\`\`\`\n`;
    }

    return result;
}

/**
 * 将消息数组转换为可读文本（用于摘要生成）
 * @param {Array} messages - 消息数组
 * @returns {string} 格式化的对话文本
 */
function messagesToText(messages) {
    return messages.map(msg => {
        const role = msg.role === 'user' ? 'User' : 'Assistant';
        let content = '';

        if (typeof msg.content === 'string') {
            content = msg.content;
        } else if (Array.isArray(msg.content)) {
            content = msg.content.map(part => {
                if (part.type === 'text') return part.text;
                if (part.type === 'tool_result') return `[Tool Result: ${part.tool_use_id}]\n${typeof part.content === 'string' ? part.content : JSON.stringify(part.content)}`;
                if (part.type === 'tool_use') return `[Tool Call: ${part.name}]\n${JSON.stringify(part.input)}`;
                if (part.type === 'thinking') return `[Thinking]\n${part.thinking}`;
                if (part.type === 'image') return '[Image]';
                return '';
            }).filter(Boolean).join('\n');
        }

        // 限制单条消息长度，避免摘要请求过大
        if (content.length > 10000) {
            content = content.slice(0, 5000) + '\n...[content truncated]...\n' + content.slice(-3000);
        }

        return `### ${role}:\n${content}`;
    }).join('\n\n---\n\n');
}

/**
 * 生成摘要的 prompt 模板
 */
function getSummaryPrompt(tier, conversationText, codeBlocks = '') {
    const basePrompt = `You are a conversation summarizer. Your task is to create a concise but comprehensive summary of the following conversation history.

IMPORTANT GUIDELINES:
1. Preserve key decisions, conclusions, and action items
2. Keep track of important file paths, function names, and technical details mentioned
3. Note any unresolved issues or pending tasks
4. Mai context about what the user is trying to accomplish
5. Be concise but don't lose critical information

${tier === 'tier2' ? 'Create a DETAILED summary that captures the main flow of the conversation.' : 'Create a BRIEF summary focusing only on the most critical information and decisions.'}

CONVERSATION TO SUMMARIZE:
---
${conversationText}
---
${codeBlocks ? `\nIMPORTANT CODE SNIPPETS (preserve these references):\n${codeBlocks}` : ''}

Please provide your summary in the following format:

## Conversation Summary

### Main Topic/Goal:
[What the user is trying to accomplish]

### Key Decisions & Conclusions:
- [Decision 1]
- [Decision 2]
...

### Important Technical Details:
- Files: [relevant file paths]
- Functions/Classes: [important code elements]
- Commands: [any commands discussed]

### Current Status:
[Where the conversation left off]

### Pending Items:
- [Any unresolved issues or next steps]

---
Summary:`;

    return basePrompt;
}

/**
 * 调用本地代理 API 生成摘要
 * @param {KiroApiService} service - Kiro API 服务实例（保留参数兼容性，但不再使用）
 * @param {string} conversationText - 对话文本
 * @param {string} tier - 摘要层级 ('tier2' 或 'tier3')
 * @param {string} codeBlocks - 代码块摘要
 * @returns {Promise<string>} 生成的摘要
 */
async function generateSummaryWithOpus(service, conversationText, tier, codeBlocks = '') {
    // 限制发送给摘要模型的内容大小（预留空间给 prompt 和输出）
    // Opus 4.5 上下文 200k，预留 50k 给 prompt 模板和输出
    const MAX_SUMMARY_INPUT_CHARS = 150_000 * 4; // 约 150k tokens

    let truncatedText = conversationText;
    let wasTruncated = false;

    if (conversationText.length > MAX_SUMMARY_INPUT_CHARS) {
        // 保留开头和结尾部分，中间截断
        const keepChars = Math.floor(MAX_SUMMARY_INPUT_CHARS / 2);
        const startPart = conversationText.slice(0, keepChars);
        const endPart = conversationText.slice(-keepChars);
        const omittedChars = conversationText.length - MAX_SUMMARY_INPUT_CHARS;
        truncatedText = `${startPart}\n\n[... ${omittedChars.toLocaleString()} characters omitted for summarization ...]\n\n${endPart}`;
        wasTruncated = true;
        console.log(`[Kiro Summary] Input truncated: ${conversationText.length} -> ${truncatedText.length} chars`);
    }

    const prompt = getSummaryPrompt(tier, truncatedText, codeBlocks);
    const maxTokens = tier === 'tier2' ? SUMMARY_CONFIG.TIER2_MAX_SUMMARY_TOKENS : SUMMARY_CONFIG.TIER3_MAX_SUMMARY_TOKENS;

    try {
        console.log(`[Kiro Summary] Generating ${tier} summary via local proxy API...`);

        // 构建标准 Claude Messages API 请求
        const summaryRequest = {
            model: SUMMARY_CONFIG.SUMMARY_MODEL,
            max_tokens: maxTokens || 4096,
            messages: [
                { role: 'user', content: prompt }
            ]
        };

        // 调用本地代理 API
        const response = await axios.post(
            SUMMARY_CONFIG.SUMMARY_API_URL,
            summaryRequest,
            {
                headers: {
                    'Content-Type': 'application/json'
                },
                timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT
            }
        );

        // 解析标准 Claude Messages API 响应
        const data = response.data;
        let summaryText = '';

        if (data.content && Array.isArray(data.content)) {
            for (const block of data.content) {
                if (block.type === 'text' && block.text) {
                    summaryText += block.text;
                }
            }
        } else if (typeof data.content === 'string') {
            summaryText = data.content;
        } else if (data.choices && data.choices[0]?.message?.content) {
            // 兼容 OpenAI 格式响应
            summaryText = data.choices[0].message.content;
        }

        console.log(`[Kiro Summary] ${tier} summary generated successfully`);
        return summaryText || '[Summary generation failed]';
    } catch (error) {
        console.error(`[Kiro Summary] Failed to generate ${tier} summary:`, error.message);
        // 降级：返回简单的截断摘要
        return `[Auto-summary failed, using truncated history]\n\n${conversationText.slice(0, 2000)}...\n\n[${conversationText.length} characters truncated]`;
    }
}

// 手动压缩指令关键词
const MANUAL_COMPRESSION_KEYWORDS = [
    'compact',
    '/compact',
    '压缩上下文',
    '压缩对话',
    '/compress'
];

/**
 * 检测消息是否包含手动压缩指令
 * @param {Array} messages - 消息数组
 * @returns {boolean}
 */
function detectManualCompressionCommand(messages) {
    console.log(`[Kiro Compression] Checking for manual compression command, messages count: ${messages?.length || 0}`);

    if (!messages || messages.length === 0) {
        console.log('[Kiro Compression] No messages to check');
        return false;
    }

    // 检查最后一条用户消息
    const lastMessage = messages[messages.length - 1];
    console.log(`[Kiro Compression] Last message role: ${lastMessage.role}`);

    if (lastMessage.role !== 'user') {
        console.log('[Kiro Compression] Last message is not from user, skipping');
        return false;
    }

    const text = extractMessageText(lastMessage).trim().toLowerCase();
    console.log(`[Kiro Compression] Last user message text: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

    // 检查是否匹配手动压缩关键词
    const matched = MANUAL_COMPRESSION_KEYWORDS.some(keyword =>
        text === keyword.toLowerCase() ||
        text.startsWith(keyword.toLowerCase() + ' ') ||
        text.startsWith(keyword.toLowerCase() + '\n')
    );

    console.log(`[Kiro Compression] Manual compression command detected: ${matched}`);
    return matched;
}

/**
 * 基于权重的上下文压缩（主函数）
 * 将消息分为4类：用户指令、关键状态、中间推理、失败记录
 * 高分消息完整保留，低分消息合并生成统一摘要
 *
 * @param {Array} messages - 原始消息数组
 * @param {string} model - 当前使用的模型
 * @param {string|null} systemPrompt - 系统提示
 * @param {Array|null} tools - 工具定义
 * @param {Object} config - 配置选项
 * @param {KiroApiService} service - Kiro API 服务实例（用于调用 Opus 4.5）
 * @param {boolean} forceCompress - 强制压缩（手动触发时为 true）
 * @returns {Promise<{messages: Array, compressed: boolean, originalTokens: number, compressedTokens: number, manualTriggered: boolean}>}
 */
async function compressContextByWeight(messages, model, systemPrompt = null, tools = null, config = {}, service = null, forceCompress = false) {
    // 配置参数
    const enableCompression = config.KIRO_ENABLE_CONTEXT_COMPRESSION ?? true;
    const keepRecentCount = config.KIRO_KEEP_RECENT_COUNT ?? WEIGHT_COMPRESSION_CONFIG.KEEP_RECENT_COUNT;
    const highScoreThreshold = config.KIRO_HIGH_SCORE_THRESHOLD ?? WEIGHT_COMPRESSION_CONFIG.HIGH_SCORE_THRESHOLD;

    // 自定义权重配置
    const weights = {
        USER_INSTRUCTION: config.KIRO_WEIGHT_USER_INSTRUCTION ?? WEIGHT_COMPRESSION_CONFIG.WEIGHTS.USER_INSTRUCTION,
        KEY_STATE: config.KIRO_WEIGHT_KEY_STATE ?? WEIGHT_COMPRESSION_CONFIG.WEIGHTS.KEY_STATE,
        INTERMEDIATE_REASONING: config.KIRO_WEIGHT_INTERMEDIATE ?? WEIGHT_COMPRESSION_CONFIG.WEIGHTS.INTERMEDIATE_REASONING,
        FAILURE_RECORD: config.KIRO_WEIGHT_FAILURE ?? WEIGHT_COMPRESSION_CONFIG.WEIGHTS.FAILURE_RECORD
    };

    const compressionConfig = {
        ...WEIGHT_COMPRESSION_CONFIG,
        WEIGHTS: weights,
        HIGH_SCORE_THRESHOLD: highScoreThreshold,
        KEEP_RECENT_COUNT: keepRecentCount
    };

    if (!enableCompression && !forceCompress) {
        return { messages, compressed: false, originalTokens: 0, compressedTokens: 0, manualTriggered: false };
    }

    // 估算当前 token 数量
    const originalTokens = estimateMessagesTokens(messages, systemPrompt, tools);
    const { maxAllowedSize } = getContextWindowInfo(model);

    console.log(`[Kiro Weight Compression] Original tokens: ${originalTokens}, Max allowed: ${maxAllowedSize}, Force: ${forceCompress}`);

    // 如果未超过物理限制的 80% 且非强制压缩，不需要压缩
    if (!forceCompress && originalTokens <= maxAllowedSize * 0.8) {
        return { messages, compressed: false, originalTokens, compressedTokens: originalTokens, manualTriggered: false };
    }

    console.log(`[Kiro Weight Compression] Starting weight-based context compression...${forceCompress ? ' (Manual trigger)' : ''}${service ? '' : ' (Local mode)'}`);

    // 深拷贝消息
    const allMessages = JSON.parse(JSON.stringify(messages));

    // ===== 第一步：语义去重（在权重压缩之前执行）=====
    const dedupResult = deduplicateToolResults(allMessages, config);
    const deduplicatedMessages = dedupResult.messages;

    if (dedupResult.stats.deduplicated > 0) {
        console.log(`[Kiro Weight Compression] Semantic deduplication: ${dedupResult.stats.deduplicated} tool results deduplicated, ~${dedupResult.stats.tokensSaved} tokens saved`);
    }

    // 如果是手动触发，移除压缩指令消息
    let messagesToProcess = deduplicatedMessages;
    if (forceCompress && deduplicatedMessages.length > 0) {
        const lastMsg = deduplicatedMessages[deduplicatedMessages.length - 1];
        if (lastMsg.role === 'user') {
            const text = extractMessageText(lastMsg).trim().toLowerCase();
            if (MANUAL_COMPRESSION_KEYWORDS.some(kw => text === kw.toLowerCase() || text.startsWith(kw.toLowerCase()))) {
                messagesToProcess = deduplicatedMessages.slice(0, -1); // 移除压缩指令
                console.log('[Kiro Weight Compression] Removed manual compression command from messages');
            }
        }
    }

    // 分离最近消息（始终保留）
    const recentCount = Math.min(keepRecentCount, messagesToProcess.length);
    const recentMessages = messagesToProcess.slice(-recentCount);
    const olderMessages = messagesToProcess.slice(0, -recentCount);

    if (olderMessages.length === 0) {
        console.log('[Kiro Weight Compression] No older messages to compress');
        return { messages, compressed: false, originalTokens, compressedTokens: originalTokens };
    }

    // 对旧消息进行分类打分
    const scoredMessages = scoreMessages(olderMessages, compressionConfig);

    // 按分数分组
    const { highScore, lowScore } = groupMessagesByScore(scoredMessages, compressionConfig);

    console.log(`[Kiro Weight Compression] Classification results:`);
    console.log(`  - High score (>= ${highScoreThreshold}): ${highScore.length} messages`);
    console.log(`  - Low score (< ${highScoreThreshold}): ${lowScore.length} messages`);

    // 打印分类详情（调试用）
    const categoryStats = {
        USER_INSTRUCTION: scoredMessages.filter(m => m.category === MessageCategory.USER_INSTRUCTION).length,
        KEY_STATE: scoredMessages.filter(m => m.category === MessageCategory.KEY_STATE).length,
        INTERMEDIATE_REASONING: scoredMessages.filter(m => m.category === MessageCategory.INTERMEDIATE_REASONING).length,
        FAILURE_RECORD: scoredMessages.filter(m => m.category === MessageCategory.FAILURE_RECORD).length
    };
    console.log(`[Kiro Weight Compression] Category breakdown:`, categoryStats);

    // 检查缓存
    const cacheKey = lowScore.map(s => s.index).join(',');
    const cachedSummary = summaryCache.get(lowScore.map(s => s.message));
    let lowScoreSummary;

    if (cachedSummary) {
        console.log('[Kiro Weight Compression] Using cached summary for low-score messages');
        lowScoreSummary = cachedSummary;
    } else if (lowScore.length > 0) {
        // 为低分消息生成统一摘要
        lowScoreSummary = await generateLowScoreSummary(lowScore, service, compressionConfig);
        // 缓存摘要
        summaryCache.set(lowScore.map(s => s.message), lowScoreSummary);
    } else {
        lowScoreSummary = '';
    }

    // 构建压缩后的消息数组
    const compressedMessages = [];

    // 1. 添加低分消息的压缩上下文（如果有）
    if (lowScoreSummary) {
        compressedMessages.push({
            role: 'user',
            content: [{
                type: 'text',
                text: `<context_compression>
以下是之前对话的压缩上下文。这些内容已被精简以节省 token，但包含了重要的历史信息。
请在回复时参考这些上下文，理解之前的操作和状态。

${lowScoreSummary}
</context_compression>`
            }]
        });
        compressedMessages.push({
            role: 'assistant',
            content: [{
                type: 'text',
                text: '我已理解压缩的上下文信息，将基于这些历史记录继续处理当前任务。'
            }]
        });
    }

    // 2. 添加高分消息（按原始顺序）
    const sortedHighScore = highScore.sort((a, b) => a.index - b.index);
    for (const scored of sortedHighScore) {
        compressedMessages.push(scored.message);
    }

    // 3. 添加最近消息
    compressedMessages.push(...recentMessages);

    // 估算压缩后的 token 数量
    const compressedTokens = estimateMessagesTokens(compressedMessages, systemPrompt, tools);
    const reductionPercent = Math.round((1 - compressedTokens / originalTokens) * 100);

    console.log(`[Kiro Weight Compression] Compression complete: ${originalTokens} -> ${compressedTokens} tokens (${reductionPercent}% reduction)`);
    console.log(`[Kiro Weight Compression] Kept ${highScore.length} high-score + ${recentMessages.length} recent messages, summarized ${lowScore.length} low-score messages`);

    return {
        messages: compressedMessages,
        compressed: true,
        originalTokens,
        compressedTokens,
        manualTriggered: forceCompress,
        stats: {
            highScoreKept: highScore.length,
            lowScoreSummarized: lowScore.length,
            recentKept: recentMessages.length,
            categoryStats,
            reductionPercent,
            deduplication: dedupResult.stats
        }
    };
}

/**
 * 分层压缩上下文（旧函数，保留向后兼容）
 * @deprecated 请使用 compressContextByWeight
 * @param {Array} messages - 原始消息数组
 * @param {string} model - 当前使用的模型
 * @param {string|null} systemPrompt - 系统提示
 * @param {Array|null} tools - 工具定义
 * @param {Object} config - 配置选项
 * @param {KiroApiService - Kiro API 服务实例（用于调用 Opus 4.5）
 * @returns {Promise<{messages: Array, compressed: boolean, originalTokens: number, compressedTokens: number}>}
 */
async function compressContextWithSummary(messages, model, systemPrompt = null, tools = null, config = {}, service = null) {
    // 直接调用新的基于权重的压缩函数
    return compressContextByWeight(messages, model, systemPrompt, tools, config, service);
}

// =============================================================================
// 上下文窗口管理（参考 Cline 的 context-management 策略）
// =============================================================================

/**
 * 获取模型的上下文窗口信息
 * @param {string} model - 模型名称
 * @returns {{contextWindow: number, maxAllowedSize: number}} 上下文窗口信息
 */
function getContextWindowInfo(model) {
    // 不同模型的上下文窗口大小
    const contextWindows = {
        'claude-opus-4-5': 200_000,
        'claude-opus-4-5-20251101': 200_000,
        'claude-haiku-4-5': 200_000,
        'claude-sonnet-4-5': 200_000,
        'claude-sonnet-4-5-20250929': 200_000,
        'claude-sonnet-4-20250514': 200_000,
        'claude-3-7-sonnet-20250219': 200_000,
    };

    const contextWindow = contextWindows[model] || 200_000;

    // 参考 Cline 的策略：预留 buffer 防止溢出
    let maxAllowedSize;
    if (contextWindow >= 200_000) {
        maxAllowedSize = contextWindow - 40_000; // Claude 模型预留 40k
    } else if (contextWindow >= 128_000) {
        maxAllowedSize = contextWindow - 30_000;
    } else if (contextWindow >= 64_000) {
        maxAllowedSize = contextWindow - 27_000;
    } else {
        maxAllowedSize = Math.max(contextWindow - 20_000, contextWindow * 0.8);
    }

    return { contextWindow, maxAllowedSize };
}

/**
 * 估算消息的 token 数量
 * @param {Array} messages - 消息数组
 * @param {string|null} systemPrompt - 系统提示
 * @param {Array|null} tools - 工具定义
 * @returns {number} 估算的 token 数量
 */
function estimateMessagesTokens(messages, systemPrompt = null, tools = null) {
    let totalTokens = 0;

    // 计算系统提示的 token
    if (systemPrompt) {
        try {
            totalTokens += countTokens(systemPrompt);
        } catch {
            totalTokens += Math.ceil(systemPrompt.length / 4);
        }
    }

    // 计算消息的 token
    for (const message of messages) {
        let content = '';
        if (typeof message.content === 'string') {
            content = message.content;
        } else if (Array.isArray(message.content)) {
            for (const part of message.content) {
                if (part.type === 'text' && part.text) {
                    content += part.text;
                } else if (part.type === 'tool_result' && part.content) {
                    content += typeof part.content === 'string' ? part.content : JSON.stringify(part.content);
                } else if (part.type === 'tool_use' && part.input) {
                    content += JSON.stringify(part.input);
                } else if (part.type === 'thinking' && part.thinking) {
                    content += part.thinking;
                } else if (part.type === 'image') {
                    // 图片估算为 1600 tokens
                    totalTokens += 1600;
                }
            }
        }

        try {
            totalTokens += countTokens(content);
        } catch {
            totalTokens += Math.ceil(content.length / 4);
        }
    }

    // 计算工具定义的 token
    if (tools && Array.isArray(tools) && tools.length > 0) {
        const toolsStr = JSON.stringify(tools);
        try {
            totalTokens += countTokens(toolsStr);
        } catch {
            totalTokens += Math.ceil(toolsStr.length / 4);
        }
    }

    return totalTokens;
}

/**
 * 生成截断提示消息
 * @param {number} truncatedCount - 被截断的消息数量
 * @param {string} language - 语言 ('zh' 或 'en')
 * @returns {string} 截断提示文本
 */
function generateTruncationHint(truncatedCount, language = 'en') {
    if (language === 'zh') {
        return `[系统提示: 由于上下文长度限制，之前的 ${truncatedCount} 条消息已被截断。对话将从最近的上下文继续。如果您需要之前对话中的信息，请要求用户重新提供。]`;
    }
    return `[System Note: Due to context length limits, ${truncatedCount} earlier messages have been truncated. The conversation continues from the most recent context below. If you need information from earlier in the conversation, please ask the user to provide it again.]`;
}

/**
 * 智能截断消息历史（透明截断 + 注入提示）
 * 参考 Cline 的 ContextManager.getNextTruncationRange 策略
 * @param {Array} messages - 原始消息数组
 * @param {string} model - 模型名称
 * @param {string|null} systemPrompt - 系统提示
 * @param {Array|null} tools - 工具定义
 * @param {Object} config - 配置选项
 * @returns {{messages: Array, truncated: boolean, truncatedCount: number}} 处理后的消息
 */
function truncateMessagesWithHint(messages, model, systemPrompt = null, tools = null, config = {}) {
    // 配置参数
    const thresholdPercent = config.KIRO_CONTEXT_THRESHOLD_PERCENT ?? 85;
    const keepRecentMessages = config.KIRO_KEEP_RECENT_MESSAGES ?? 20;
    const keepFirstPair = config.KIRO_KEEP_FIRST_PAIR ?? true;
    const truncationLanguage = config.KIRO_TRUNCATION_LANGUAGE ?? 'en';
    const enableTruncation = config.KIRO_ENABLE_CONTEXT_TRUNCATION ?? true;

    // 如果禁用截断，直接返回原消息
    if (!enableTruncation) {
        return { messages, truncated: false, truncatedCount: 0 };
    }

    // 获取上下文窗口信息
    const { maxAllowedSize } = getContextWindowInfo(model);
    const threshold = Math.floor(maxAllowedSize * (thresholdPercent / 100));

    // 估算当前 token 数量
    const currentTokens = estimateMessagesTokens(messages, systemPrompt, tools);

    console.log(`[Kiro Context] Current tokens: ${currentTokens}, Threshold: ${threshold} (${thresholdPercent}% of ${maxAllowedSize})`);

    // 如果未超过阈值，不需要截断
    if (currentTokens <= threshold) {
        return { messages, truncated: false, truncatedCount: 0 };
    }

    console.log(`[Kiro Context] Token count ${currentTokens} exceeds threshold ${threshold}, starting truncation...`);

    // 深拷贝消息数组，避免修改原数组
    let processedMessages = JSON.parse(JSON.stringify(messages));

    // 确保消息数量足够进行截断
    if (processedMessages.length <= 4) {
        console.log('[Kiro Context] Too few messages to truncate, skipping');
        return { messages, truncated: false, truncatedCount: 0 };
    }

    // 计算要保留的消息
    // 策略：保留第一对 user-assistant 消息 + 最近的 N 条消息
    let firstPairCount = 0;
    let firstPair = [];

    if (keepFirstPair && processedMessages.length >= 2) {
        // 找到第一对 user-assistant 消息
        if (processedMessages[0].role === 'user') {
            firstPair.push(processedMessages[0]);
            firstPairCount = 1;
            if (processedMessages.length > 1 && processedMessages[1].role === 'assistant') {
                firstPair.push(processedMessages[1]);
                firstPairCount = 2;
            }
        }
    }

    // 计算要保留的最近消息数量（确保是偶数，保持 user-assistant 配对）
    let recentCount = Math.min(keepRecentMessages, processedMessages.length - firstPairCount);
    recentCount = Math.floor(recentCount / 2) * 2; // 确保偶数

    // 如果保留的消息太少，至少保留 4 条
    if (recentCount < 4) {
        recentCount = Math.min(4, processedMessages.length - firstPairCount);
    }

    // 获取最近的消息
    const recentMessages = processedMessages.slice(-recentCount);

    // 计算被截断的消息数量
    const truncatedCount = processedMessages.length - firstPairCount - recentCount;

    if (truncatedCount <= 0) {
        console.log('[Kiro Context] No messages to truncate after calculation');
        return { messages, truncated: false, truncatedCount: 0 };
    }

    // 构建截断提示消息
    const truncationHint = {
        role: 'user',
        content: [{
            type: 'text',
            text: generateTruncationHint(truncatedCount, truncationLanguage)
        }]
    };

    // 构建截断后的消息数组
    let truncatedMessages = [];

    if (firstPair.length > 0) {
        truncatedMessages.push(...firstPair);
    }

    // 在第一对消息和最近消息之间插入截断提示
    truncatedMessages.push(truncationHint);

    // 如果截断提示后面紧跟的是 assistant 消息，需要添加一个占位 assistant 响应
    if (recentMessages.length > 0 && recentMessages[0].role === 'assistant') {
        truncatedMessages.push({
            role: 'assistant',
            content: [{ type: 'text', text: 'Understood. I will continue from the recent context.' }]
        });
    }

    truncatedMessages.push(...recentMessages);

    // 验证截断后的 token 数量
    const newTokens = estimateMessagesTokens(truncatedMessages, systemPrompt, tools);
    console.log(`[Kiro Context] After truncation: ${truncatedMessages.length} messages, ${newTokens} tokens (was ${processedMessages.length} messages, ${currentTokens} tokens)`);
    console.log(`[Kiro Context] Truncated ${truncatedCount} messages`);

    // 如果截断后仍然超过阈值，进行更激进的截断
    if (newTokens > threshold && recentCount > 6) {
        console.log('[Kiro Context] Still over threshold, performing aggressive truncation...');
        const aggressiveResult = truncateMessagesWithHint(
            truncatedMessages,
            model,
            systemPrompt,
            tools,
            {
                ...config,
                KIRO_KEEP_RECENT_MESSAGES: Math.floor(recentCount / 2),
                KIRO_KEEP_FIRST_PAIR: false // 第二轮不再保留第一对
            }
        );
        return {
            messages: aggressiveResult.messages,
            truncated: true,
            truncatedCount: truncatedCount + aggressiveResult.truncatedCount
        };
    }

    return {
        messages: truncatedMessages,
        truncated: true,
        truncatedCount
    };
}

/**
 * 优化重复的文件读取内容（减少 token 消耗）
 * 参考 Cline 的 findAndPotentiallySaveFileReadContextHistoryUpdates
 * @param {Array} messages - 消息数组
 * @param {Object} config - 配置选项
 * @returns {Array} 优化后的消息数组
 */
function optimizeFileReads(messages, config = {}) {
    const enableOptimization = config.KIRO_ENABLE_FILE_READ_OPTIMIZATION ?? true;
    const keepRecentFileReads = config.KIRO_KEEP_RECENT_FILE_READS ?? 3;

    if (!enableOptimization) {
        return messages;
    }

    // 文件内容的正则匹配模式
    const fileContentPattern = /<file_content\s+path="([^"]*)">([\s\S]*?)<\/file_content>/g;

    // 记录每个文件路径最后出现的消息索引
    const fileLastSeen = new Map();

    // 第一遍：记录每个文件最后出现的位置
    messages.forEach((msg, idx) => {
        if (msg.role !== 'user') return;

        const content = typeof msg.content === 'string' ? msg.content :
            (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');

        let match;
        const regex = new RegExp(fileContentPattern.source, fileContentPattern.flags);
        while ((match = regex.exec(content)) !== null) {
            fileLastSeen.set(match[1], idx);
        }
    });

    // 第二遍：替换非最近的重复文件内容
    return messages.map((msg, idx) => {
        if (msg.role !== 'user') return msg;

        let content = typeof msg.content === 'string' ? msg.content :
            (Array.isArray(msg.content) ? msg.content.map(c => c.text || '').join('') : '');

        let modified = false;
        const regex = new RegExp(fileContentPattern.source, fileContentPattern.flags);

        content = content.replace(regex, (match, filePath, fileContent) => {
            const lastSeenIdx = fileLastSeen.get(filePath);
            const distanceFromLast = messages.length - 1 - idx;

            // 如果不是最近 N 次出现，且不是最后一次出现，则替换为占位符
            if (distanceFromLast > keepRecentFileReads && idx !== lastSeenIdx) {
                modified = true;
                return `<file_content path="${filePath}">[File content shown earlier in conversation - ${fileContent.length} characters]</file_content>`;
            }
            return match;
        });

        if (modified) {
            if (typeof msg.content === 'string') {
                return { ...msg, content };
            } else if (Array.isArray(msg.content)) {
                return {
                    ...msg,
                    content: msg.content.map(c => {
                        if (c.type === 'text') {
                            return { ...c, text: content };
                        }
                        return c;
                    })
                };
            }
        }

        return msg;
    });
}

// =============================================================================
// Kiro tools 压缩与限额（避免上游 5xx）
// =============================================================================

function toSafeErrorLog(error) {
    const status = error?.response?.status ?? error?.statusCode ?? error?.status;
    const headers = error?.response?.headers || {};
    const requestId = headers['x-amzn-requestid'] || null;
    const errorType = headers['x-amzn-errortype'] || null;

    return {
        message: error?.message || String(error),
        code: error?.code || null,
        status: typeof status === 'number' ? status : null,
        requestId,
        errorType,
    };
}

function getUtf8ByteLength(value) {
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        return Buffer.byteLength(text, 'utf8');
    } catch {
        return Number.MAX_SAFE_INTEGER;
    }
}

function truncateText(text, maxChars) {
    if (!text) return "";
    const str = String(text);
    if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
    if (str.length <= maxChars) return str;
    return `${str.slice(0, maxChars)}…`;
}

function sanitizeJsonSchema(schema, limits, depth = 0) {
    const maxDepth = limits?.schemaMaxDepth ?? 8;
    const maxProperties = limits?.schemaMaxProperties ?? 60;
    const maxArrayItems = limits?.schemaMaxArrayItems ?? 40;

    if (schema == null) return {};
    if (Array.isArray(schema)) {
        return schema.slice(0, maxArrayItems).map((v) => sanitizeJsonSchema(v, limits, depth + 1));
    }
    if (typeof schema !== 'object') return schema;

    if (depth >= maxDepth) {
        // 深度过深时只保留 type（如有）以避免 schema 体积失控
        const shallow = {};
        if (typeof schema.type === 'string') shallow.type = schema.type;
        return shallow;
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
        // 去掉高噪声/高体积元数据字段
        if (
            key === "$schema" ||
            key === "title" ||
            key === "description" ||
            key === "examples" ||
            key === "example" ||
            key === "$comment" ||
            key === "comment" ||
            key === "deprecated" ||
            key === "readOnly" ||
            key === "writeOnly" ||
            key === "id"
        ) {
            continue;
        }
        // 去掉自定义扩展字段（x-*）
        if (key.startsWith("x-") || key.startsWith("X-")) {
            continue;
        }

        if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
            const entries = Object.entries(value).slice(0, maxProperties);
            const next = {};
            for (const [propKey, propVal] of entries) {
                next[propKey] = sanitizeJsonSchema(propVal, limits, depth + 1);
            }
            cleaned.properties = next;
            continue;
        }

        cleaned[key] = sanitizeJsonSchema(value, limits, depth + 1);
    }
    return cleaned;
}

function buildKiroToolsContext(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return {};
    return {
        tools: tools.map((tool) => ({
            toolSpecification: {
                name: tool.name,
                description: tool.description || "",
                inputSchema: { json: tool.input_schema || {} },
            },
        })),
    };
}

function compressToolsForKiro(tools, config) {
    if (!Array.isArray(tools) || tools.length === 0) {
        console.log(`[Kiro Tools] 没有工具传入或工具为空数组, tools=${JSON.stringify(tools)?.substring(0, 200)}`);
        return {};
    }

    console.log(`[Kiro Tools] 收到 ${tools.length} 个工具，开始处理...`);

    // 检查是否禁用工具压缩（用于调试或 MCP 兼容性）
    const disableCompression = config?.KIRO_DISABLE_TOOLS_COMPRESSION ?? false;
    if (disableCompression) {
        console.log(`[Kiro Tools] 工具压缩已禁用，直接使用原始工具定义`);
        return buildKiroToolsContext(tools);
    }

    const limits = {
        // 增大默认限制以支持更多 MCP 工具
        maxToolsCount: config?.KIRO_TOOLS_MAX_COUNT ?? 64,           // 从 16 增加到 64
        maxToolsTotalBytes: config?.KIRO_TOOLS_TOTAL_MAX_BYTES ?? 128_000,  // 从 24KB 增加到 128KB
        maxToolNameChars: config?.KIRO_TOOL_NAME_MAX_CHARS ?? 128,   // 从 64 增加到 128
        maxToolDescChars: config?.KIRO_TOOL_DESC_MAX_CHARS ?? 1024,  // 从 512 增加到 1024
        schemaMaxDepth: config?.KIRO_SCHEMA_MAX_DEPTH ?? 12,         // 从 8 增加到 12
        schemaMaxProperties: config?.KIRO_SCHEMA_MAX_PROPERTIES ?? 100,  // 从 60 增加到 100
        schemaMaxArrayItems: config?.KIRO_SCHEMA_MAX_ARRAY_ITEMS ?? 60,  // 从 40 增加到 60
        minimalToolsCount: config?.KIRO_TOOLS_MINIMAL_COUNT ?? 32,   // 从 8 增加到 32
    };

    // 1) 标准化：截断 description + 清洗 schema
    let normalized = tools
        .filter((t) => t && typeof t === "object")
        .map((t) => ({
            name: truncateText(String(t.name || "").trim(), limits.maxToolNameChars),
            description: truncateText(String(t.description || ""), limits.maxToolDescChars),
            input_schema: sanitizeJsonSchema(t.input_schema || {}, limits),
        }))
        .filter((t) => t.name);

    if (normalized.length === 0) return {};

    // 2) 限制工具数量（优先保留前 N 个）
    if (normalized.length > limits.maxToolsCount) {
        console.log(`[Kiro Tools] 工具数量 ${normalized.length} 超过限制 ${limits.maxToolsCount}，截断到前 ${limits.maxToolsCount} 个`);
        normalized = normalized.slice(0, limits.maxToolsCount);
    }

    // 3) 计算体积，超阈值则逐级降级
    let toolsContext = buildKiroToolsContext(normalized);
    let bytes = getUtf8ByteLength(toolsContext);
    if (bytes <= limits.maxToolsTotalBytes) {
        console.log(`[Kiro Tools] 工具上下文大小: ${bytes} 字节，共 ${normalized.length} 个工具`);
        return toolsContext;
    }

    console.log(`[Kiro Tools] 工具上下文过大(${bytes}字节 > ${limits.maxToolsTotalBytes}字节)，开始降级...`);

    // 3.1) 去掉 description
    const noDesc = normalized.map((t) => ({ ...t, description: "" }));
    toolsContext = buildKiroToolsContext(noDesc);
    bytes = getUtf8ByteLength(toolsContext);
    if (bytes <= limits.maxToolsTotalBytes) {
        console.log(`[Kiro Tools] 已降级：移除 description（${bytes}字节，${noDesc.length} 个工具）`);
        return toolsContext;
    }

    // 3.2) 降低工具数量到 minimalToolsCount
    const minimalCount = Math.max(1, Math.min(limits.minimalToolsCount, noDesc.length));
    const fewerTools = noDesc.slice(0, minimalCount);
    toolsContext = buildKiroToolsContext(fewerTools);
    bytes = getUtf8ByteLength(toolsContext);
    if (bytes <= limits.maxToolsTotalBytes) {
        console.log(`[Kiro Tools] 已降级：限制工具数量为 ${minimalCount}（${bytes}字节）`);
        return toolsContext;
    }

    // 3.3) 最小 schema（仅保留空 object）
    const minimalSchemaTools = fewerTools.map((t) => ({
        name: t.name,
        description: "",
        input_schema: { type: "object", properties: {} },
    }));
    toolsContext = buildKiroToolsContext(minimalSchemaTools);
    bytes = getUtf8ByteLength(toolsContext);
    if (bytes <= limits.maxToolsTotalBytes) {
        console.log(`[Kiro Tools] 已降级：最小 schema（${bytes}字节，${minimalSchemaTools.length} 个工具）`);
        return toolsContext;
    }

    // 3.4) 最后手段：保留尽可能多的工具（不再完全丢弃）
    // 逐步减少工具数量直到满足大小限制
    let finalTools = minimalSchemaTools;
    while (finalTools.length > 1 && bytes > limits.maxToolsTotalBytes) {
        finalTools = finalTools.slice(0, Math.max(1, Math.floor(finalTools.length * 0.75)));
        toolsContext = buildKiroToolsContext(finalTools);
        bytes = getUtf8ByteLength(toolsContext);
    }

    console.log(`[Kiro Tools] 最终降级：保留 ${finalTools.length} 个工具（${bytes}字节）`);
    return toolsContext;
}

// Helper functions for tool calls and JSON parsing

function isQuoteCharAt(text, index) {
    if (index < 0 || index >= text.length) return false;
    const ch = text[index];
    return ch === '"' || ch === "'" || ch === '`';
}

/**
 * 查找“真正的”标签位置（不被引号/反引号紧邻包裹）。
 * 这里的规则与 kiro.rs-master 的实现保持一致：
 * - 若标签左侧紧邻字符或右侧紧邻字符是 `"`, `'`, `` ` ``，则跳过该匹配。
 */
function findRealTag(text, tag, startIndex = 0) {
    let searchStart = Math.max(0, startIndex);
    while (true) {
        const pos = text.indexOf(tag, searchStart);
        if (pos === -1) return -1;

        const hasQuoteBefore = isQuoteCharAt(text, pos - 1);
        const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length);
        if (!hasQuoteBefore && !hasQuoteAfter) {
            return pos;
        }

        searchStart = pos + 1;
    }
}

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 * @param {string} text - 要搜索的文本
 * @param {number} startPos - 起始位置
 * @param {string} openChar - 开括号字符 (默认 '[')
 * @param {string} closeChar - 闭括号字符 (默认 ']')
 * @returns {number} 匹配的闭括号位置，未找到返回 -1
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
    if (!text || startPos >= text.length || text[startPos] !== openChar) {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === openChar) {
                bracketCount++;
            } else if (char === closeChar) {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}


/**
 * 尝试修复常见的 JSON 格式问题
 * @param {string} jsonStr - 可能有问题的 JSON 字符串
 * @returns {string} 修复后的 JSON 字符串
 */
function repairJson(jsonStr) {
    let repaired = jsonStr;
    // 移除尾部逗号
    repaired = repaired.replace(/,\s*([}\]])/g, '$1');
    // 为未引用的键添加引号
    repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
    // 确保字符串值被正确引用
    repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');
    return repaired;
}

/**
 * 解析单个工具调用文本
 * @param {string} toolCallText - 工具调用文本
 * @returns {Object|null} 解析后的工具调用对象或 null
 */
function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        const repairedJson = repairJson(jsonCandidate);
        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        console.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }

        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            console.log(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
        this.uuid = config?.uuid; // 获取多节点配置的 uuid
        console.log(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        // this.accessToken = config.KIRO_ACCESS_TOKEN;
        // this.refreshToken = config.KIRO_REFRESH_TOKEN;
        // this.clientId = config.KIRO_CLIENT_ID;
        // this.clientSecret = config.KIRO_CLIENT_SECRET;
        // this.authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        // this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL;
        // this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL;
        // this.baseUrl = KIRO_CONSTANTS.BASE_URL;
        // this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL;

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                console.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                console.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
            this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method
        this.axiosSocialRefreshInstance = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        console.log('[Kiro] Initializing Kiro API Service...');
        await this.initializeAuth();
        // 根据当前加载的凭证生成唯一的 Machine ID
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
        const { osName, nodeVersion } = getSystemRuntimeInfo();

        // 配置 HTTP/HTTPS agent 限制连接池大小，避免资源泄漏
        const httpAgent = new http.Agent({
            keepAlive: true,
            maxSockets: 100,        // 每个主机最多 10 个连接
            maxFreeSockets: 5,     // 最多保留 5 个空闲连接
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });
        const httpsAgent = new https.Agent({
            keepAlive: true,
            maxSockets: 100,
            maxFreeSockets: 5,
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
        });

        const axiosConfig = {
            timeout: KIRO_CONSTANTS.AXIOS_TIMEOUT,
            httpAgent,
            httpsAgent,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
                'amz-sdk-request': 'attempt=1; max=1',
                'x-amzn-kiro-agent-mode': 'vibe',
                'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
                'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
                'Connection': 'close'
            },
        };

        // 根据 useSystemProxy 配置代理设置
        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }

        // 配置自定义代理
        configureAxiosProxy(axiosConfig, this.config, 'claude-kiro-oauth');

        this.axiosInstance = axios.create(axiosConfig);

        axiosConfig.headers = new Headers();
        axiosConfig.headers.set('Content-Type', KIRO_CONSTANTS.CONTENT_TYPE_JSON);
        this.axiosSocialRefreshInstance = axios.create(axiosConfig);
        this.isInitialized = true;
    }

    async initializeAuth(forceRefresh = false) {
        if (this.accessToken && !forceRefresh) {
            console.debug('[Kiro Auth] Access token already available and not forced refresh.');
            return;
        }

        // Helper to load credentials from a file
        const loadCredentialsFromFile = async (filePath) => {
            try {
                const fileContent = await fs.readFile(filePath, 'utf8');
                return JSON.parse(fileContent);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
                } else if (error instanceof SyntaxError) {
                    console.warn(`[Kiro Auth] Failed to parse JSON from ${filePath}: ${error.message}`);
                } else {
                    console.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
                }
                return null;
            }
        };

        // Helper to save credentials to a file
        const saveCredentialsToFile = async (filePath, newData) => {
            try {
                let existingData = {};
                try {
                    const fileContent = await fs.readFile(filePath, 'utf8');
                    existingData = JSON.parse(fileContent);
                } catch (readError) {
                    if (readError.code === 'ENOENT') {
                        console.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
                    } else {
                        console.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
                    }
                }
                const mergedData = { ...existingData, ...newData };
                await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), 'utf8');
                console.info(`[Kiro Auth] Updated token file: ${filePath}`);
            } catch (error) {
                console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`);
            }
        };

        try {
            let mergedCredentials = {};

            // Priority 1: Load from Base64 credentials if available
            if (this.base64Creds) {
                Object.assign(mergedCredentials, this.base64Creds);
                console.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
                // Clear base64Creds after use to prevent re-processing
                this.base64Creds = null;
            }

            // Priority 2 & 3 合并: 从指定文件路径或目录加载凭证
            // 读取指定的 credPath 文件以及目录下的其他 JSON 文件(排除当前文件)
            const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
            const dirPath = path.dirname(targetFilePath);
            const targetFileName = path.basename(targetFilePath);

            console.debug(`[Kiro Auth] Attempting to load credentials from directory: ${dirPath}`);

            try {
                // 首先尝试读取目标文件
                const targetCredentials = await loadCredentialsFromFile(targetFilePath);
                if (targetCredentials) {
                    Object.assign(mergedCredentials, targetCredentials);
                    console.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
                }

                // 然后读取目录下的其他 JSON 文件(排除目标文件本身)
                const files = await fs.readdir(dirPath);
                for (const file of files) {
                    if (file.endsWith('.json') && file !== targetFileName) {
                        const filePath = path.join(dirPath, file);
                        const credentials = await loadCredentialsFromFile(filePath);
                        if (credentials) {
                            // 保留已有的 expiresAt,避免被覆盖
                            credentials.expiresAt = mergedCredentials.expiresAt;
                            Object.assign(mergedCredentials, credentials);
                            console.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
                        }
                    }
                }
            } catch (error) {
                console.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
            }

            // console.log('[Kiro Auth] Merged credentials:', mergedCredentials);
            // Apply loaded credentials, prioritizing existing values if they are not null/undefined
            this.accessToken = this.accessToken || mergedCredentials.accessToken;
            this.refreshToken = this.refreshToken || mergedCredentials.refreshToken;
            this.clientId = this.clientId || mergedCredentials.clientId;
            this.clientSecret = this.clientSecret || mergedCredentials.clientSecret;
            this.authMethod = this.authMethod || mergedCredentials.authMethod;
            this.expiresAt = this.expiresAt || mergedCredentials.expiresAt;
            this.profileArn = this.profileArn || mergedCredentials.profileArn;
            this.region = this.region || mergedCredentials.region;

            // Ensure region is set before using it in URLs
            if (!this.region) {
                console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
                this.region = 'us-east-1'; // Set default region
            }

            this.refreshUrl = (this.config.KIRO_REFRESH_URL || KIRO_CONSTANTS.REFRESH_URL).replace("{{region}}", this.region);
            this.refreshIDCUrl = (this.config.KIRO_REFRESH_IDC_URL || KIRO_CONSTANTS.REFRESH_IDC_URL).replace("{{region}}", this.region);
            this.baseUrl = (this.config.KIRO_BASE_URL || KIRO_CONSTANTS.BASE_URL).replace("{{region}}", this.region);
            this.amazonQUrl = (KIRO_CONSTANTS.AMAZON_Q_URL).replace("{{region}}", this.region);
        } catch (error) {
            console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
        }

        // Refresh token if forced or if access token is missing but refresh token is available
        if (forceRefresh || (!this.accessToken && this.refreshToken)) {
            if (!this.refreshToken) {
                throw new Error('No refresh token available to refresh access token.');
            }
            try {
                const requestBody = {
                    refreshToken: this.refreshToken,
                };

                let refreshUrl = this.refreshUrl;
                if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                    refreshUrl = this.refreshIDCUrl;
                    requestBody.clientId = this.clientId;
                    requestBody.clientSecret = this.clientSecret;
                    requestBody.grantType = 'refresh_token';
                }

                let response = null;
                if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                    response = await this.axiosSocialRefreshInstance.post(refreshUrl, requestBody);
                    console.log('[Kiro Auth] Token refresh social response: ok');
                } else {
                    response = await this.axiosInstance.post(refreshUrl, requestBody);
                    console.log('[Kiro Auth] Token refresh idc response: ok');
                }

                if (response.data && response.data.accessToken) {
                    this.accessToken = response.data.accessToken;
                    this.refreshToken = response.data.refreshToken;
                    this.profileArn = response.data.profileArn;
                    const expiresIn = response.data.expiresIn;
                    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                    this.expiresAt = expiresAt;
                    console.info('[Kiro Auth] Access token refreshed successfully');

                    // Update the token file - use specified path if configured, otherwise use default
                    const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
                    const updatedTokenData = {
                        accessToken: this.accessToken,
                        refreshToken: this.refreshToken,
                        expiresAt: expiresAt,
                    };
                    if (this.profileArn) {
                        updatedTokenData.profileArn = this.profileArn;
                    }
                    await saveCredentialsToFile(tokenFilePath, updatedTokenData);
                } else {
                    throw new Error('Invalid refresh response: Missing accessToken');
                }
            } catch (error) {
                console.error('[Kiro Auth] Token refresh failed:', error.message);
                throw new Error(`Token refresh failed: ${error.message}`);
            }
        }

        if (!this.accessToken) {
            throw new Error('No access token available after initialization and refresh attempts.');
        }
    }

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        if (message == null) {
            return "";
        }
        if (Array.isArray(message)) {
            return message.map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    if (part.type === 'text' && part.text) return part.text;
                    if (part.text) return part.text;
                }
                return '';
            }).join('');
        } else if (typeof message.content === 'string') {
            return message.content;
        } else if (Array.isArray(message.content)) {
            return message.content.map(part => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object') {
                    if (part.type === 'text' && part.text) return part.text;
                    if (part.text) return part.text;
                }
                return '';
            }).join('');
        }
        return String(message.content || message);
    }

    _normalizeThinkingBudgetTokens(budgetTokens) {
        let value = Number(budgetTokens);
        if (!Number.isFinite(value) || value <= 0) {
            value = KIRO_THINKING.DEFAULT_BUDGET_TOKENS;
        }
        value = Math.floor(value);
        return Math.min(value, KIRO_THINKING.MAX_BUDGET_TOKENS);
    }

    _generateThinkingPrefix(thinking) {
        if (!thinking || thinking.type !== 'enabled') return null;
        const budget = this._normalizeThinkingBudgetTokens(thinking.budget_tokens);
        return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
    }

    _hasThinkingPrefix(text) {
        if (!text) return false;
        return text.includes(KIRO_THINKING.MODE_TAG) || text.includes(KIRO_THINKING.MAX_LEN_TAG);
    }

    /**
     * 从 Kiro 的 assistant 文本中提取 thinking 块，并转换为 Claude 的 content blocks。
     * 预期格式：<thinking>...</thinking>\n\ntext...
     */
    _toClaudeContentBlocksFromKiroText(content) {
        const raw = content ?? '';
        if (!raw) return [];

        const startPos = findRealTag(raw, KIRO_THINKING.START_TAG);
        if (startPos === -1) {
            return [{ type: "text", text: raw }];
        }

        const before = raw.slice(0, startPos);
        let rest = raw.slice(startPos + KIRO_THINKING.START_TAG.length);

        const endPosInRest = findRealTag(rest, KIRO_THINKING.END_TAG);
        let thinking = '';
        let after = '';
        if (endPosInRest === -1) {
            thinking = rest;
        } else {
            thinking = rest.slice(0, endPosInRest);
            after = rest.slice(endPosInRest + KIRO_THINKING.END_TAG.length);
        }

        if (after.startsWith('\n\n')) after = after.slice(2);

        const blocks = [];
        if (before) blocks.push({ type: "text", text: before });
        // 只要出现了 <thinking> 标签，就创建 thinking block（即使内容为空）
        blocks.push({ type: "thinking", thinking });
        if (after) blocks.push({ type: "text", text: after });
        return blocks;
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     */
    buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null, thinking = null) {
        console.log(`[Kiro] buildCodewhispererRequest 被调用，tools 参数: ${tools ? `数组长度=${tools.length}` : 'null/undefined'}`);
        const conversationId = uuidv4();

        let systemPrompt = this.getContentText(inSystemPrompt);
        let processedMessages = messages;

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        // === 上下文管理：优化文件读取 + 智能截断 ===
        // 1. 优化重复的文件读取内容
        processedMessages = optimizeFileReads(processedMessages, this.config);

        // 2. 智能截断消息历史（如果超过阈值）
        const truncationResult = truncateMessagesWithHint(
            processedMessages,
            model,
            systemPrompt,
            tools,
            this.config
        );
        processedMessages = truncationResult.messages;

        if (truncationResult.truncated) {
            console.log(`[Kiro Context] Messages truncated: ${truncationResult.truncatedCount} messages removed`);
        }

        // === Thinking 模式（与 kiro.rs-master 保持一致）===
        // Kiro 侧通过系统提示中的标签启用 extended thinking，Anthropic 的 `thinking` 参数需要在此处转换。
        const thinkingPrefix = this._generateThinkingPrefix(thinking);
        if (thinkingPrefix) {
            if (!systemPrompt) {
                systemPrompt = thinkingPrefix;
            } else if (!this._hasThinkingPrefix(systemPrompt)) {
                systemPrompt = `${thinkingPrefix}\n${systemPrompt}`;
            }
        }

        // 判断最后一条消息是否为 assistant,如果是则移除
        const lastMessage = processedMessages[processedMessages.length - 1];
        if (processedMessages.length > 0 && lastMessage.role === 'assistant') {
            if (lastMessage.content[0].type === "text" && lastMessage.content[0].text === "{") {
                console.log('[Kiro] Removing last assistant with "{" message from processedMessages');
                processedMessages.pop();
            }
        }

        // 合并相邻相同 role 的消息
        const mergedMessages = [];
        for (let i = 0; i < processedMessages.length; i++) {
            const currentMsg = processedMessages[i];

            if (mergedMessages.length === 0) {
                mergedMessages.push(currentMsg);
            } else {
                const lastMsg = mergedMessages[mergedMessages.length - 1];

                // 判断当前消息和上一条消息是否为相同 role
                if (currentMsg.role === lastMsg.role) {
                    // 合并消息内容
                    if (Array.isArray(lastMsg.content) && Array.isArray(currentMsg.content)) {
                        // 如果都是数组,合并数组内容
                        lastMsg.content.push(...currentMsg.content);
                    } else if (typeof lastMsg.content === 'string' && typeof currentMsg.content === 'string') {
                        // 如果都是字符串,用换行符连接
                        lastMsg.content += '\n' + currentMsg.content;
                    } else if (Array.isArray(lastMsg.content) && typeof currentMsg.content === 'string') {
                        // 上一条是数组,当前是字符串,添加为 text 类型
                        lastMsg.content.push({ type: 'text', text: currentMsg.content });
                    } else if (typeof lastMsg.content === 'string' && Array.isArray(currentMsg.content)) {
                        // 上一条是字符串,当前是数组,转换为数组格式
                        lastMsg.content = [{ type: 'text', text: lastMsg.content }, ...currentMsg.content];
                    }
                    // console.log(`[Kiro] Merged adjacent ${currentMsg.role} messages`);
                } else {
                    mergedMessages.push(currentMsg);
                }
            }
        }

        // 用合并后的消息替换原消息数组
        processedMessages.length = 0;
        processedMessages.push(...mergedMessages);

        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];

        // tools 压缩与限额：避免传入超大 schema/description 触发上游 InternalServerException(500)
        const toolsContext = compressToolsForKiro(tools, this.config);

        const history = [];
        let startIndex = 0;

        // Handle system prompt
        if (systemPrompt) {
            // If the first message is a user message, prepend system prompt to it
            if (processedMessages[0].role === 'user') {
                let firstUserContent = this.getContentText(processedMessages[0]);
                history.push({
                    userInputMessage: {
                        content: `${systemPrompt}\n\n${firstUserContent}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
                startIndex = 1; // Start processing from the second message
            } else {
                // If the first message is not a user message, or if there's no initial user message,
                // add system prompt as a standalone user message.
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        // 保留最近 5 条历史消息中的图片
        const keepImageThreshold = 5;
        for (let i = startIndex; i < processedMessages.length - 1; i++) {
            const message = processedMessages[i];
            // 计算当前消息距离最后一条消息的位置（从后往前数）
            const distanceFromEnd = (processedMessages.length - 1) - i;
            // 如果距离末尾不超过 5 条，则保留图片
            const shouldKeepImages = distanceFromEnd <= keepImageThreshold;

            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
                };
                let imageCount = 0;
                let toolResults = [];
                let images = [];

                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += part.text;
                        } else if (part.type === 'tool_result') {
                            toolResults.push({
                                content: [{ text: this.getContentText(part.content) }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            if (shouldKeepImages) {
                                // 最近 5 条消息内的图片保留原始数据
                                images.push({
                                    format: part.source.media_type.split('/')[1],
                                    source: {
                                        bytes: part.source.data
                                    }
                                });
                            } else {
                                // 超过 5 条历史记录的图片只记录数量
                                imageCount++;
                            }
                        }
                    }
                } else {
                    userInputMessage.content = this.getContentText(message);
                }

                // 如果有保留的图片，添加到消息中
                if (images.length > 0) {
                    userInputMessage.images = images;
                    console.log(`[Kiro] Kept ${images.length} image(s) in recent history message (distance from end: ${distanceFromEnd})`);
                }

                // 如果有被替换的图片，添加占位符说明
                if (imageCount > 0) {
                    const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`;
                    userInputMessage.content = userInputMessage.content
                        ? `${userInputMessage.content}\n${imagePlaceholder}`
                        : imagePlaceholder;
                    console.log(`[Kiro] Replaced ${imageCount} image(s) with placeholder in old history message (distance from end: ${distanceFromEnd})`);
                }

                if (toolResults.length > 0) {
                    // 去重 toolResults - Kiro API 不接受重复的 toolUseId
                    const uniqueToolResults = [];
                    const seenIds = new Set();
                    for (const tr of toolResults) {
                        if (!seenIds.has(tr.toolUseId)) {
                            seenIds.add(tr.toolUseId);
                            uniqueToolResults.push(tr);
                        }
                    }
                    userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults };
                }

                history.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = {
                    content: ''
                };
                let toolUses = [];
                let thinkingText = '';

                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'thinking') {
                            thinkingText += (part.thinking ?? part.text ?? '');
                        } else if (part.type === 'tool_use') {
                            toolUses.push({
                                input: part.input,
                                name: part.name,
                                toolUseId: part.id
                            });
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }

                if (thinkingText) {
                    assistantResponseMessage.content = assistantResponseMessage.content
                        ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                        : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
                }

                // 只添加非空字段
                if (toolUses.length > 0) {
                    assistantResponseMessage.toolUses = toolUses;
                }

                history.push({ assistantResponseMessage });
            }
        }

        // Build current message
        let currentMessage = processedMessages[processedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentToolUses = [];
        let currentImages = [];

        // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
        // 因为 CodeWhisperer API 的 currentMessage 必须是 userInputMessage 类型
        if (currentMessage.role === 'assistant') {
            console.log('[Kiro] Last message is assistant, moving it to history and creating user currentMessage');

            // 构建 assistant 消息并加入 history
            let assistantResponseMessage = {
                content: '',
                toolUses: []
            };
            let thinkingText = '';
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        assistantResponseMessage.content += part.text;
                    } else if (part.type === 'thinking') {
                        thinkingText += (part.thinking ?? part.text ?? '');
                    } else if (part.type === 'tool_use') {
                        assistantResponseMessage.toolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    }
                }
            } else {
                assistantResponseMessage.content = this.getContentText(currentMessage);
            }
            if (thinkingText) {
                assistantResponseMessage.content = assistantResponseMessage.content
                    ? `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}\n\n${assistantResponseMessage.content}`
                    : `${KIRO_THINKING.START_TAG}${thinkingText}${KIRO_THINKING.END_TAG}`;
            }
            if (assistantResponseMessage.toolUses.length === 0) {
                delete assistantResponseMessage.toolUses;
            }
            history.push({ assistantResponseMessage });

            // 设置 currentContent 为 "Continue"，因为我们需要一个 user 消息来触发 AI 继续
            currentContent = 'Continue';
        } else {
            // 最后一条消息是 user，需要确保 history 最后一个元素是 assistantResponseMessage
            // Kiro API 要求 history 必须以 assistantResponseMessage 结尾
            if (history.length > 0) {
                const lastHistoryItem = history[history.length - 1];
                if (!lastHistoryItem.assistantResponseMessage) {
                    // 最后一个不是 assistantResponseMessage，需要补全一个空的
                    console.log('[Kiro] History does not end with assistantResponseMessage, adding empty one');
                    history.push({
                        assistantResponseMessage: {
                            content: 'Continue'
                        }
                    });
                }
            }

            // 处理 user 消息
            if (Array.isArray(currentMessage.content)) {
                for (const part of currentMessage.content) {
                    if (part.type === 'text') {
                        currentContent += part.text;
                    } else if (part.type === 'tool_result') {
                        currentToolResults.push({
                            content: [{ text: this.getContentText(part.content) }],
                            status: 'success',
                            toolUseId: part.tool_use_id
                        });
                    } else if (part.type === 'tool_use') {
                        currentToolUses.push({
                            input: part.input,
                            name: part.name,
                            toolUseId: part.id
                        });
                    } else if (part.type === 'image') {
                        currentImages.push({
                            format: part.source.media_type.split('/')[1],
                            source: {
                                bytes: part.source.data
                            }
                        });
                    }
                }
            } else {
                currentContent = this.getContentText(currentMessage);
            }

            // Kiro API 要求 content 不能为空，即使有 toolResults
            if (!currentContent) {
                currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue';
            }
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: {} // Will be populated as userInputMessage
            }
        };

        // 只有当 history 非空时才添加（API 可能不接受空数组）
        if (history.length > 0) {
            request.conversationState.history = history;
        }

        // currentMessage 始终是 userInputMessage 类型
        // 注意：API 不接受 null 值，空字段应该完全不包含
        const userInputMessage = {
            content: currentContent,
            modelId: codewhispererModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        };

        // 只有当 images 非空时才添加
        if (currentImages && currentImages.length > 0) {
            userInputMessage.images = currentImages;
        }

        // 构建 userInputMessageContext，只包含非空字段
        const userInputMessageContext = {};
        if (currentToolResults.length > 0) {
            // 去重 toolResults - Kiro API 不接受重复的 toolUseId
            const uniqueToolResults = [];
            const seenToolUseIds = new Set();
            for (const tr of currentToolResults) {
                if (!seenToolUseIds.has(tr.toolUseId)) {
                    seenToolUseIds.add(tr.toolUseId);
                    uniqueToolResults.push(tr);
                }
            }
            userInputMessageContext.toolResults = uniqueToolResults;
        }
        if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
            userInputMessageContext.tools = toolsContext.tools;
            console.log(`[Kiro Tools] 工具已添加到请求中，共 ${toolsContext.tools.length} 个工具`);
        } else {
            console.log(`[Kiro Tools] 警告：toolsContext 为空，工具未被添加到请求中`);
        }

        // 只有当 userInputMessageContext 有内容时才添加
        if (Object.keys(userInputMessageContext).length > 0) {
            userInputMessage.userInputMessageContext = userInputMessageContext;
        }

        request.conversationState.currentMessage.userInputMessage = userInputMessage;

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }

        // fs.writeFile('claude-kiro-request'+Date.now()+'.json', JSON.stringify(request));
        return request;
    }

    parseEventStreamChunk(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;
        // console.log(`rawStr=${rawStr}`);

        // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
        // 使用更精确的正则来匹配 SSE 格式的事件
        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;

        // 首先尝试使用 SSE 格式解析
        let matches = [...rawStr.matchAll(sseEventRegex)];

        // 如果 SSE 格式没有匹配到，回退到旧的格式
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
                continue;
            }

            // 尝试找到完整的 JSON 对象
            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);

                    // 优先处理结构化工具调用事件
                    if (eventData.name && eventData.toolUseId) {
                        if (!currentToolCallDict) {
                            currentToolCallDict = {
                                id: eventData.toolUseId,
                                type: "function",
                                function: {
                                    name: eventData.name,
                                    arguments: ""
                                }
                            };
                        }
                        if (eventData.input) {
                            currentToolCallDict.function.arguments += eventData.input;
                        }
                        if (eventData.stop) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                console.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        // 处理内容，移除转义字符
                        let decodedContent = eventData.content;
                        // 处理常见的转义序列
                        decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                        // decodedContent = decodedContent.replace(/(?<!\\)\\t/g, '\t');
                        // decodedContent = decodedContent.replace(/\\"/g, '"');
                        // decodedContent = decodedContent.replace(/\\\\/g, '\\');
                        fullContent += decodedContent;
                    }
                    break;
                } catch (e) {
                    // JSON 解析失败，继续寻找下一个可能的结束位置
                    continue;
                }
            }
        }

        // 如果还有未完成的工具调用，添加到列表中
        if (currentToolCallDict) {
            toolCalls.push(currentToolCallDict);
        }

        // 检查解析后文本中的 bracket 格式工具调用
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            // 从响应文本中移除工具调用文本
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.replace(/\s+/g, ' ').trim();
        }

        const uniqueToolCalls = deduplicateToolCalls(toolCalls);
        return { content: fullContent || '', toolCalls: uniqueToolCalls };
    }


    /**
     * 调用 API（重试逻辑已上收至调度层；provider 层仅保留一次 403 刷新重试）
     */
    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();

        // === 基于权重的上下文压缩：在构建请求前压缩上下文 ===
        let processedBody = body;
        const enableCompression = this.config.KIRO_ENABLE_CONTEXT_COMPRESSION ?? true;

        // 检测是否为手动压缩指令
        const isManualCompression = body.messages && body.messages.length > 0 &&
            detectManualCompressionCommand(body.messages);

        if (isManualCompression) {
            console.log('[Kiro] Manual compression command detected');
        }

        if ((enableCompression || isManualCompression) && body.messages && body.messages.length > 0) {
            try {
                const compressionResult = await compressContextByWeight(
                    body.messages,
                    model,
                    body.system,
                    body.tools,
                    this.config,
                    this, // 传递服务实例用于调用 Opus 4.5
                    isManualCompression // 手动触发时强制压缩
                );

                if (compressionResult.compressed) {
                    processedBody = {
                        ...body,
                        messages: compressionResult.messages
                    };
                    const triggerType = compressionResult.manualTriggered ? '(Manual)' : '(Auto)';
                    console.log(`[Kiro] Context compressed ${triggerType}: ${compressionResult.originalTokens} -> ${compressionResult.compressedTokens} tokens`);
                    if (compressionResult.stats) {
                        console.log(`[Kiro] Compression stats: ${compressionResult.stats.highScoreKept} high-score, ${compressionResult.stats.lowScoreSummarized} summarized, ${compressionResult.stats.recentKept} recent`);
                    }
                }
            } catch (compressionError) {
                console.error('[Kiro] Context compression failed, using original messages:', compressionError.message);
                // 压缩失败时继续使用原始消息
            }
        }

        const requestData = this.buildCodewhispererRequest(processedBody.messages, model, processedBody.tools, processedBody.system, processedBody.thinking);

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
            };

            // 当 model 以 kiro-amazonq 开头时，使用 amazonQUrl，否则使用 baseUrl
            const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;
            const response = await this.axiosInstance.post(requestUrl, requestData, { headers });
            return response;
        } catch (error) {
            const status = error.response?.status;
            const errorCode = error.code;

            if (status === 403 && !isRetry) {
                console.log('[Kiro] Received 403. Attempting token refresh and retrying...');
                try {
                    await this.initializeAuth(true); // Force refresh token
                    return this.callApi(method, model, body, true, retryCount);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during 403 retry:', refreshError.message);
                    throw refreshError;
                }
            }

            console.error(`[Kiro] API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        }
    }

    _processApiResponse(response) {
        const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        if (rawResponseText.includes("[Called")) {
            console.log("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawResponseText);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        //console.log(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //console.log(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...rawBracketToolCalls);
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //console.log(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.replace(/\s+/g, ' ').trim();
        }

        //console.log(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //console.log(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContent request...');
            await this.initializeAuth(true);
        }

        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
        console.log(`[Kiro] Calling generateContent with model: ${finalModel}`);

        const response = await this.callApi('', finalModel, requestBody);

        try {
            const { responseText, toolCalls } = this._processApiResponse(response);

            let inputTokens = 0;
            const rawResponseText = Buffer.isBuffer(response.data)
                ? response.data.toString('utf8')
                : String(response.data);

            const contextUsageMatch = rawResponseText.match(/"contextUsagePercentage":\s*([\d.]+)/);
            if (contextUsageMatch) {
                const percentage = parseFloat(contextUsageMatch[1]);
                inputTokens = this.calculateInputTokensFromPercentage(percentage);
            }

            return this.buildClaudeResponse(responseText, false, 'assistant', model, toolCalls, inputTokens);
        } catch (error) {
            console.error('[Kiro] Error in generateContent:', toSafeErrorLog(error));
            throw new Error(`Error processing response: ${error.message}`);
        }
    }

    /**
     * 解析 AWS Event Stream 格式，提取所有完整的 JSON 事件
     * 返回 { events: 解析出的事件数组, remaining: 未处理完的缓冲区 }
     */
    parseAwsEventStreamBuffer(buffer) {
        const events = [];
        let remaining = buffer;
        let searchStart = 0;

        while (true) {
            // 查找真正的 JSON payload 起始位置
            // AWS Event Stream 包含二进制头部，我们只搜索有效的 JSON 模式
            // Kiro 返回格式: {"content":"..."} 或 {"name":"xxx","toolUseId":"xxx",...} 或 {"followupPrompt":"..."}

            // 搜索所有可能的 JSON payload 开头模式
            // Kiro 返回的 toolUse 可能分多个事件：
            // 1. {"name":"xxx","toolUseId":"xxx"} - 开始
            // 2. {"input":"..."} - input 数据（可能多次）
            // 3. {"stop":true} - 结束
            const contentStart = remaining.indexOf('{"content":', searchStart);
            const nameStart = remaining.indexOf('{"name":', searchStart);
            const followupStart = remaining.indexOf('{"followupPrompt":', searchStart);
            const inputStart = remaining.indexOf('{"input":', searchStart);
            const stopStart = remaining.indexOf('{"stop":', searchStart);
            const contextUsageStart = remaining.indexOf('{"contextUsagePercentage":', searchStart);

            // 找到最早出现的有效 JSON 模式
            const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart, contextUsageStart].filter(pos => pos >= 0);
            if (candidates.length === 0) break;

            const jsonStart = Math.min(...candidates);
            if (jsonStart < 0) break;

            // 正确处理嵌套的 {} - 使用括号计数法
            let braceCount = 0;
            let jsonEnd = -1;
            let inString = false;
            let escapeNext = false;

            for (let i = jsonStart; i < remaining.length; i++) {
                const char = remaining[i];

                if (escapeNext) {
                    escapeNext = false;
                    continue;
                }

                if (char === '\\') {
                    escapeNext = true;
                    continue;
                }

                if (char === '"') {
                    inString = !inString;
                    continue;
                }

                if (!inString) {
                    if (char === '{') {
                        braceCount++;
                    } else if (char === '}') {
                        braceCount--;
                        if (braceCount === 0) {
                            jsonEnd = i;
                            break;
                        }
                    }
                }
            }

            if (jsonEnd < 0) {
                // 不完整的 JSON，保留在缓冲区等待更多数据
                remaining = remaining.substring(jsonStart);
                break;
            }

            const jsonStr = remaining.substring(jsonStart, jsonEnd + 1);
            try {
                const parsed = JSON.parse(jsonStr);
                // 处理 content 事件
                if (parsed.content !== undefined && !parsed.followupPrompt) {
                    // 处理转义字符
                    let decodedContent = parsed.content;
                    // 无须处理转义的换行符，原来要处理是因为智能体返回的 content 需要通过换行符切割不同的json
                    // decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                    events.push({ type: 'content', data: decodedContent });
                }
                // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
                else if (parsed.name && parsed.toolUseId) {
                    events.push({
                        type: 'toolUse',
                        data: {
                            name: parsed.name,
                            toolUseId: parsed.toolUseId,
                            input: parsed.input || '',
                            stop: parsed.stop || false
                        }
                    });
                }
                // 处理工具调用的 input 续传事件（只有 input 字段）
                else if (parsed.input !== undefined && !parsed.name) {
                    events.push({
                        type: 'toolUseInput',
                        data: {
                            input: parsed.input
                        }
                    });
                }
                // 处理工具调用的结束事件（只有 stop 字段）
                else if (parsed.stop !== undefined) {
                    events.push({
                        type: 'toolUseStop',
                        data: {
                            stop: parsed.stop
                        }
                    });
                }
                // 处理 context usage percentage 事件
                else if (parsed.contextUsagePercentage !== undefined) {
                    events.push({
                        type: 'contextUsage',
                        data: {
                            percentage: parsed.contextUsagePercentage
                        }
                    });
                }
            } catch (e) {
                // JSON 解析失败，跳过这个位置继续搜索
            }

            searchStart = jsonEnd + 1;
            if (searchStart >= remaining.length) {
                remaining = '';
                break;
            }
        }

        // 如果 searchStart 有进展，截取剩余部分
        if (searchStart > 0 && remaining.length > 0) {
            remaining = remaining.substring(searchStart);
        }

        return { events, remaining };
    }

    /**
     * 真正的流式 API 调用 - 使用 responseType: 'stream'
     */
    async * streamApiReal(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();

        const requestData = this.buildCodewhispererRequest(body.messages, model, body.tools, body.system, body.thinking);

        const token = this.accessToken;
        const headers = {
            'Authorization': `Bearer ${token}`,
            'amz-sdk-invocation-id': `${uuidv4()}`,
        };

        const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;

        let stream = null;
        try {
            const response = await this.axiosInstance.post(requestUrl, requestData, {
                headers,
                responseType: 'stream'
            });

            stream = response.data;
            let buffer = '';
            let lastContentEvent = null;

            for await (const chunk of stream) {
                buffer += chunk.toString();

                // 解析缓冲区中的事件
                const { events, remaining } = this.parseAwsEventStreamBuffer(buffer);
                buffer = remaining;

                // yield 所有事件，但过滤连续完全相同的 content 事件（Kiro API 有时会重复发送）
                for (const event of events) {
                    if (event.type === 'content' && event.data) {
                        // 检查是否与上一个 content 事件完全相同
                        if (lastContentEvent === event.data) {
                            // 跳过重复的内容
                            continue;
                        }
                        lastContentEvent = event.data;
                        yield { type: 'content', content: event.data };
                    } else if (event.type === 'toolUse') {
                        yield { type: 'toolUse', toolUse: event.data };
                    } else if (event.type === 'toolUseInput') {
                        yield { type: 'toolUseInput', input: event.data.input };
                    } else if (event.type === 'toolUseStop') {
                        yield { type: 'toolUseStop', stop: event.data.stop };
                    } else if (event.type === 'contextUsage') {
                        yield { type: 'contextUsage', percentage: event.data.percentage };
                    }
                }
            }
        } catch (error) {
            // 确保出错时关闭流
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }

            const status = error.response?.status;
            const errorCode = error.code;

            if (status === 403 && !isRetry) {
                console.log('[Kiro] Received 403 in stream. Attempting token refresh and retrying...');
                await this.initializeAuth(true);
                yield* this.streamApiReal(method, model, body, true, retryCount);
                return;
            }

            console.error(`[Kiro] Stream API call failed (Status: ${status}, Code: ${errorCode}):`, error.message);
            throw error;
        } finally {
            // 确保流被关闭，释放资源
            if (stream && typeof stream.destroy === 'function') {
                stream.destroy();
            }
        }
    }

    // 保留旧的非流式方法用于 generateContent
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            console.error('[Kiro] Error calling API:', toSafeErrorLog(error));
            throw error;
        }
    }

    // 真正的流式传输实现
    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();

        // 调试日志：检查 requestBody 中的 tools
        console.log(`[Kiro Debug] generateContentStream 收到 requestBody，tools: ${requestBody?.tools ? `数组长度=${requestBody.tools.length}` : 'null/undefined'}`);
        if (requestBody?.tools && requestBody.tools.length > 0) {
            console.log(`[Kiro Debug] 前3个工具名称: ${requestBody.tools.slice(0, 3).map(t => t.name).join(', ')}`);
        }

        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContentStream request...');
            await this.initializeAuth(true);
        }

        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
        console.log(`[Kiro] Calling generateContentStream with model: ${finalModel} (real streaming)`);

        let inputTokens = 0;
        let contextUsagePercentage = null;
        const messageId = `${uuidv4()}`;

        let messageStartSent = false;

        const thinkingRequested = requestBody?.thinking?.type === 'enabled';

        const streamState = {
            thinkingRequested,
            buffer: '',
            inThinking: false,
            thinkingExtracted: false,
            thinkingBlockIndex: null,
            textBlockIndex: null,
            nextBlockIndex: 0,
            stoppedBlocks: new Set(),
        };

        const ensureBlockStart = (blockType) => {
            if (blockType === 'thinking') {
                if (streamState.thinkingBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.thinkingBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "thinking", thinking: "" }
                }];
            }
            if (blockType === 'text') {
                if (streamState.textBlockIndex != null) return [];
                const idx = streamState.nextBlockIndex++;
                streamState.textBlockIndex = idx;
                return [{
                    type: "content_block_start",
                    index: idx,
                    content_block: { type: "text", text: "" }
                }];
            }
            return [];
        };

        const stopBlock = (index) => {
            if (index == null) return [];
            if (streamState.stoppedBlocks.has(index)) return [];
            streamState.stoppedBlocks.add(index);
            return [{ type: "content_block_stop", index }];
        };

        const pushEvents = async function* (events) {
            for (const ev of events) {
                yield ev;
            }
        };

        const createTextDeltaEvents = (text) => {
            if (!text) return [];
            const events = [];
            events.push(...ensureBlockStart('text'));
            events.push({
                type: "content_block_delta",
                index: streamState.textBlockIndex,
                delta: { type: "text_delta", text }
            });
            return events;
        };

        const createThinkingDeltaEvents = (thinking) => {
            const events = [];
            events.push(...ensureBlockStart('thinking'));
            events.push({
                type: "content_block_delta",
                index: streamState.thinkingBlockIndex,
                delta: { type: "thinking_delta", thinking }
            });
            return events;
        };

        // 辅助函数：确保 message_start 已发送
        const ensureMessageStartSent = function* () {
            if (!messageStartSent) {
                yield {
                    type: "message_start",
                    message: {
                        id: messageId,
                        type: "message",
                        role: "assistant",
                        model: model,
                        usage: {
                            input_tokens: 0, // 初始为 0，在 message_delta 中更新
                            output_tokens: 0,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0
                        },
                        content: []
                    }
                };
                messageStartSent = true;
            }
        };

        try {
            let totalContent = '';
            let outputTokens = 0;
            const toolCalls = [];
            let currentToolCall = null;

            for await (const event of this.streamApiReal('', finalModel, requestBody)) {
                if (event.type === 'contextUsage' && event.percentage) {
                    contextUsagePercentage = event.percentage;
                    inputTokens = this.calculateInputTokensFromPercentage(contextUsagePercentage);
                    // contextUsage 事件不再触发 message_start，仅记录 inputTokens
                } else if (event.type === 'content' && event.content) {
                    // 收到第一个内容事件时立即发送 message_start，实现真正的实时流式输出
                    yield* ensureMessageStartSent();
                    totalContent += event.content;

                    if (!thinkingRequested) {
                        yield* pushEvents(createTextDeltaEvents(event.content));
                        continue;
                    }

                    streamState.buffer += event.content;
                    const events = [];

                    while (streamState.buffer.length > 0) {
                        if (!streamState.inThinking && !streamState.thinkingExtracted) {
                            const startPos = findRealTag(streamState.buffer, KIRO_THINKING.START_TAG);
                            if (startPos !== -1) {
                                const before = streamState.buffer.slice(0, startPos);
                                if (before) events.push(...createTextDeltaEvents(before));

                                streamState.buffer = streamState.buffer.slice(startPos + KIRO_THINKING.START_TAG.length);
                                streamState.inThinking = true;
                                // thinking block start 会在首次 delta 时自动创建
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.START_TAG.length);
                            if (safeLen > 0) {
                                const safeText = streamState.buffer.slice(0, safeLen);
                                if (safeText) events.push(...createTextDeltaEvents(safeText));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        if (streamState.inThinking) {
                            const endPos = findRealTag(streamState.buffer, KIRO_THINKING.END_TAG);
                            if (endPos !== -1) {
                                const thinkingPart = streamState.buffer.slice(0, endPos);
                                if (thinkingPart) events.push(...createThinkingDeltaEvents(thinkingPart));

                                streamState.buffer = streamState.buffer.slice(endPos + KIRO_THINKING.END_TAG.length);
                                streamState.inThinking = false;
                                streamState.thinkingExtracted = true;

                                // 关闭 thinking block：先发送空 thinking_delta，再发送 stop
                                events.push(...createThinkingDeltaEvents(""));
                                events.push(...stopBlock(streamState.thinkingBlockIndex));

                                // </thinking> 后通常跟随 \n\n，做一次轻量清理
                                if (streamState.buffer.startsWith('\n\n')) {
                                    streamState.buffer = streamState.buffer.slice(2);
                                }
                                continue;
                            }

                            const safeLen = Math.max(0, streamState.buffer.length - KIRO_THINKING.END_TAG.length);
                            if (safeLen > 0) {
                                const safeThinking = streamState.buffer.slice(0, safeLen);
                                if (safeThinking) events.push(...createThinkingDeltaEvents(safeThinking));
                                streamState.buffer = streamState.buffer.slice(safeLen);
                            }
                            break;
                        }

                        // thinking 已提取完毕，剩余全部作为普通文本发送
                        if (streamState.thinkingExtracted) {
                            const rest = streamState.buffer;
                            streamState.buffer = '';
                            if (rest) events.push(...createTextDeltaEvents(rest));
                            break;
                        }
                    }

                    yield* pushEvents(events);
                } else if (event.type === 'toolUse') {
                    const tc = event.toolUse;
                    // 工具调用事件（包含 name 和 toolUseId）
                    if (tc.name && tc.toolUseId) {
                        // 检查是否是同一个工具调用的续传（相同 toolUseId）
                        if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                            // 同一个工具调用，累积 input
                            currentToolCall.input += tc.input || '';
                        } else {
                            // 不同的工具调用
                            // 如果有未完成的工具调用，先保存它
                            if (currentToolCall) {
                                try {
                                    currentToolCall.input = JSON.parse(currentToolCall.input);
                                } catch (e) {
                                    // input 不是有效 JSON，保持原样
                                }
                                toolCalls.push(currentToolCall);
                            }
                            // 开始新的工具调用
                            currentToolCall = {
                                toolUseId: tc.toolUseId,
                                name: tc.name,
                                input: tc.input || ''
                            };
                        }
                        // 如果这个事件包含 stop，完成工具调用
                        if (tc.stop) {
                            try {
                                currentToolCall.input = JSON.parse(currentToolCall.input);
                            } catch (e) { }
                            toolCalls.push(currentToolCall);
                            currentToolCall = null;
                        }
                    }
                } else if (event.type === 'toolUseInput') {
                    // 工具调用的 input 续传事件
                    if (currentToolCall) {
                        currentToolCall.input += event.input || '';
                    }
                } else if (event.type === 'toolUseStop') {
                    // 工具调用结束事件
                    if (currentToolCall && event.stop) {
                        try {
                            currentToolCall.input = JSON.parse(currentToolCall.input);
                        } catch (e) {
                            // input 不是有效 JSON，保持原样
                        }
                        toolCalls.push(currentToolCall);
                        currentToolCall = null;
                    }
                }
            }

            // 处理未完成的工具调用（如果流提前结束）
            if (currentToolCall) {
                try {
                    currentToolCall.input = JSON.parse(currentToolCall.input);
                } catch (e) { }
                toolCalls.push(currentToolCall);
                currentToolCall = null;
            }

            // Fallback: 如果没有收到任何内容，发送空的 message_start
            if (!messageStartSent) {
                console.warn('[Kiro Stream] No content received from API');
                yield* ensureMessageStartSent();
            }

            // 如果 contextUsagePercentage 没有收到，使用估算值
            if (contextUsagePercentage === null) {
                console.warn('[Kiro Stream] contextUsagePercentage not received, using estimated input tokens');
                inputTokens = this.countTextTokens(JSON.stringify(requestBody.messages || []));
            }

            // 检查文本内容中的 bracket 格式工具调用
            const bracketToolCalls = parseBracketToolCalls(totalContent);
            if (bracketToolCalls && bracketToolCalls.length > 0) {
                for (const btc of bracketToolCalls) {
                    toolCalls.push({
                        toolUseId: btc.id || `tool_${uuidv4()}`,
                        name: btc.function.name,
                        input: JSON.parse(btc.function.arguments || '{}')
                    });
                }
            }

            // Flush：处理剩余缓冲区，并关闭已开启的 content block
            if (thinkingRequested && streamState.buffer) {
                if (streamState.inThinking) {
                    yield* pushEvents(createThinkingDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                    yield* pushEvents(createThinkingDeltaEvents(""));
                    for (const ev of stopBlock(streamState.thinkingBlockIndex)) {
                        yield ev;
                    }
                    streamState.inThinking = false;
                    streamState.thinkingExtracted = true;
                } else if (!streamState.thinkingExtracted) {
                    // 未进入 thinking 块（可能没有 <thinking> 标签），按普通文本发送
                    yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                } else {
                    yield* pushEvents(createTextDeltaEvents(streamState.buffer));
                    streamState.buffer = '';
                }
            }

            // 确保 text block 正常关闭（如未开启则无需关闭）
            for (const ev of stopBlock(streamState.textBlockIndex)) {
                yield ev;
            }

            // 5. 处理工具调用（如果有）
            if (toolCalls.length > 0) {
                const baseIndex = streamState.nextBlockIndex;
                for (let i = 0; i < toolCalls.length; i++) {
                    const tc = toolCalls[i];
                    const blockIndex = baseIndex + i;

                    yield {
                        type: "content_block_start",
                        index: blockIndex,
                        content_block: {
                            type: "tool_use",
                            id: tc.toolUseId || `tool_${uuidv4()}`,
                            name: tc.name,
                            input: {}
                        }
                    };

                    yield {
                        type: "content_block_delta",
                        index: blockIndex,
                        delta: {
                            type: "input_json_delta",
                            partial_json: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input || {})
                        }
                    };

                    yield { type: "content_block_stop", index: blockIndex };
                }
            }

            // 6. 发送 message_delta 事件
            // 在流结束后统一计算 output tokens，避免在流式循环中阻塞事件循环
            // output_tokens 以“去除 <thinking> 标签后的内容”为基础统计（thinking 与 text 内容仍然计入）
            const contentBlocksForCount = thinkingRequested
                ? this._toClaudeContentBlocksFromKiroText(totalContent)
                : [{ type: "text", text: totalContent }];
            const plainForCount = contentBlocksForCount
                .map(b => (b.type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '')))
                .join('');
            outputTokens = this.countTextTokens(plainForCount);
            for (const tc of toolCalls) {
                outputTokens += this.countTextTokens(JSON.stringify(tc.input || {}));
            }

            yield {
                type: "message_delta",
                delta: {
                    stop_reason: toolCalls.length > 0 ? "tool_use" : "end_turn",
                    stop_sequence: null
                },
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                }
            };

            // 7. 发送 message_stop 事件
            yield { type: "message_stop" };

        } catch (error) {
            console.error('[Kiro] Error in streaming generation:', toSafeErrorLog(error));
            throw new Error(`Error processing response: ${error.message}`);
        }
    }

    /**
     * Count tokens for a given text using Claude's official tokenizer
     */
    countTextTokens(text) {
        if (!text) return 0;
        try {
            return countTokens(text);
        } catch (error) {
            // Fallback to estimation if tokenizer fails
            console.warn('[Kiro] Tokenizer error, falling back to estimation:', error.message);
            return Math.ceil((text || '').length / 4);
        }
    }

    /**
     * Convert context usage percentage to actual input tokens
     * @param {number} percentage - Context usage percentage (0-100)
     * @returns {number} Actual input tokens
     */
    calculateInputTokensFromPercentage(percentage) {
        if (!percentage || percentage <= 0) {
            return 0;
        }

        const contextWindow = CLAUDE_DEFAULT_MAX_TOKENS;
        const inputTokens = Math.round((percentage / 100) * contextWindow);

        return inputTokens;
    }

    /**
     * @deprecated Use contextUsagePercentage from API response instead
     * Calculate input tokens from request body using Claude's official tokenizer
     */
    estimateInputTokens(requestBody) {
        console.warn('[Kiro] estimateInputTokens() is deprecated. Use contextUsagePercentage from API response instead.');
        let totalTokens = 0;

        // Count system prompt tokens
        if (requestBody.system) {
            const systemText = this.getContentText(requestBody.system);
            totalTokens += this.countTextTokens(systemText);
        }

        // Count all messages tokens
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                if (message.content) {
                    const contentText = this.getContentText(message);
                    totalTokens += this.countTextTokens(contentText);
                }
            }
        }

        // Count tools definitions tokens if present
        if (requestBody.tools && Array.isArray(requestBody.tools)) {
            totalTokens += this.countTextTokens(JSON.stringify(requestBody.tools));
        }

        return totalTokens;
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null, inputTokens = 0) {
        const messageId = `${uuidv4()}`;

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    usage: {
                        input_tokens: inputTokens,
                        output_tokens: 0 // Will be updated in message_delta
                    },
                    content: [] // Content will be streamed via content_block_delta
                }
            });

            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += this.countTextTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });

                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: JSON.stringify(inputObject)
                        }
                    });

                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += this.countTextTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let stopReason = "end_turn";
            let outputTokens = 0;

            // 1) 先处理文本/思考块（Kiro -> Claude）
            if (content) {
                const blocks = this._toClaudeContentBlocksFromKiroText(content);
                for (const b of blocks) {
                    if (b.type === 'thinking') {
                        contentArray.push({ type: "thinking", thinking: b.thinking ?? "" });
                        outputTokens += this.countTextTokens(b.thinking ?? "");
                    } else if (b.type === 'text') {
                        contentArray.push({ type: "text", text: b.text ?? "" });
                        outputTokens += this.countTextTokens(b.text ?? "");
                    }
                }
            }

            // 2) 再处理工具调用
            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object, need to parse it
                        const args = tc.function.arguments;
                        inputObject = typeof args === 'string' ? JSON.parse(args) : args;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += this.countTextTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            } else {
                stopReason = "end_turn";
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: inputTokens,
                    output_tokens: outputTokens,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0
                },
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));

        return { models: models };
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now.
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            const thresholdTime = new Date(currentTime.getTime() + cronNearMinutesInMillis);
            console.log(`[Kiro] Expiry date: ${expirationTime.getTime()}, Current time: ${currentTime.getTime()}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${thresholdTime.getTime()}`);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            console.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }

    /**
     * Count tokens for a message request (compatible with Anthropic API)
     * POST /v1/messages/count_tokens
     * @param {Object} requestBody - The request body containing model, messages, system, tools, etc.
     * @returns {Object} { input_tokens: number }
     */
    countTokens(requestBody) {
        let totalTokens = 0;

        // Count system prompt tokens
        if (requestBody.system) {
            const systemText = this.getContentText(requestBody.system);
            totalTokens += this.countTextTokens(systemText);
        }

        // Count all messages tokens
        if (requestBody.messages && Array.isArray(requestBody.messages)) {
            for (const message of requestBody.messages) {
                if (message.content) {
                    if (typeof message.content === 'string') {
                        totalTokens += this.countTextTokens(message.content);
                    } else if (Array.isArray(message.content)) {
                        for (const block of message.content) {
                            if (block.type === 'text' && block.text) {
                                totalTokens += this.countTextTokens(block.text);
                            } else if (block.type === 'tool_use') {
                                // Count tool use block tokens
                                totalTokens += this.countTextTokens(block.name || '');
                                totalTokens += this.countTextTokens(JSON.stringify(block.input || {}));
                            } else if (block.type === 'tool_result') {
                                // Count tool result block tokens
                                const resultContent = this.getContentText(block.content);
                                totalTokens += this.countTextTokens(resultContent);
                            } else if (block.type === 'image') {
                                // Images have a fixed token cost (approximately 1600 tokens for a typical image)
                                // This is an estimation as actual cost depends on image size
                                totalTokens += 1600;
                            } else if (block.type === 'document') {
                                // Documents - estimate based on content if available
                                if (block.source?.data) {
                                    // For base64 encoded documents, estimate tokens
                                    const estimatedChars = block.source.data.length * 0.75; // base64 to bytes ratio
                                    totalTokens += Math.ceil(estimatedChars / 4);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Count tools definitions tokens if present
        if (requestBody.tools && Array.isArray(requestBody.tools)) {
            for (const tool of requestBody.tools) {
                // Count tool name and description
                totalTokens += this.countTextTokens(tool.name || '');
                totalTokens += this.countTextTokens(tool.description || '');
                // Count input schema
                if (tool.input_schema) {
                    totalTokens += this.countTextTokens(JSON.stringify(tool.input_schema));
                }
            }
        }

        return { input_tokens: totalTokens };
    }

    /**
     * 获取用量限制信息
     * @returns {Promise<Object>} 用量限制信息
     */
    async getUsageLimits() {
        if (!this.isInitialized) await this.initialize();

        // 检查 token 是否即将过期，如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before getUsageLimits request...');
            await this.initializeAuth(true);
        }

        // 内部固定的资源类型
        const resourceType = 'AGENTIC_REQUEST';

        // 构建请求 URL
        const usageLimitsUrl = KIRO_CONSTANTS.USAGE_LIMITS_URL.replace('{{region}}', this.region);
        const params = new URLSearchParams({
            isEmailRequired: 'true',
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
            resourceType: resourceType
        });
        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL && this.profileArn) {
            params.append('profileArn', this.profileArn);
        }
        const fullUrl = `${usageLimitsUrl}?${params.toString()}`;

        // 构建请求头
        const machineId = generateMachineIdFromConfig({
            uuid: this.uuid,
            profileArn: this.profileArn,
            clientId: this.clientId
        });
        const kiroVersion = KIRO_CONSTANTS.KIRO_VERSION;
        const { osName, nodeVersion } = getSystemRuntimeInfo();

        const headers = {
            'Authorization': `Bearer ${this.accessToken}`,
            'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroVersion}-${machineId}`,
            'user-agent': `aws-sdk-js/1.0.0 ua/2.1 os/${osName} lang/js md/nodejs#${nodeVersion} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroVersion}-${machineId}`,
            'amz-sdk-invocation-id': uuidv4(),
            'amz-sdk-request': 'attempt=1; max=1',
            'Connection': 'close'
        };

        try {
            const response = await this.axiosInstance.get(fullUrl, { headers });
            console.log('[Kiro] Usage limits fetched successfully');
            return response.data;
        } catch (error) {
            // 如果是 403 错误，尝试刷新 token 后重试
            if (error.response?.status === 403) {
                console.log('[Kiro] Received 403 on getUsageLimits. Attempting token refresh and retrying...');
                try {
                    await this.initializeAuth(true);
                    // 更新 Authorization header
                    headers['Authorization'] = `Bearer ${this.accessToken}`;
                    headers['amz-sdk-invocation-id'] = uuidv4();
                    const retryResponse = await this.axiosInstance.get(fullUrl, { headers });
                    console.log('[Kiro] Usage limits fetched successfully after token refresh');
                    return retryResponse.data;
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during getUsageLimits retry:', refreshError.message);
                    throw refreshError;
                }
            }
            console.error('[Kiro] Failed to fetch usage limits:', toSafeErrorLog(error));
            throw error;
        }
    }
}
