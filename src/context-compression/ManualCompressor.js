/**
 * 手动压缩器 - 支持本地压缩和 API 压缩两种模式
 *
 * 与 claude-kiro.js 保持一致的压缩逻辑
 *
 * 当用户使用 /compact 命令时，调用此模块
 *
 * 工作模式：
 * 1. 本地模式（默认）：使用消息分类、权重打分、语义去重进行压缩
 * 2. API 模式：调用 Kiro API 让 AI 生成压缩摘要
 *
 * 本地压缩流程（与 claude-kiro 一致）：
 * 1. 语义去重 - 合并重复的工具调用结果
 * 2. 消息分类 - 将消息分为4类（用户指令、关键状态、中间推理、失败记录）
 * 3. 权重打分 - 为消息计算权重分数
 * 4. 压缩处理 - 高分消息保留，低分消息生成压缩上下文
 */

import axios from 'axios';
import { ContextCompressor } from './ContextCompressor.js';
import { MessageClassifier, MessageCategory } from './MessageClassifier.js';
import { SemanticDeduplicator } from './SemanticDeduplicator.js';
import { FileModificationTracker } from './FileModificationTracker.js';
import { WeightScorer } from './WeightScorer.js';

// 默认配置（与 claude-kiro WEIGHT_COMPRESSION_CONFIG 一致）
const DEFAULT_CONFIG = {
  // 压缩模式：'local' 或 'api'
  mode: 'local',

  // Kiro API 端点（API 模式使用）
  apiEndpoint: 'http://localhost:3060/claude-kiro-oauth/v1/messages',

  // API 密钥（可选，如果 API 需要认证）
  apiKey: null,

  // 使用的模型（API 模式使用）
  model: 'claude-opus-4-5-20251101',

  // 最大输出 token（API 模式使用）
  maxTokens: 16000,

  // 请求超时（毫秒）
  timeout: 120000,

  // === 本地压缩配置（与 claude-kiro 一致）===
  // 保留最近 N 条消息不压缩
  keepRecentCount: 10,

  // 高分阈值（>= 此分数的消息完整保留）
  highScoreThreshold: 70,

  // 是否启用语义去重
  enableDeduplication: true,

  // 越新的消息加分越多
  maxRecencyBonus: 20,

  // 压缩上下文中每条消息的最大字符数
  compressedMsgMaxChars: 300,

  // 压缩上下文的总最大字符数
  compressedTotalMaxChars: 8000
};

export class ManualCompressor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._initClient();

    // 初始化本地压缩组件
    this.classifier = new MessageClassifier();
    this.scorer = new WeightScorer({
      maxRecencyBonus: this.config.maxRecencyBonus
    });
    this.deduplicator = new SemanticDeduplicator();
    this.fileTracker = new FileModificationTracker();
  }

  /**
   * 初始化 HTTP 客户端
   */
  _initClient() {
    const headers = {
      'Content-Type': 'application/json'
    };

    // 添加认证头
    if (this.config.apiKey) {
      // 支持 Bearer token 和 x-api-key 两种方式
      if (this.config.apiKey.startsWith('Bearer ')) {
        headers['Authorization'] = this.config.apiKey;
      } else {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        headers['x-api-key'] = this.config.apiKey;
      }
    }

    this.client = axios.create({
      timeout: this.config.timeout,
      headers
    });
  }

  /**
   * 压缩消息上下文（与 claude-kiro 一致）
   * @param {Array} messages - 原始消息数组
   * @param {Object} options - 压缩选项
   * @returns {Promise<Object>} 压缩结果
   */
  async compress(messages, options = {}) {
    const startTime = Date.now();
    const mergedOptions = { ...this.config, ...options };

    // 记录原始状态
    const originalCount = messages.length;
    const originalSize = JSON.stringify(messages).length;

    // 根据模式选择压缩方式
    if (mergedOptions.mode === 'local') {
      return this._compressLocal(messages, mergedOptions, startTime, originalCount, originalSize);
    } else {
      return this._compressApi(messages, mergedOptions, startTime, originalCount, originalSize);
    }
  }

  /**
   * 本地压缩（与 claude-kiro 一致）
   */
  _compressLocal(messages, options, startTime, originalCount, originalSize) {
    try {
      let processedMessages = [...messages];
      const stages = [];

      // 阶段1：文件修改追踪
      this.fileTracker.processMessages(processedMessages);

      // 阶段2：语义去重
      if (options.enableDeduplication) {
        const deduplicationResult = this.deduplicator.deduplicate(
          processedMessages,
          this.fileTracker
        );
        processedMessages = deduplicationResult.messages;
        stages.push({
          name: 'deduplication',
          duplicatesFound: deduplicationResult.duplicatesFound
        });
      }

      // 阶段3：消息分类
      const classifiedMessages = this.classifier.classifyAll(processedMessages);

      // 阶段4：权重打分
      const scoredMessages = this.scorer.scoreAll(classifiedMessages);

      // 阶段5：按分数分组
      const { highScore, lowScore } = this.scorer.filterByScore(scoredMessages);

      // 阶段6：生成压缩结果
      const result = [];

      // 保留高分消息
      for (const item of highScore) {
        result.push(item.message);
      }

      // 低分消息生成压缩上下文
      if (lowScore.length > 0) {
        const compressedContext = this._formatCompressedContext(lowScore, options);
        if (compressedContext) {
          result.unshift({
            role: 'assistant',
            content: compressedContext,
            _compressed: true,
            _compressedCount: lowScore.length
          });
        }
      }

      // 计算统计信息
      const finalCount = result.length;
      const finalSize = JSON.stringify(result).length;
      const processingTime = Date.now() - startTime;

      return {
        success: true,
        messages: result,
        statistics: {
          originalCount,
          finalCount,
          messagesRemoved: originalCount - finalCount,
          originalSize,
          finalSize,
          compressionRatio: Math.round((1 - finalSize / originalSize) * 100),
          processingTime,
          highScoreCount: highScore.length,
          lowScoreCount: lowScore.length,
          stages
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        messages: messages,
        statistics: {
          originalCount,
          finalCount: originalCount,
          messagesRemoved: 0,
          originalSize,
          finalSize: originalSize,
          compressionRatio: 0,
          processingTime: Date.now() - startTime
        }
      };
    }
  }

  /**
   * 格式化压缩上下文（与 claude-kiro formatCompressedContext 一致）
   */
  _formatCompressedContext(lowScoreMessages, options) {
    if (lowScoreMessages.length === 0) {
      return '';
    }

    const maxCharsPerMessage = options.compressedMsgMaxChars || 300;
    const maxTotalChars = options.compressedTotalMaxChars || 8000;

    const parts = [];
    let totalChars = 0;

    // 按类别分组
    const byCategory = {
      [MessageCategory.INTERMEDIATE_REASONING]: [],
      [MessageCategory.FAILURE_RECORD]: []
    };

    for (const scored of lowScoreMessages) {
      const category = byCategory[scored.classification.category]
        ? scored.classification.category
        : MessageCategory.INTERMEDIATE_REASONING;
      byCategory[category].push(scored);
    }

    // 格式化中间推理消息
    if (byCategory[MessageCategory.INTERMEDIATE_REASONING].length > 0) {
      parts.push(`<compressed_context type="intermediate_reasoning" count="${byCategory[MessageCategory.INTERMEDIATE_REASONING].length}">`);

      for (const scored of byCategory[MessageCategory.INTERMEDIATE_REASONING]) {
        if (totalChars >= maxTotalChars) {
          parts.push(`... (more messages omitted)`);
          break;
        }

        const message = scored.message;
        let content = this._extractMessageContent(message, maxCharsPerMessage);

        if (content.trim()) {
          parts.push(`[${message.role}#${scored.classification.index}] ${content.trim()}`);
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
          parts.push(`... (failure records omitted)`);
          break;
        }

        const message = scored.message;
        const content = this._extractMessageContent(message, maxCharsPerMessage);

        if (content.trim()) {
          parts.push(`[${message.role}#${scored.classification.index}] ${content.trim()}`);
          totalChars += content.length;
        }
      }

      parts.push('</compressed_context>');
    }

    return parts.join('\n');
  }

  /**
   * 提取消息内容（与 claude-kiro 一致）
   */
  _extractMessageContent(message, maxChars) {
    let content = '';

    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'text' && part.text) {
          content += part.text + '\n';
        } else if (part.type === 'tool_use') {
          content += `[Tool: ${part.name}${part.input?.file_path ? ` file="${part.input.file_path}"` : ''}${part.input?.pattern ? ` pattern="${part.input.pattern}"` : ''}${part.input?.command ? ` cmd="${part.input.command.slice(0, 50)}"` : ''}]\n`;
        } else if (part.type === 'tool_result') {
          const resultText = typeof part.content === 'string' ? part.content : JSON.stringify(part.content || '');
          const lines = resultText.split('\n').slice(0, 5);
          content += `[Result: ${lines.join(' ').slice(0, 150)}${resultText.length > 150 ? '...' : ''}]\n`;
        }
      }
    } else if (typeof message.content === 'string') {
      content = message.content;
    }

    // 截断过长的内容
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '...';
    }

    return content;
  }

  /**
   * API 压缩模式
   */
  async _compressApi(messages, options, startTime, originalCount, originalSize) {
    try {
      // 构建压缩请求
      const compressRequest = this._buildCompressRequest(messages, options);

      // 调用 Kiro API
      const response = await this._callKiroApi(compressRequest, options);

      // 解析压缩结果
      const compressedMessages = this._parseCompressResponse(response, messages);

      // 计算统计信息
      const finalCount = compressedMessages.length;
      const finalSize = JSON.stringify(compressedMessages).length;
      const processingTime = Date.now() - startTime;

      return {
        success: true,
        messages: compressedMessages,
        statistics: {
          originalCount,
          finalCount,
          messagesRemoved: originalCount - finalCount,
          originalSize,
          finalSize,
          compressionRatio: Math.round((1 - finalSize / originalSize) * 100),
          processingTime,
          apiTokensUsed: response.usage || null
        }
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        messages: messages,
        statistics: {
          originalCount,
          finalCount: originalCount,
          messagesRemoved: 0,
          originalSize,
          finalSize: originalSize,
          compressionRatio: 0,
          processingTime: Date.now() - startTime,
          errorDetails: error.response?.data || error.message
        }
      };
    }
  }

  /**
   * 构建压缩请求
   */
  _buildCompressRequest(messages, options) {
    // 将消息转换为文本格式，便于 AI 理解
    const messagesText = this._formatMessagesForCompression(messages);

    return {
      model: options.model,
      max_tokens: options.maxTokens,
      messages: [
        {
          role: 'user',
          content: `请压缩以下对话历史，保留关键信息：

<conversation>
${messagesText}
</conversation>

请以 JSON 数组格式输出压缩后的消息，格式如下：
\`\`\`json
[
  {"role": "user", "content": "压缩后的用户消息"},
  {"role": "assistant", "content": "压缩后的助手回复"},
  ...
]
\`\`\`

注意：
1. 保留所有用户的原始请求意图
2. 合并重复的操作结果
3. 删除冗余的中间步骤
4. 保持对话逻辑连贯`
        }
      ]
    };
  }

  /**
   * 格式化消息用于压缩
   */
  _formatMessagesForCompression(messages) {
    return messages.map((msg, index) => {
      const role = msg.role.toUpperCase();
      const content = this._extractContent(msg);
      return `[${index + 1}] ${role}:\n${content}`;
    }).join('\n\n---\n\n');
  }

  /**
   * 提取消息内容
   */
  _extractContent(message) {
    const content = message.content;

    if (typeof content === 'string') {
      return content;
    }

    if (Array.isArray(content)) {
      return content.map(block => {
        if (block.type === 'text') {
          return block.text;
        }
        if (block.type === 'tool_use') {
          return `[工具调用: ${block.name}](${JSON.stringify(block.input).substring(0, 200)}...)`;
        }
        if (block.type === 'tool_result') {
          const resultText = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
          return `[工具结果](${resultText.substring(0, 500)}${resultText.length > 500 ? '...' : ''})`;
        }
        return `[${block.type}]`;
      }).join('\n');
    }

    return JSON.stringify(content);
  }

  /**
   * 调用 Kiro API
   */
  async _callKiroApi(requestBody, options) {
    const response = await this.client.post(options.apiEndpoint, requestBody);
    return response.data;
  }

  /**
   * 解析压缩响应
   */
  _parseCompressResponse(response, originalMessages) {
    // 提取响应文本
    let responseText = '';
    if (response.content && Array.isArray(response.content)) {
      responseText = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');
    } else if (typeof response.content === 'string') {
      responseText = response.content;
    }

    // 尝试从响应中提取 JSON 数组
    try {
      // 查找 JSON 代码块
      const jsonMatch = responseText.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        if (Array.isArray(parsed)) {
          return this._validateAndNormalizeMessages(parsed);
        }
      }

      // 尝试直接解析整个响应
      const directParse = JSON.parse(responseText);
      if (Array.isArray(directParse)) {
        return this._validateAndNormalizeMessages(directParse);
      }
    } catch (e) {
      // JSON 解析失败，尝试其他方式
    }

    // 如果无法解析，创建一个摘要消息
    return this._createFallbackSummary(responseText, originalMessages);
  }

  /**
   * 验证和规范化消息
   */
  _validateAndNormalizeMessages(messages) {
    return messages
      .filter(msg => msg && msg.role && msg.content)
      .map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      }));
  }

  /**
   * 创建回退摘要
   */
  _createFallbackSummary(summaryText, originalMessages) {
    // 保留第一条用户消息
    const firstUserMessage = originalMessages.find(m => m.role === 'user');

    return [
      firstUserMessage || { role: 'user', content: '[对话开始]' },
      {
        role: 'assistant',
        content: `[上下文摘要]\n${summaryText}`
      }
    ];
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    // 如果 apiKey 变化，重新初始化客户端
    if (newConfig.apiKey !== undefined) {
      this._initClient();
    }
    // 如果 maxRecencyBonus 变化，重新初始化打分器
    if (newConfig.maxRecencyBonus !== undefined) {
      this.scorer = new WeightScorer({
        maxRecencyBonus: this.config.maxRecencyBonus
      });
    }
  }

  /**
   * 获取当前配置
   */
  getConfig() {
    return { ...this.config };
  }
}

export default ManualCompressor;
