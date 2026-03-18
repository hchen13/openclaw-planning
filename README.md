[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning Plugin

Structured task planning for OpenClaw agents. Keeps agents on track across tool calls and context compaction, and gives users real-time visibility into what their agent is doing.

## Features

- **`plan_write` tool** — agents create and update task plans during multi-step work
- **System prompt injection** — current plan state is injected every turn (sparse/full/stale reminders, adaptive to recency)
- **Feishu interactive cards** — visual progress cards with live PATCH updates
- **Telegram messages** — plain-text progress with live edits
- **Confirmation interception** — suppresses unnecessary "shall I proceed?" messages when an active plan exists
- **Subagent awareness** — pokes parent session when a sub-agent fails

## How It Works

### Plan Lifecycle

```
Agent receives task
  → plan_write (create plan with pending items)
  → work on items, updating status as it goes
  → plan_write (close plan with all items completed)
  → deliver final result
```

### System Prompt Injection

Every turn, `before_prompt_build` injects context based on plan state:

| State | Injection | Purpose |
|-------|-----------|---------|
| No plan | `<plan_available>` | Nudge agent to create a plan for multi-step work |
| Just updated (idle < 3) | Sparse reminder | Save tokens — agent already has full context |
| Normal (idle 3–7) | Full reminder | Show current plan status with all items |
| Stale (idle ≥ 8) | Full + warning | Prompt agent to update the plan |

### Channel Notifications

When the agent calls `plan_write`, progress is pushed to the user's channel:

- **Feishu** — interactive Card 2.0 with stacked bar chart progress, live-updated via PATCH
- **Telegram** — plain-text message with Unicode progress bar, live-updated via editMessage
- **Other channels** — plan still works for agent self-tracking; no push notification

### Confirmation Interception

The `message_sending` hook detects short confirmation-request messages (e.g., "shall I proceed?", "是否继续?") and suppresses them when an active plan exists. Conservative matching — would rather miss than false-positive.

## Plan Statuses

| Status | Text Symbol | Card Symbol | Card Color |
|--------|-------------|-------------|------------|
| pending | ○ | ○ | default |
| in_progress | ◉ | ◉ **bold** | orange |
| completed | ● | ● ~~strikethrough~~ | grey |
| cancelled | ✕ | ✕ ~~strikethrough~~ | dark yellow |
| failed | ✗ | ✗ **bold** | red |

## Installation

Add to your `openclaw.json`:

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

Restart the gateway to load the plugin.

### Feishu Setup (optional)

To enable Feishu card notifications, configure credentials in `openclaw.json`:

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

Per-agent accounts are supported via `channels.feishu.accounts.{agentAccountId}`.

### Telegram Setup (optional)

To enable Telegram message notifications:

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456:ABC-DEF..."
    }
  }
}
```

Per-agent accounts are supported via `channels.telegram.accounts.{agentAccountId}.botToken`.

## File Structure

```
src/
├── index.ts              # Plugin entry — registers tool + 4 hooks
├── types.ts              # Core types: PlanFile, PlanItem, PlanStatus
├── plan-tool.ts          # plan_write tool schema and description
├── plan-state.ts         # Disk I/O: atomic read/write of .plan.json files
├── plan-injection.ts     # System prompt text + Feishu card + plain-text rendering
├── runtime-state.ts      # In-memory session state: idle counters, active-plan flags
├── feishu-client.ts      # Feishu REST client (send/update cards, token cache)
└── telegram-client.ts    # Telegram Bot API client (send/edit messages)
```

Plan files are stored per-agent, per-session:

```
~/.openclaw/agents/{agentId}/plans/{hash}.plan.json
```

## Known Limitations

- **Orphan cards on title change** — when an agent changes the plan title, a new card is sent but the old one is not deleted
- **Telegram plain text only** — messages do not use `parse_mode`, so Markdown formatting is not rendered
- **Subagent poke uses private API** — `enqueueSystemEvent` is not part of the formal Plugin SDK; may break on OpenClaw upgrades
- **No cross-session plan sharing** — each session has its own plan; sub-agents cannot update the parent's plan directly

## Requirements

- OpenClaw >= 2026.2.0
- Node.js >= 18 (for native `fetch`)

## License

MIT
