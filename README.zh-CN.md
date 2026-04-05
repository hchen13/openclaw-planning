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
   正在 读文件  已执行 8 步                耗时 1.4m
○ 确认伊朗新闻盯盘恢复
```

进行中的项目下方会显示实时子行：当前工具活动、已执行步数、耗时——每秒刷新。卡片随 agent 进展原地更新——每个计划一张卡片，不会刷屏。

## 核心能力

- **`plan_write` 工具** — agent 创建和更新带状态跟踪的任务计划（pending → in_progress → completed/cancelled/failed）
- **子 agent 实时指标** — 进行中的计划项在卡片上实时显示当前工具、已执行步数、耗时（例如"正在 读文件 · 已执行 8 步 · 耗时 1.4m"），每秒通过飞书 PATCH 刷新
- **Coordinator 模式** — 计划活跃时，主 agent 只能调用 plan/spawn/read/communicate 类工具，所有实际工作必须通过子 agent 执行，确保每个项目都跑在独立的子 agent 里并带实时指标
- **编排执行** — 计划项被分发给独立的子 agent 执行，支持依赖追踪、独立项并行执行、完成后自动更新进度
- **自动绑定** — spawn 出的子 agent 通过激活队列自动绑到计划项（带计划顺序兜底），不需要 agent 自己提供 label
- **依赖管理** — 通过 `blockedBy` 声明项间依赖；插件验证依赖图并协调分发顺序
- **多计划并发** — 工作中途到达的不相关任务获得独立的计划和卡片，各自独立编排
- **子 agent 计划委托** — 非编排模式下，子 agent 自动更新父 session 的计划和卡片
- **计划确认闸门** — 新计划 title 的首次 `plan_write` 会被拦截一次，强制 agent 先跟用户做一轮苏格拉底式对齐再定范围
- **Spawn 拦截** — 在计划存在之前阻止 `sessions_spawn`，确保长时间后台操作前用户有可见性
- **系统提示注入** — 每轮注入活跃计划和 follow-through 行为规则（自适应：刚更新时简洁，过期时完整+警告）
- **确认拦截** — agent 有计划时抑制"要继续吗？"类消息
- **空承诺回合拦截** — 检测并处理只说不做的回复
- **计划生命周期守卫** — 计划放弃计数器、完成未关闭提醒、托管状态的向前推进接受
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

在 coordinator 模式下，主 agent 把所有实际执行都委托给子 agent，插件把每个 spawn 绑到计划项上并自动更新状态：

```
Agent 创建计划 → 将项目标记为 in_progress
  → 插件注入 <orchestration_directive> 显示就绪项
  → Agent spawn 子 agent（label 可选，自动绑定会处理）
  → 插件通过激活队列把每个 spawn 绑到下一个 pending 项，兜底按计划顺序
  → 每个子 agent 运行时实时指标持续推送到卡片
  → 子 agent 完成 → 插件自动将项标记为 completed
  → 插件检查新解锁的项 → 重新注入指令
  → Agent 分发下一批（独立项可并行）
  → 所有项完成 → Agent 关闭计划并回复
```

关键行为：
- Coordinator 模式下主 agent 只能 plan/spawn/read/communicate——所有实质工作都在子 agent 中
- 独立的项可以并行执行（agent 在一轮内 spawn 多个子 agent）
- 依赖关系被强制执行：有未完成 `blockedBy` 的项无法被分发
- 失败的依赖触发死锁检测，给出明确的决策提示
- 子 agent 不会自己调 `plan_write`——计划状态由 coordinator 统一管理

Agent 必须在 spawn 前创建计划——否则 `sessions_spawn` 会被阻止。

### 系统提示注入

每轮根据更新频率注入计划上下文：

| 状态 | 注入内容 | 目的 |
|------|----------|------|
| 无计划 | `<plan_available>` | 展示何时值得创建计划的判断标准（用户可见性 vs agent 上下文压力） |
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

**何时创建计划（以下任一条件满足即创建）：**
- **用户可见性**：用户等得足够久——久到他会开始疑惑你在干什么。多阶段工作、调研、长耗时任务——任何"用户看聊天里的进度卡就能知道现在在做什么"的场景
- **Agent 上下文压力**：任务涉及够多的大工具输出（大文件读取、多次 fetch、深度探索），把项目委托给子 agent 能明显为主上下文减负

创建计划还会解锁 `sessions_spawn`——没有计划时你无法 spawn 子 agent。这是设计如此：如果你需要 spawn，你大概率也需要 plan。

**何时不需要计划：**
- 直接问题，一两次查找 + 一次回复就能解决
- 单点修改（改变量名、修 typo、加一行）
- 快速状态检查、瞄一眼文件、读取配置
- 短对话、确认、澄清问题
- 任何能在这一轮内用一次回复直接结束的请求

判断标准：问自己"对这个请求，用户是期待看到一张进度卡，还是在等一个直接答案？"如果是直接答案，就不要 plan。开了又在同一轮关掉的 plan 是纯粹的 overhead——卡片、confirmation gate、coordinator mode，全都为了一个 5 秒的答案白花。

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
├── live-metrics.ts       # 子 agent 实时指标（耗时、工具步数、当前活动）+ 每秒卡片刷新循环
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

## 环境要求

- OpenClaw >= 2026.2.0
- Node.js >= 18（需要原生 `fetch` 支持）

## 许可证

MIT
