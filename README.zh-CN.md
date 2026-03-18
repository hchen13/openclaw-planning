[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning 插件

为 OpenClaw agent 提供结构化任务规划能力。帮助 agent 在多步工具调用和上下文压缩中保持目标不偏移，同时让用户实时看到 agent 的工作进度。

## 功能特性

- **`plan_write` 工具** — agent 在多步任务中创建和更新任务计划
- **系统提示注入** — 每轮对话自动注入当前计划状态（简洁/完整/过期提醒，根据更新频率自适应）
- **飞书互动卡片** — 可视化进度卡片，通过 PATCH 实时更新
- **Telegram 消息** — 纯文本进度展示，通过 editMessage 实时更新
- **确认拦截** — 当存在活跃计划时，自动拦截不必要的"要继续吗？"类确认消息
- **子任务感知** — 当子 agent 失败时，通知父 session

## 工作原理

### 计划生命周期

```
Agent 收到任务
  → plan_write（创建计划，所有项目为 pending）
  → 逐步执行，更新状态
  → plan_write（关闭计划，所有项目为 completed）
  → 输出最终结果
```

### 系统提示注入

每轮对话中，`before_prompt_build` 根据计划状态注入上下文：

| 状态 | 注入内容 | 目的 |
|------|----------|------|
| 无计划 | `<plan_available>` | 提醒 agent 为多步任务创建计划 |
| 刚更新（idle < 3） | 简洁提醒 | 节省 token — agent 已有完整上下文 |
| 正常（idle 3–7） | 完整提醒 | 显示当前计划状态和所有项目 |
| 过期（idle ≥ 8） | 完整 + 警告 | 提醒 agent 更新计划 |

### 渠道通知

当 agent 调用 `plan_write` 时，进度会推送到用户所在渠道：

- **飞书** — Card 2.0 互动卡片，带堆叠条形图进度条，通过 PATCH 实时更新
- **Telegram** — 纯文本消息，带 Unicode 进度条，通过 editMessage 实时更新
- **其他渠道** — 计划仍可用于 agent 自我追踪，但不推送通知

### 确认拦截

`message_sending` 钩子检测短确认请求消息（如"shall I proceed?"、"是否继续？"），在存在活跃计划时将其拦截。匹配策略保守——宁可漏过也不误杀。

## 计划状态

| 状态 | 文本符号 | 卡片符号 | 卡片颜色 |
|------|----------|----------|----------|
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

要启用飞书卡片通知，在 `openclaw.json` 中配置凭据：

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

要启用 Telegram 消息通知：

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

## 文件结构

```
src/
├── index.ts              # 插件入口 — 注册工具 + 4 个钩子
├── types.ts              # 核心类型：PlanFile、PlanItem、PlanStatus
├── plan-tool.ts          # plan_write 工具的 schema 和说明
├── plan-state.ts         # 磁盘 I/O：原子读写 .plan.json 文件
├── plan-injection.ts     # 系统提示文本 + 飞书卡片 + 纯文本渲染
├── runtime-state.ts      # 内存中的 session 状态：idle 计数器、活跃计划标志
├── feishu-client.ts      # 飞书 REST 客户端（发送/更新卡片、token 缓存）
└── telegram-client.ts    # Telegram Bot API 客户端（发送/编辑消息）
```

计划文件按 agent 和 session 隔离存储：

```
~/.openclaw/agents/{agentId}/plans/{hash}.plan.json
```

## 已知限制

- **换标题后旧卡片不清理** — agent 更改计划标题时会发送新卡片，但旧卡片不会被删除
- **Telegram 仅纯文本** — 消息未使用 `parse_mode`，Markdown 格式不会被渲染
- **子 agent 通知使用私有 API** — `enqueueSystemEvent` 不属于正式的 Plugin SDK，OpenClaw 升级后可能失效
- **计划不跨 session 共享** — 每个 session 有独立的计划，子 agent 无法直接更新父 session 的计划

## 环境要求

- OpenClaw >= 2026.2.0
- Node.js >= 18（需要原生 `fetch` 支持）

## 许可证

MIT
