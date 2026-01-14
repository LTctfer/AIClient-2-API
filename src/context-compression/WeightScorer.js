/**
 * 权重打分器 - 为消息计算权重分数
 *
 * 与 claude-kiro.js 保持一致的打分逻辑
 *
 * 基础权重：
 * - 用户指令: 100 (永不压缩)
 * - 关键状态: 80 (轻度压缩)
 * - 中间推理: 40 (激进压缩)
 * - 失败记录: 20 (可抛弃)
 *
 * 调整因素：
 * - 时间加成：越新的消息加分越多（与 claude-kiro 一致）
 */

import { MessageCategory } from './MessageClassifier.js';

// 基础权重配置（与 claude-kiro WEIGHTS 一致）
const BASE_WEIGHTS = {
  [MessageCategory.USER_INSTRUCTION]: 100,
  [MessageCategory.KEY_STATE]: 80,
  [MessageCategory.INTERMEDIATE_REASONING]: 40,
  [MessageCategory.FAILURE_RECORD]: 20
};

// 压缩阈值配置（与 claude-kiro 一致）
const COMPRESSION_THRESHOLDS = {
  HIGH_SCORE: 70,    // >= 70 完整保留
  LOW_SCORE: 30      // < 70 进入压缩块
};

export class WeightScorer {
  constructor(options = {}) {
    this.baseWeights = options.baseWeights || BASE_WEIGHTS;
    this.thresholds = options.thresholds || COMPRESSION_THRESHOLDS;

    // 时间加成配置（与 claude-kiro MAX_RECENCY_BONUS 一致）
    this.maxRecencyBonus = options.maxRecencyBonus ?? 20;
  }

  /**
   * 计算单条消息的权重分数（与 claude-kiro scoreMessages 保持一致）
   * @param {Object} classifiedMessage - 包含 message 和 classification 的对象
   * @param {number} totalMessages - 消息总数
   * @returns {Object} 包含分数信息的对象
   */
  score(classifiedMessage, totalMessages) {
    const { message, classification } = classifiedMessage;
    const { category, index } = classification;

    // 1. 获取基础权重
    const baseScore = this.baseWeights[category] || 40;

    // 2. 计算时间加成：越新的消息加分越多
    const recencyRatio = totalMessages > 1 ? index / (totalMessages - 1) : 1;
    const recencyBonus = recencyRatio * this.maxRecencyBonus;

    // 3. 计算最终分数
    const finalScore = baseScore + recencyBonus;

    return {
      score: Math.round(finalScore * 10) / 10,
      baseScore,
      recencyBonus: Math.round(recencyBonus * 10) / 10,
      category,
      index,
      reason: classification.reason
    };
  }

  /**
   * 批量计算消息权重（与 claude-kiro scoreMessages 保持一致）
   * @param {Array} classifiedMessages - 分类后的消息数组
   * @returns {Array} 带分数的消息数组
   */
  scoreAll(classifiedMessages) {
    const totalMessages = classifiedMessages.length;

    return classifiedMessages.map(item => ({
      ...item,
      scoring: this.score(item, totalMessages)
    }));
  }

  /**
   * 按分数分组消息（与 claude-kiro groupMessagesByScore 保持一致）
   * @param {Array} scoredMessages - 带分数的消息数组
   * @returns {Object} 分组后的消息 { highScore, lowScore }
   */
  filterByScore(scoredMessages) {
    const highThreshold = this.thresholds.HIGH_SCORE;

    const highScore = [];
    const lowScore = [];

    for (const item of scoredMessages) {
      if (item.scoring.score >= highThreshold) {
        highScore.push(item);
      } else {
        lowScore.push(item);
      }
    }

    return { highScore, lowScore };
  }

  /**
   * 获取压缩统计信息
   * @param {Array} scoredMessages - 带分数的消息数组
   * @returns {Object} 统计信息
   */
  getStatistics(scoredMessages) {
    const filtered = this.filterByScore(scoredMessages);

    const stats = {
      total: scoredMessages.length,
      highScore: filtered.highScore.length,
      lowScore: filtered.lowScore.length,
      averageScore: 0,
      categoryDistribution: {}
    };

    // 计算平均分
    if (scoredMessages.length > 0) {
      const totalScore = scoredMessages.reduce((sum, item) => sum + item.scoring.score, 0);
      stats.averageScore = Math.round(totalScore / scoredMessages.length * 10) / 10;
    }

    // 统计分类分布
    for (const item of scoredMessages) {
      const category = item.classification.category;
      stats.categoryDistribution[category] = (stats.categoryDistribution[category] || 0) + 1;
    }

    return stats;
  }
}

export { BASE_WEIGHTS, COMPRESSION_THRESHOLDS };
export default WeightScorer;
