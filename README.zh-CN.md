[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning 插件

<p align="center">
  <img src="assets/demo.gif" alt="Planning 插件演示" />
</p>

**问题：** 当 AI agent 在消息平台上执行一个 20 步的任务时，用户盯着空白聊天窗口等好几分钟。没有进度条，没有状态更新，不知道 agent 是卡住了还是在思考。当 agent spawn 子 agent 时更糟——用户对一个可能持续 10 分钟的后台操作完全没有可见性。而如果上下文在任务中途被压缩，agent 会忘记自己在做什么。

**这个插件解决这些问题。** 它给 agent 提供 `plan_write` 工具来创建结构化任务计划。每个计划变成飞书或 Telegram 中的实时更新进度卡片。计划每轮都被注入到系统提示中，让 agent 即使经历上下文压缩也能保持方向。子 agent 自动更新父 session 的计划。用户可以干净地取消任务，因为计划始终可见。

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
- **多计划并发** — 工作中途到达的不相关任务获得独立的计划和卡片
- **子 agent 计划委托** — 子 agent 自动更新父 session 的计划和卡片，而非创建自己的
- **Spawn 拦截** — 在计划存在之前阻止 `sessions_spawn`，确保长时间后台操作前用户有可见性
- **系统提示注入** — 每轮注入活跃计划（自适应：刚更新时简洁，过期时完整+警告）
- **会话感知路由** — 卡片发送到正确的聊天（群聊或私聊），而非始终发到请求者私聊
- **确认拦截** — agent 有计划时抑制"要继续吗？"类消息
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

### 子 Agent 计划委托

当 agent spawn 子 agent 时：

```
Agent 创建计划 → spawn 子 agent
  → 插件将子 session 链接到父 session 的计划目录
  → 子 agent 的 plan_write 更新父 session 的计划文件
  → 同一张飞书/Telegram 卡片被 PATCH
  → 父 session 恢复后可继续更新同一计划
```

Agent 必须在 spawn 前创建计划——否则 `sessions_spawn` 会被阻止。这确保用户始终能看到进展，取消也能干净执行。

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
├── index.ts              # 插件入口 — 注册工具 + 8 个钩子
├── types.ts              # 核心类型：PlanFile、PlanItem、PlanStatus
├── plan-tool.ts          # plan_write 工具的 schema 和说明
├── plan-state.ts         # 磁盘 I/O：原子读写 .plan.json 文件
├── plan-injection.ts     # 系统提示文本 + 飞书卡片 + 纯文本渲染
├── runtime-state.ts      # 内存中的 session 状态：idle 计数器、委托关系、会话跟踪
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
- **conversationId 回退** — 卡片路由到群聊依赖 `message_received` 钩子中的 `conversationId`；不可用时回退到请求者私聊

## 环境要求

- OpenClaw >= 2026.2.0
- Node.js >= 18（需要原生 `fetch` 支持）

## 许可证

MIT
