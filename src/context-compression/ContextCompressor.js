/**
 * 上下文压缩器 - 整合所有压缩组件的主入口
 *
 * 与 claude-kiro.js 保持一致的压缩逻辑
 *
 * 处理流水线：
 * 1. 文件修改追踪 - 建立文件修改历史
 * 2. 语义去重 - 合并重复的工具调用结果
 * 3. 消息分类 - 将消息分为4类
 * 4. 权重打分 - 为消息计算权重分数
 * 5. 压缩处理 - 高分消息保留，低分消息生成压缩上下文
 */

import { MessageClassifier, MessageCategory } from './MessageClassifier.js';
import { WeightScorer, COMPRESSION_THRESHOLDS } from './WeightScorer.js';
import { SemanticDeduplicator } from './SemanticDeduplicator.js';
import { FileModificationTracker } from './FileModificationTracker.js';

// 默认配置（与 claude-kiro WEIGHT_COMPRESSION_CONFIG 一致）
const DEFAULT_CONFIG = {
  // 是否启用语义去重
  enableDeduplication: true,

  // 是否启用权重压缩
  enableWeightCompression: true,

  // 越新的消息加分越多（与 claude-kiro MAX_RECENCY_BONUS 一致）
  maxRecencyBonus: 20,

  // 压缩阈值（与 claude-kiro 一致）
  highScoreThreshold: 70,

  // 保留最近 N 条消息不压缩
  keepRecentCount: 10,

  // 压缩块中每条消息最大字符数
  compressedMsgMaxChars: 300,

  // 压缩块总最大字符数
  compressedTotalMaxChars: 8000,

  // 最大保留消息数（0 表示不限制）
  maxMessages: 0,

  // 是否保留压缩元数据
  preserveMetadata: false
};

export class ContextCompressor {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // 初始化组件
    this.classifier = new MessageClassifier();
    this.scorer = new WeightScorer({
      maxRecencyBonus: this.config.maxRecencyBonus
    });
    this.deduplicator = new SemanticDeduplicator();
    this.fileTracker = new FileModificationTracker();
  }

  /**
   * 压缩消息数组（与 claude-kiro 压缩逻辑一致）
   * @param {Array} messages - 原始消息数组
   * @param {Object} options - 压缩选项
   * @returns {Object} 压缩结果
   */
  compress(messages, options = {}) {
    const startTime = Date.now();
    const mergedOptions = { ...this.config, ...options };

    // 记录原始状态
    const originalCount = messages.length;
    const originalSize = this._estimateSize(messages);

    let processedMessages = [...messages];
    const stages = [];

    // 阶段1：文件修改追踪
    this.fileTracker.processMessages(processedMessages);
    stages.push({
      name: 'file_tracking',
      stats: this.fileTracker.getStatistics()
    });

    // 阶段2：语义去重
    if (mergedOptions.enableDeduplication) {
      const deduplicationResult = this.deduplicator.deduplicate(
        processedMessages,
        this.fileTracker
      );
      processedMessages = deduplicationResult.messages;
      stages.push({
        name: 'deduplication',
        originalCount: deduplicationResult.originalCount,
        deduplicatedCount: deduplicationResult.deduplicatedCount,
        duplicatesFound: deduplicationResult.duplicatesFound,
        compressionRatio: deduplicationResult.compressionRatio
      });
    }

    // 阶段3：消息分类
    const classifiedMessages = this.classifier.classifyAll(processedMessages);
    stages.push({
      name: 'classification',
      distribution: this._getClassificationDistribution(classifiedMessages)
    });

    // 阶段4：权重打分
    if (mergedOptions.enableWeightCompression) {
      const scoredMessages = this.scorer.scoreAll(classifiedMessages);
      stages.push({
        name: 'scoring',
        stats: this.scorer.getStatistics(scoredMessages)
      });

      // 阶段5：根据分数进行压缩（与 claude-kiro 一致）
      processedMessages = this._applyWeightCompression(
        scoredMessages,
        mergedOptions
      );
    } else {
      processedMessages = classifiedMessages.map(item => item.message);
    }

    // 阶段6：应用消息数量限制
    if (mergedOptions.maxMessages > 0 && processedMessages.length > mergedOptions.maxMessages) {
      processedMessages = this._applyMessageLimit(
        processedMessages,
        mergedOptions.maxMessages
      );
    }

    // 计算最终统计
    const finalCount = processedMessages.length;
    const finalSize = this._estimateSize(processedMessages);
    const processingTime = Date.now() - startTime;

    return {
      messages: processedMessages,
      statistics: {
        originalCount,
        finalCount,
        messagesRemoved: originalCount - finalCount,
        originalSize,
        finalSize,
        compressionRatio: Math.round((1 - finalSize / originalSize) * 100),
        processingTime,
        stages
      },
      metadata: mergedOptions.preserveMetadata ? {
        fileModifications: this.fileTracker.getStatistics(),
        config: mergedOptions
      } : undefined
    };
  }

  /**
   * 快速压缩 - 只进行语义去重，不进行权重压缩
   * @param {Array} messages - 原始消息数组
   * @returns {Object} 压缩结果
   */
  quickCompress(messages) {
    return this.compress(messages, {
      enableDeduplication: true,
      enableWeightCompression: false
    });
  }

  /**
   * 应用权重压缩（与 claude-kiro 一致）
   * 高分消息完整保留，低分消息生成压缩上下文
   */
  _applyWeightCompression(scoredMessages, options) {
    const { highScore, lowScore } = this.scorer.filterByScore(scoredMessages);
    const result = [];

    // 保留高分消息
    for (const item of highScore) {
      result.push(item.message);
    }

    // 低分消息生成压缩上下文（与 claude-kiro formatCompressedContext 一致）
    if (lowScore.length > 0) {
      const compressedContext = this._formatCompressedContext(lowScore, options);
      if (compressedContext) {
        // 将压缩上下文作为一条 assistant 消息插入
        result.push({
          role: 'assistant',
          content: compressedContext,
          _compressed: true,
          _compressedCount: lowScore.length
        });
      }
    }

    // 按原始顺序排序（压缩消息放在最前面）
    result.sort((a, b) => {
      if (a._compressed) return -1;
      if (b._compressed) return 1;
      const indexA = scoredMessages.findIndex(s => s.message === a);
      const indexB = scoredMessages.findIndex(s => s.message === b);
      return indexA - indexB;
    });

    return result;
  }

  /**
   * 格式化压缩上下文（与 claude-kiro formatCompressedContext 一致）
   * @param {Array} lowScoreMessages - 低分消息数组
   * @param {Object} options - 配置选项
   * @returns {string} 格式化后的压缩上下文
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
          parts.push(`... (${byCategory[MessageCategory.INTERMEDIATE_REASONING].length - parts.length + 1} more messages omitted)`);
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
          parts.push(`... (${byCategory[MessageCategory.FAILURE_RECORD].length} failure records, details omitted)`);
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
   * 应用消息数量限制
   */
  _applyMessageLimit(messages, maxMessages) {
    if (messages.length <= maxMessages) {
      return messages;
    }

    // 保留策略：保留最新的消息，但确保保留所有用户消息
    const userMessages = messages.filter(m => m.role === 'user');
    const otherMessages = messages.filter(m => m.role !== 'user');

    // 计算可以保留的非用户消息数量
    const availableSlots = maxMessages - userMessages.length;

    if (availableSlots <= 0) {
      return userMessages.slice(-maxMessages);
    }

    // 保留最新的非用户消息
    const keptOtherMessages = otherMessages.slice(-availableSlots);

    // 合并并按原始顺序排序
    const result = [...userMessages, ...keptOtherMessages];
    result.sort((a, b) => {
      const indexA = messages.indexOf(a);
      const indexB = messages.indexOf(b);
      return indexA - indexB;
    });

    return result;
  }

  /**
   * 获取分类分布
   */
  _getClassificationDistribution(classifiedMessages) {
    const distribution = {};
    for (const item of classifiedMessages) {
      const category = item.classification.category;
      distribution[category] = (distribution[category] || 0) + 1;
    }
    return distribution;
  }

  /**
   * 估算消息大小（字符数）
   */
  _estimateSize(messages) {
    return JSON.stringify(messages).length;
  }

  /**
   * 更新配置
   */
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };

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

export default ContextCompressor;
