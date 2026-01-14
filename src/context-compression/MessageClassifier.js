/**
 * 消息分类器 - 将消息分为4类
 *
 * 与 claude-kiro.js 保持一致的分类逻辑
 *
 * 分类：
 * 1. USER_INSTRUCTION - 用户指令，权重最高
 * 2. KEY_STATE - 关键状态（工具调用结果、关键决策点）
 * 3. INTERMEDIATE_REASONING - 中间推理（AI思考过程）
 * 4. FAILURE_RECORD - 失败记录（错误信息、失败尝试）
 *
 * 分类优先级（与 claude-kiro 一致）：
 * 1. 失败记录优先识别（最高优先级）
 * 2. 用户指令识别
 * 3. 关键状态工具识别
 * 4. 查询类工具识别
 * 5. 默认分类
 */

export const MessageCategory = {
  USER_INSTRUCTION: 'USER_INSTRUCTION',
  KEY_STATE: 'KEY_STATE',
  INTERMEDIATE_REASONING: 'INTERMEDIATE_REASONING',
  FAILURE_RECORD: 'FAILURE_RECORD'
};

// 失败/错误相关的关键词（与 claude-kiro 一致）
const FAILURE_KEYWORDS = [
  'error', 'failed', 'exception', 'Error', 'Failed', 'Exception',
  'TypeError', 'SyntaxError', 'ReferenceError', 'cannot', 'unable',
  '错误', '失败', '异常', '不行', '无法', '报错', '出错'
];

// 用户指令关键词（与 claude-kiro 一致）
const USER_INSTRUCTION_KEYWORDS = [
  '帮我', '请', '修改', '实现', '添加', '删除', '创建', '修复', '优化',
  '怎么', '如何', '为什么', '什么是', '能不能', '可以',
  'help', 'please', 'fix', 'add', 'remove', 'create', 'implement',
  'how', 'what', 'why', 'can you', 'could you', 'would you'
];

// 用户确认/决策关键词（与 claude-kiro 一致）
const USER_CONFIRMATION_KEYWORDS = [
  '好的', '确认', '同意', '可以', '行', '对', '是的', '没问题',
  'ok', 'yes', 'sure', 'confirmed', 'agree', 'approved', 'lgtm'
];

// 关键状态工具列表（与 claude-kiro 一致）
const KEY_STATE_TOOLS = [
  'Edit', 'Write', 'NotebookEdit', 'Bash', 'TodoWrite'
];

// 查询类工具（中间推理，与 claude-kiro 一致）
const QUERY_TOOLS = [
  'Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task'
];

export class MessageClassifier {
  constructor(options = {}) {
    this.failureKeywords = options.failureKeywords || FAILURE_KEYWORDS;
    this.userInstructionKeywords = options.userInstructionKeywords || USER_INSTRUCTION_KEYWORDS;
    this.userConfirmationKeywords = options.userConfirmationKeywords || USER_CONFIRMATION_KEYWORDS;
    this.keyStateTools = options.keyStateTools || KEY_STATE_TOOLS;
    this.queryTools = options.queryTools || QUERY_TOOLS;
  }

  /**
   * 对单条消息进行分类（与 claude-kiro classifyMessage 保持一致）
   * @param {Object} message - 消息对象
   * @param {number} index - 消息在数组中的索引
   * @param {number} totalMessages - 消息总数（可选）
   * @returns {Object} 包含分类信息的对象
   */
  classify(message, index, totalMessages = 0) {
    const role = message.role;
    const content = message.content;
    const text = this._getContentText(content);
    const tools = this._extractToolNames(message);

    // 1. 检查是否为失败记录（优先级最高，因为失败需要被识别出来）
    if (this._containsFailureKeywords(text)) {
      return {
        category: MessageCategory.FAILURE_RECORD,
        reason: '包含错误/失败关键词',
        index
      };
    }

    // 2. 检查是否为用户指令
    if (role === 'user') {
      // 排除纯工具结果的用户消息
      const hasOnlyToolResult = Array.isArray(content) &&
        content.length > 0 &&
        content.every(p => p && p.type === 'tool_result');

      if (!hasOnlyToolResult) {
        // 检查是否包含指令关键词或是问句
        if (this._containsAnyKeyword(text, this.userInstructionKeywords) ||
            text.includes('?') || text.includes('？')) {
          return {
            category: MessageCategory.USER_INSTRUCTION,
            reason: '用户指令/问题',
            index
          };
        }
        // 检查是否为用户确认
        if (this._containsAnyKeyword(text, this.userConfirmationKeywords)) {
          return {
            category: MessageCategory.KEY_STATE,
            reason: '用户确认/决策',
            index
          };
        }
      }
    }

    // 3. 检查是否为关键状态（包含修改类工具）
    const hasKeyStateTool = tools.some(t => this.keyStateTools.includes(t));
    if (hasKeyStateTool) {
      return {
        category: MessageCategory.KEY_STATE,
        reason: `包含关键工具: ${tools.filter(t => this.keyStateTools.includes(t)).join(', ')}`,
        tools,
        index
      };
    }

    // 4. 检查是否为查询类操作（中间推理）
    const hasQueryTool = tools.some(t => this.queryTools.includes(t));
    if (hasQueryTool || tools.includes('__tool_result__')) {
      return {
        category: MessageCategory.INTERMEDIATE_REASONING,
        reason: '查询/分析操作',
        tools,
        index
      };
    }

    // 5. 默认分类
    if (role === 'user') {
      // 用户消息默认为指令（可能是简短的指令）
      return {
        category: MessageCategory.USER_INSTRUCTION,
        reason: '用户消息（默认）',
        index
      };
    }

    // AI 回复默认为中间推理
    return {
      category: MessageCategory.INTERMEDIATE_REASONING,
      reason: 'AI 回复（默认）',
      index
    };
  }

  /**
   * 批量分类消息
   * @param {Array} messages - 消息数组
   * @returns {Array} 分类结果数组
   */
  classifyAll(messages) {
    const totalMessages = messages.length;
    return messages.map((msg, index) => ({
      message: msg,
      classification: this.classify(msg, index, totalMessages)
    }));
  }

  /**
   * 按分类分组消息
   * @param {Array} messages - 消息数组
   * @returns {Object} 按分类分组的消息
   */
  groupByCategory(messages) {
    const classified = this.classifyAll(messages);
    const groups = {
      [MessageCategory.USER_INSTRUCTION]: [],
      [MessageCategory.KEY_STATE]: [],
      [MessageCategory.INTERMEDIATE_REASONING]: [],
      [MessageCategory.FAILURE_RECORD]: []
    };

    for (const item of classified) {
      groups[item.classification.category].push(item);
    }

    return groups;
  }

  // ============ 辅助方法 ============

  _hasToolCalls(message) {
    // OpenAI 格式
    if (message.tool_calls && message.tool_calls.length > 0) {
      return true;
    }
    // Claude 格式
    if (Array.isArray(message.content)) {
      return message.content.some(block =>
        block.type === 'tool_use' || block.type === 'tool_call'
      );
    }
    return false;
  }

  _extractToolNames(message) {
    const names = [];

    // OpenAI 格式
    if (message.tool_calls) {
      for (const call of message.tool_calls) {
        if (call.function?.name) {
          names.push(call.function.name);
        }
      }
    }

    // Claude 格式
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if ((block.type === 'tool_use' || block.type === 'tool_call') && block.name) {
          names.push(block.name);
        }
        if (block.type === 'tool_result' && block.tool_use_id) {
          names.push('__tool_result__');
        }
      }
    }

    return names;
  }

  _getContentText(content) {
    if (typeof content === 'string') {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .map(block => {
          if (block.type === 'text') return block.text || '';
          if (block.type === 'thinking') return block.thinking || '';
          if (block.type === 'tool_result') {
            return typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          }
          if (block.type === 'tool_use') return `[Tool: ${block.name}]`;
          return '';
        })
        .join('\n');
    }
    return '';
  }

  _containsAnyKeyword(text, keywords) {
    if (!text) return false;
    const lowerText = String(text).toLowerCase();
    return keywords.some(kw => lowerText.includes(String(kw).toLowerCase()));
  }

  _containsFailureKeywords(text) {
    if (!text) return false;
    const contentText = typeof text === 'string' ? text : this._getContentText(text);
    return this._containsAnyKeyword(contentText, this.failureKeywords);
  }
}

export default MessageClassifier;
