[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning 插件

<p align="center">
  <img src="assets/demo.gif" alt="Planning 插件演示 — 飞书" />
  <img src="assets/demo-telegram.gif" alt="Planning 插件演示 — Telegram" />
</p>

**痛点：**

1. **看不到进度。** 当 AI agent 在消息平台上执行一个 20 步的任务时，用户盯着空白聊天窗口等好几分钟。没有进度条，没有状态更新，不知道 agent 是卡住了还是在思考。当 agent spawn 子 agent 时更糟——用户对一个可能持续 10 分钟的后台操作完全没有可见性。而如果上下文在任务中途被压缩，agent 会忘记自己在做什么。

2. **Agent 光说不做。** 你让 agent 做一件事，它回复"收到"或"好的我去做"，然后就没有然后了。一旦这轮对话结束，没有任何机制确保承诺会被兑现——承诺只是聊天里的一段文字，不是一个被追踪的行动。

**这个插件解决以上所有问题。** 它给 agent 提供 `plan_write` 工具来创建带实时进度卡片的结构化任务计划。计划每轮都被注入到系统提示中，让 agent 即使经历上下文压缩也能保持方向。follow-through 行为规则被注入到每个 agent 的系统提示中，驱动 agent 收到请求后立即行动，而不是应付式确认后就忘。空承诺回合拦截机制检测只说不做的回复，强制 agent 采取实际行动。

## 实际效果

当 agent 创建计划时，飞书卡片出现在用户的聊天中：

```
🗂 修复 market-watch 盯盘系统
████████░░░░░░░░ 2/4 (50%)

● [done] 诊断 price-monitor 崩溃根因
● [done] 修复代码并验证稳定运行
◉ [active] 确认 XAUT 价格盯盘恢复 — 正在验证
○ 确认伊朗新闻盯盘恢复
```

卡片随着 agent 的进展实时更新。每个计划一张卡片，原地 PATCH——不会刷屏。

## 核心能力

- **`plan_write` 工具** — agent 创建和更新带状态跟踪的任务计划（pending → in_progress → completed/cancelled/failed）
- **编排执行** — 计划项可以被分发给独立的子 agent 执行，支持依赖追踪、独立项并行执行、完成后自动更新进度
- **依赖管理** — 通过 `blockedBy` 声明项间依赖；插件验证依赖图并协调分发顺序
- **多计划并发** — 工作中途到达的不相关任务获得独立的计划和卡片，各自独立编排
- **子 agent 计划委托** — 非编排模式下，子 agent 自动更新父 session 的计划和卡片
- **Spawn 拦截** — 在计划存在之前阻止 `sessions_spawn`，确保长时间后台操作前用户有可见性
- **系统提示注入** — 每轮注入活跃计划和 follow-through 行为规则（自适应：刚更新时简洁，过期时完整+警告）
- **确认拦截** — agent 有计划时抑制”要继续吗？”类消息
- **空承诺回合拦截** — 检测并处理只说不做的回复
- **取消支持** — 用户叫停时，agent 将剩余项标记为 `cancelled`

## 工作原理

### 计划生命周期

```
Agent 收到任务
  → plan_write（创建计划，所有项目为 pending）
  → 逐步执行，更新状态
  → plan_write（关闭计划，所有项目为 completed）
  → 输出最终结果
```

### 子 Agent 计划委托（手动模式）

当 agent 不使用编排模式 spawn 子 agent 时：

```
Agent 创建计划 → spawn 子 agent
  → 插件将子 session 链接到父 session 的计划目录
  → 子 agent 的 plan_write 更新父 session 的计划文件
  → 同一张飞书/Telegram 卡片被 PATCH
  → 父 session 恢复后可继续更新同一计划
```

### 编排执行

当计划项带有 `agentTask` 字段时，插件进入编排模式：

```
Agent 创建计划（含 agentTask + blockedBy）
  → 插件注入 <orchestration_directive> 显示就绪项
  → Agent 为每个就绪项 spawn 一个子 agent（label = item ID）
  → 插件自动绑定子 agent 到对应项，标记为 in_progress
  → 子 agent 完成 → 插件自动标记为 completed
  → 插件检查新解锁的项 → 注入更新后的指令
  → Agent 分发下一批（独立项可并行）
  → 所有项完成 → Agent 汇总结果
```

与手动模式的区别：
- 编排模式的子 agent 不获得计划委托——状态由插件管理
- 独立的项可以并行执行（agent 在一轮内 spawn 多个子 agent）
- 依赖关系被强制执行：有未完成 `blockedBy` 的项无法被分发
- 失败的依赖触发死锁检测，给出明确的决策提示

Agent 必须在 spawn 前创建计划——否则 `sessions_spawn` 会被阻止。

### 系统提示注入

每轮根据更新频率注入计划上下文：

| 状态 | 注入内容 | 目的 |
|------|----------|------|
| 无计划 | `<plan_available>` | 提醒 agent 为多步任务创建计划 |
| 刚更新（idle < 3） | 简洁提醒 | 节省 token — agent 已有完整上下文 |
| 正常（idle 3–7） | 完整提醒 | 重新锚定 agent 当前进度 |
| 过期（idle ≥ 8） | 完整 + 警告 | 防止 agent 偏离目标 |

### 渠道通知

进度卡片发送到请求发起的会话中：

- **飞书** — Card 2.0 互动卡片，带堆叠条形图进度条，通过 PATCH 实时更新
- **Telegram** — 纯文本消息，带 Unicode 进度条，通过 editMessage 实时更新
- **其他渠道** — 计划仍可用于 agent 自我追踪，但不推送通知

## AI Agent 须知

如果你是一个可以使用 `plan_write` 的 AI agent，以下是你需要知道的：

**何时创建计划：**
- 任何有 3 个以上步骤的任务——即使是纯线性流程（读取 → 分析 → 输出）。计划在上下文压缩后帮你保持方向，同时让用户看到你在推进。
- 在 spawn 子 agent 前**必须**创建计划。没有计划时 spawn 会被**阻止**。先分解完整任务，再 spawn。

**何时不需要计划：**
- 快速回答、单次查找、1-3 个工具调用即可完成的任务。

**如何有效使用 plan_write：**
- 在开始工作前就创建计划。
- 3-10 个项目最合适。每个项目应该是用户能理解的里程碑——用户看到后能感觉到"好的，在推进"。
- 站在用户的角度写每个项目，描述这一步达成了什么，而不是你内部怎么实现。"采集 crypto 市场动态"是好的；"spawn 子任务：采集信息"是不好的——用户不知道 spawn 是什么，也不需要知道。
- 只有一个项目的计划没有意义。进度条从 0% 直接跳到 100%，用户看不到中间发生了什么。
- 同一时间只有一个项目标记为 `in_progress`。完成后改为 `completed`。
- 每次传递完整的 items 数组——这是全量替换，不是增量更新。
- 用 `message` 字段写状态备注（"发现 3 个问题，正在修复"）。

**多计划并发：**
- 每个计划通过标题标识。更新已有计划时使用完全相同的标题。
- 如果工作中途来了不相关的任务，用不同标题创建新计划。

**取消：**
- 当用户说停止或取消时，立即调用 `plan_write`：将剩余的 pending/in_progress 项标记为 `cancelled`，在 `message` 字段说明原因。
- 永远不要让计划停留在过期状态。

**自主执行：**
- 计划创建后，不要在每一步都停下来问是否继续。
- 仅在遇到真正需要决策的意外阻碍时才暂停。
- 所有澄清问题在创建计划之前提出，而非执行过程中。

## 计划状态

| 状态 | 文本符号 | 卡片符号 | 颜色 |
|------|----------|----------|------|
| pending（待处理） | ○ | ○ | 默认 |
| in_progress（进行中） | ◉ | ◉ **粗体** | 橙色 |
| completed（已完成） | ● | ● ~~删除线~~ | 灰色 |
| cancelled（已取消） | ✕ | ✕ ~~删除线~~ | 暗黄色 |
| failed（失败） | ✗ | ✗ **粗体** | 红色 |

## 安装

在 `openclaw.json` 中添加：

```json
{
  "plugins": {
    "installs": {
      "planning": {
        "source": "path",
        "sourcePath": "~/.openclaw/extensions/planning"
      }
    }
  }
}
```

重启 gateway 以加载插件。

### 飞书配置（可选）

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "domain": "feishu"
    }
  }
}
```

支持通过 `channels.feishu.accounts.{agentAccountId}` 配置不同 agent 使用不同应用。

### Telegram 配置（可选）

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456:ABC-DEF..."
    }
  }
}
```

支持通过 `channels.telegram.accounts.{agentAccountId}.botToken` 配置不同 agent 使用不同 bot。

## 架构

```
src/
├── index.ts              # 插件入口 — 注册工具 + 9 个钩子
├── types.ts              # 核心类型：PlanFile、PlanItem、PlanStatus
├── plan-tool.ts          # plan_write 工具的 schema 和说明
├── plan-state.ts         # 磁盘 I/O：原子读写、DAG 验证
├── plan-injection.ts     # 提示注入（计划提醒、编排指令、follow-through 规则、卡片渲染）
├── runtime-state.ts      # 内存中的 session 状态：轮次、idle 计数器、委托关系、编排绑定、托管状态
├── feishu-client.ts      # 飞书 REST 客户端（发送/更新卡片、token 缓存）
└── telegram-client.ts    # Telegram Bot API 客户端（发送/编辑消息）
```

计划文件按 agent、session 和计划标题隔离存储：

```
~/.openclaw/agents/{agentId}/plans/{sessionHash}/{titleHash}.plan.json
```

## 已知限制

- **Telegram 仅纯文本** — 未使用 `parse_mode`，Markdown 符号原样显示
- **委托要求相同 agentDir** — 子 agent 计划委托仅在父子共享同一 agent 目录时有效
- **子 agent 通知使用私有 API** — `enqueueSystemEvent` 不属于正式的 Plugin SDK，升级后可能失效
- **空承诺恢复是 best-effort** — guarded mode 抑制 promise-only 更新后，插件最多会对同一 session 触发一次隐藏 repoke，但这条恢复路径同样依赖私有 runtime API
- **conversationId 回退** — 卡片路由到群聊依赖 `message_received` 钩子中的 `conversationId`；不可用时回退到请求者私聊
- **Gateway 重启影响编排** — 编排执行过程中如果 gateway 重启，进度追踪可能丢失，需要手动重新分发
- **编排模式下进度卡片稍有延迟** — 飞书/Telegram 卡片仅在 `plan_write` 被调用时更新；编排自动状态变更会立即反映在 agent 的 prompt 中，但卡片需等 agent 同步后才更新

## 环境要求

- OpenClaw >= 2026.2.0
- Node.js >= 18（需要原生 `fetch` 支持）

## 许可证

MIT
