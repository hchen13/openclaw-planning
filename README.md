[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning Plugin

<p align="center">
  <img src="assets/demo.gif" alt="Planning Plugin Demo — Feishu" />
  <img src="assets/demo-telegram.gif" alt="Planning Plugin Demo — Telegram" />
</p>

**The problem:** When an AI agent runs a 20-step task on a messaging platform, the user stares at a blank chat for minutes. There's no progress bar, no status update, no way to know if the agent is stuck or just thinking. When the agent spawns sub-agents, it gets worse — the user has zero visibility into what might be a 10-minute background operation. And if context gets compacted mid-task, the agent forgets what it was doing.

**This plugin fixes that.** It gives agents a `plan_write` tool to create structured task plans. Each plan becomes a live-updating progress card in Feishu or Telegram. The plan is injected into the system prompt every turn, so the agent stays on track even through compaction. Sub-agents automatically update the parent's plan. Users can cancel cleanly because the plan is always visible.

## What It Looks Like

When an agent creates a plan, a Feishu card appears in the user's chat:

```
🗂 Fix market-watch monitoring system
████████░░░░░░░░ 2/4 (50%)

● [done] Diagnose price-monitor crash root cause
● [done] Fix code and verify stable operation
◉ [active] Confirm XAUT price watch resumed — running verification
○ Confirm Iran news watch resumed
```

The card updates in real-time as the agent progresses. One card per plan, PATCHed in place — no message spam.

## Core Capabilities

- **`plan_write` tool** — agents create and update task plans with status tracking (pending → in_progress → completed/cancelled/failed)
- **Multiple concurrent plans** — unrelated tasks arriving mid-work get separate plans with separate cards
- **Subagent plan delegation** — sub-agents automatically update the parent's plan and card, not their own
- **Spawn gating** — `sessions_spawn` is blocked until a plan exists, ensuring user visibility before long background operations
- **System prompt injection** — active plans are injected every turn (adaptive: sparse when just updated, full when stale)
- **Conversation-aware routing** — cards go to the correct chat (group or DM), not always the requester's DM
- **Confirmation interception** — suppresses "shall I proceed?" when the agent has a plan and should just execute
- **Promise-only turn guard** — in guarded modes, suppresses short task chatter that only states future intent without asking a real blocker question or starting work
- **Cancellation support** — agents mark remaining items as `cancelled` when the user stops a task

## How It Works

### Plan Lifecycle

```
Agent receives task
  → plan_write (create plan — all items pending)
  → work through items, updating status as it goes
  → plan_write (close plan — all items completed)
  → deliver final result
```

### Subagent Delegation

When an agent spawns a sub-agent:

```
Agent creates plan → spawns sub-agent
  → plugin links child session to parent's plan directory
  → sub-agent's plan_write updates parent's plan file
  → same Feishu/Telegram card gets PATCHed
  → parent resumes and can continue updating the same plan
```

The agent MUST create a plan before spawning — `sessions_spawn` is blocked otherwise. This ensures the user always sees what's happening, and cancellation works cleanly.

### System Prompt Injection

Every turn, the plugin injects plan context based on recency:

| State | Injection | Purpose |
|-------|-----------|---------|
| No plan | `<plan_available>` | Nudge to create a plan for multi-step work |
| Just updated (idle < 3 turns) | Sparse reminder | Save tokens — agent already has context |
| Normal (idle 3–7) | Full plan state | Re-anchor the agent on current progress |
| Stale (idle ≥ 8) | Full + warning | Prompt agent to update before it drifts |

### Channel Notifications

Progress cards are sent to the conversation where the request originated:

- **Feishu** — Card 2.0 with stacked bar chart progress, live-updated via PATCH
- **Telegram** — plain-text with Unicode progress bar, live-updated via editMessage
- **Other channels** — plan still works for agent self-tracking; no push notification

## Notes for AI Agents

If you're an AI agent with `plan_write` available, here's what you need to know:

**When to create a plan:**
- Any task with 3+ distinct steps — even purely linear ones (read → analyze → write). A plan keeps you anchored through context compaction and shows the user you're making progress.
- ALWAYS before spawning sub-agents. The spawn will be **blocked** if you don't have a plan. Break down the full task first, then spawn.

**When NOT to create a plan:**
- Quick answers, single lookups, tasks completable in 1-3 tool calls.

**How to use plan_write effectively:**
- Create the plan at the START, before doing any work.
- 3-10 items is the sweet spot. Each item should be a milestone the user would recognize — something they can look at and think "good, it's making progress."
- Write items from the user's perspective, not yours. Describe what each step achieves, not how you'll implement it internally. "Collect crypto market news" is good; "spawn sub-agent: collect info" is bad — the user doesn't know what spawning means and shouldn't need to.
- A single-item plan defeats the purpose. If the progress bar jumps from 0% to 100% with nothing in between, the user gets zero visibility into what's happening.
- Mark one item `in_progress` at a time. Move to `completed` when done.
- Pass the COMPLETE items array every time — it's a full replacement, not a diff.
- Use the `message` field for status notes ("Found 3 issues, fixing now").

**Multiple plans:**
- Each plan is identified by its title. Use the EXACT same title to update an existing plan.
- If an unrelated task arrives mid-work, create a new plan with a different title.

**Cancellation:**
- When the user says to stop or cancel, call `plan_write` immediately: mark remaining pending/in_progress items as `cancelled`, set the `message` field to explain why.
- Never leave a plan in a stale state with items still `in_progress`.

**Autonomous execution:**
- Once the plan is written, execute it without asking for confirmation at each step.
- Only pause for genuinely unexpected blockers that require a real decision.
- Ask all clarifying questions BEFORE creating the plan, not during execution.

## Plan Statuses

| Status | Text | Card | Color |
|--------|------|------|-------|
| pending | ○ | ○ | default |
| in_progress | ◉ | ◉ **bold** | orange |
| completed | ● | ● ~~strike~~ | grey |
| cancelled | ✕ | ✕ ~~strike~~ | dark yellow |
| failed | ✗ | ✗ **bold** | red |

## Installation

Add to `openclaw.json`:

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

Restart the gateway to load.

### Feishu Setup (optional)

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

Per-agent accounts supported via `channels.feishu.accounts.{agentAccountId}`.

### Telegram Setup (optional)

```json
{
  "channels": {
    "telegram": {
      "botToken": "123456:ABC-DEF..."
    }
  }
}
```

Per-agent accounts supported via `channels.telegram.accounts.{agentAccountId}.botToken`.

## Architecture

```
src/
├── index.ts              # Plugin entry — registers tool + 8 hooks
├── types.ts              # Core types: PlanFile, PlanItem, PlanStatus
├── plan-tool.ts          # plan_write tool schema and description
├── plan-state.ts         # Disk I/O: atomic read/write of .plan.json files
├── plan-injection.ts     # System prompt text + Feishu card + plain-text rendering
├── runtime-state.ts      # In-memory session state: idle counters, delegation, conversation tracking
├── feishu-client.ts      # Feishu REST client (send/update cards, token cache)
└── telegram-client.ts    # Telegram Bot API client (send/edit messages)
```

Plan files are stored per-agent, per-session, per-plan:

```
~/.openclaw/agents/{agentId}/plans/{sessionHash}/{titleHash}.plan.json
```

## Known Limitations

- **Telegram plain text only** — no `parse_mode`, so Markdown symbols render as-is
- **Delegation requires same agentDir** — subagent plan delegation only works when parent and child share the same agent directory
- **Subagent poke uses private API** — `enqueueSystemEvent` is not part of the formal Plugin SDK; may break on upgrades
- **Promise-only recovery is best-effort** — when guarded modes suppress a promise-only update, the plugin can repoke the same session once, but that path also depends on the same private runtime API
- **ConversationId fallback** — card routing to group chats depends on `conversationId` in the `message_received` hook; falls back to requester DM if unavailable

## Requirements

- OpenClaw >= 2026.2.0
- Node.js >= 18 (for native `fetch`)

## License

MIT
