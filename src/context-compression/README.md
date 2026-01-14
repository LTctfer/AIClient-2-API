# 上下文压缩系统

## Problem

长对话上下文会导致：

- **Token 消耗过高**：重复读取同一文件、相同搜索结果占用大量 token
- **上下文溢出**：超过模型上下文窗口限制
- **响应变慢**：处理大量历史消息增加延迟

### 典型场景

| 场景 | 重复率 | Token 浪费 |
|------|--------|------------|
| 多次读取同一文件 | 高 | ~5000 tokens |
| 相似搜索重复执行 | 中 | ~1500 tokens |
| 目录列表重复 | 高 | ~500 tokens |
| 相同错误信息 | 高 | ~2000 tokens |

---

## Solution

实现两层压缩策略：

### 本地压缩（规则驱动）

```
原始消息 → 语义去重 → 消息分类 → 权重打分 → 压缩处理 → 压缩后消息
```

#### 消息分类与权重

| 分类 | 权重 | 处理方式 |
|------|------|----------|
| USER_INSTRUCTION | 100 | 永不压缩 |
| KEY_STATE | 80 | 完整保留 |
| INTERMEDIATE_REASONING | 40 | 进入压缩块 |
| FAILURE_RECORD | 20 | 进入压缩块 |

#### 打分公式

```javascript
finalScore = baseScore + recencyBonus
// recencyBonus = (index / (total - 1)) * 20
// 越新的消息加分越多
```

#### 分组策略

- **高分 (≥70)**：完整保留原始消息
- **低分 (<70)**：生成 `<compressed_context>` 压缩块

#### 语义去重

- 幂等工具（Read/Grep/Glob）相同调用合并
- 文件修改追踪，避免错误去重已变化内容
- 指纹生成：`hash(tool_name + params)`

### 手动压缩（AI 驱动）

调用 Kiro API 让 AI 生成压缩摘要：

```javascript
const compressor = new ManualCompressor({
  mode: 'api',  // 或 'local' 使用本地压缩
  apiEndpoint: 'http://localhost:3060/claude-kiro-oauth/v1/messages',
  apiKey: 'optional-key',
  model: 'claude-opus-4-5-20251101'
});

const result = await compressor.compress(messages);
```

---

## Architecture

```
src/context-compression/
├── index.js                    # 入口，导出所有组件
├── ContextCompressor.js        # 主压缩器（整合流水线）
├── MessageClassifier.js        # 消息分类器（4类）
├── WeightScorer.js             # 权重打分（时间加成）
├── SemanticDeduplicator.js     # 语义去重（指纹+相似度）
├── FileModificationTracker.js  # 文件修改追踪
├── ManualCompressor.js         # 手动压缩（本地+API双模式）
└── test.js / test-manual.js    # 测试文件
```

### 核心组件

#### MessageClassifier

```javascript
// 分类优先级（与 claude-kiro 一致）
1. 失败记录优先识别（最高优先级）
2. 用户指令识别
3. 关键状态工具识别（Edit, Write, Bash, TodoWrite）
4. 查询类工具识别（Read, Grep, Glob, WebFetch）
5. 默认分类
```

#### WeightScorer

```javascript
// 基础权重ER_INSTRUCTION: 100
KEY_STATE: 80
INTERMEDIATE_REASONING: 40
FAILURE_RECORD: 20

// 时间加成
recencyBonus = (index / (total - 1)) * MAX_RECENCY_BONUS(20)
```

#### 压缩上下文格式

```xml
<compressed_context type="intermediate_reasoning" count="5">
[assistant#3] [Tool: Read file="src/index.js"]
[Result: import { ... }...]
[assistant#5] [Tool: Grep pattern="function"]
...
</compressed_context>

<compressed_context type="failure_records" count="2">
[assistant#7] Error: Cannot find module...
...
</compressed_context>
```

---

## Test Results

### 本地压缩测试 - ALL PASSED ✅

| 指标 | 压缩前 | 压缩后 | 效果 |
|------|--------|--------|------|
| 消息数 | 22 | 12 | -45% |
| 大小 | 6138 chars | 1018 chars | -83% |
| 处理时间 | - | 2ms | 极快 |

### 分类分布

- 用户指令: 6 条 (保留)
- 中间推理: 11 条 (压缩)
- 关键状态: 3 条 (保留)
- 失败记录: 2 条 (压缩)

---

## Usage

### 方式1: 本地快速压缩

```javascript
import { ContextCompressor } from './context-compression/index.js';

const compressor = new ContextCompressor({
  enableDeduplication: true,
  enableWeightCompression: true,
  highScoreThreshold: 70,
  compressedMsgMaxChars: 300,
  compressedTotalMaxChars: 8000
});

const result = compressor.compress(messages);
console.log(result.statistics);
// { originalCount: 22, finalCount: 12, compressionRatio: 83 }
```

### 方式2: 手动压缩（本地模式）

```javascript
import { ManualCompressor } from './context-compression/index.js';

const manual = new ManualCompressor({
  mode: 'local',  // 使用本地压缩
  enableDeduplication: true,
  highScoreThreshold: 70
});

const result = await manual.compress(messages);
```

### 方式3: 手动压缩（API 模式）

```javascript
import { ManualCompressor } from './context-compression/index.js';

const manual = new ManualCompressor({
  mode: 'api',
  apiEndpoint: 'http://localhost:3060/claude-kiro-oauth/v1/messages',
  apiKey: 'your-api-key',
  model: 'claude-opus-4-5-20251101'
});

const result = await manual.compress(messages);
```

### 方式4: 快捷函数

```javascript
import { compressContext, manualCompress } from './context-compression/index.js';

// 本地压缩
const localResult = compressContext(messages);

// AI 压缩
const apiResult = await manualCompress(messages, {
  mode: 'api',
  apiKey: 'xxx'
});
```

---

## Configuration

### ContextCompressor 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| enableDeduplication | true | 启用语义去重 |
| enableWeightCompression | true | 启用权重压缩 |
| maxRecencyBonus | 20 | 最大时间加成 |
| highScoreThreshold | 70 | 高分阈值 |
| keepRecentCount | 10 | 保留最近N条不压缩 |
| compressedMsgMaxChars | 300 | 压缩块单条最大字符 |
| compressedTotalMaxChars | 8000 | 压缩块总最大字符 |
| maxMessages | 0 | 最大消息数（0=不限） |

### ManualCompressor 配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| mode | 'local' | 压缩模式：local/api |
| apiEndpoint | localhost:3060 | API 端点 |
| apiKey | null | API 密钥 |
| model | claude-opus-4-5 | 使用的模型 |
| maxTokens | 16000 | 最大输出 token |
| timeout | 120000 | 请求超时(ms) |

---

## Impact

- ✅ **压缩率 83%**：大幅减少 token 消耗
- ✅ **处理速度 2ms**：本地压缩几乎无延迟
- ✅ **保留关键信息**：用户指令永不丢失
- ✅ **智能去重**：相同文件读取自动合并
- ✅ **文件变化感知**：修改后的文件不会被错误去重
- ✅ **双模式支持**：本地规则 + AI 压缩可选

---

## Changes

- 新增: `src/context-compression/index.js`
- 新增: `src/context-compression/ContextCompressor.js`
- 新增: `src/context-compression/MessageClassifier.js`
- 新增: `src/context-compression/WeightScorer.js`
- 新增: `src/context-compression/SemanticDeduplicator.js`
- 新增: `src/context-compression/FileModificationTracker.js`
- 新增: `src/context-compression/ManualCompressor.js`
- 新增: `src/context-compression/test.js`
- 新增: `src/context-compression/test-manual.js`

---

## 与 claude-kiro.js 的一致性

本模块的压缩逻辑与 `claude-kiro.js` 保持一致：

1. **消息分类**：相同的 4 类分类和关键词
2. **权重打分**：相同的基础权重和时间加成公式
3. **压缩格式**：使用 `<compressed_context>` 标签
4. **分组策略**：≥70 保留，<70 压缩
