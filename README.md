[English](README.md) | [中文](README.zh-CN.md)

# OpenClaw Planning Plugin

<p align="center">
  <img src="assets/demo.gif" alt="Planning Plugin Demo — Feishu" />
  <img src="assets/demo-telegram.gif" alt="Planning Plugin Demo — Telegram" />
</p>

**The problems:**

1. **No visibility.** When an AI agent runs a 20-step task on a messaging platform, the user stares at a blank chat for minutes. There's no progress bar, no status update, no way to know if the agent is stuck or just thinking. When the agent spawns sub-agents, it gets worse — zero visibility into what might be a 10-minute background operation. And if context gets compacted mid-task, the agent forgets what it was doing.

2. **Agents say they'll do it, but don't.** You ask an agent to do something. It replies "收到" or "got it, I'll handle it." Then nothing happens. There is no mechanism ensuring follow-through once the turn ends — the commitment exists only as text in a chat, not as a tracked action.

**This plugin fixes both.** It gives agents a `plan_write` tool to create structured task plans with live-updating progress cards. Plans are injected into the system prompt every turn, keeping agents on track through compaction. Follow-through behavioral rules are injected into every agent's system prompt, driving agents to act on requests immediately rather than acknowledge and forget. A promise-only turn guard detects empty commitments and forces agents to take concrete action.

## What It Looks Like

When an agent creates a plan, a Feishu card appears in the user's chat:

```
🗂 Fix market-watch monitoring system
████████░░░░░░░░ 2/4 (50%)

● [done] Diagnose price-monitor crash root cause
● [done] Fix code and verify stable operation
◉ [active] Confirm XAUT price watch resumed — running verification
   正在 读文件  已执行 8 步                耗时 1.4m
○ Confirm Iran news watch resumed
```

In-progress items show a live sub-line underneath the title — current tool activity, block count, and elapsed time, refreshed every second. One card per plan, PATCHed in place — no message spam.

## Core Capabilities

- **`plan_write` tool** — agents create and update task plans with status tracking (pending → in_progress → completed/cancelled/failed)
- **Live subagent metrics** — while an item is in progress, its card shows real-time elapsed time, tool block count, and current tool activity (e.g. "正在 读文件 · 已执行 8 步 · 耗时 1.4m"). The card refreshes every second via Feishu PATCH
- **Coordinator mode** — when a plan is active, the main agent is restricted to plan/spawn/read/communicate tools. Real work must flow through subagents, guaranteeing every item runs under an isolated subagent with live metrics
- **Orchestrated execution** — plan items are dispatched to individual subagents with dependency tracking, parallel execution for independent items, and automatic progress updates
- **Auto-binding** — spawned subagents auto-bind to plan items via an activation queue with plan-order fallback, removing the need for the agent to supply explicit item labels
- **Dependency management** — items declare dependencies via `blockedBy`; the plugin validates the dependency graph and coordinates dispatch order
- **Multiple concurrent plans** — unrelated tasks arriving mid-work get separate plans with separate cards, each orchestrated independently
- **Subagent plan delegation** — for non-orchestrated items, sub-agents automatically update the parent's plan and card
- **Plan confirmation gate** — the first `plan_write` for a new plan title is blocked once, forcing the agent to do a Socratic clarification round with the user before committing to scope
- **Spawn gating** — `sessions_spawn` is blocked until a plan exists, ensuring user visibility before long background operations
- **System prompt injection** — active plans and follow-through behavioral rules are injected every turn (adaptive: sparse when just updated, full when stale)
- **Conversation-aware routing** — cards go to the correct chat (group or DM), not always the requester's DM
- **Confirmation interception** — suppresses "shall I proceed?" when the agent has a plan and should just execute
- **Promise-only turn guard** — detects and handles messages that only state future intent without action
- **Plan lifecycle guards** — plan-abandonment strike counter, completed-but-not-closed nudge, and forward-progress acceptance for plugin-managed item statuses
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

### Subagent Delegation (Manual Mode)

When an agent spawns a sub-agent without orchestration:

```
Agent creates plan → spawns sub-agent
  → plugin links child session to parent's plan directory
  → sub-agent's plan_write updates parent's plan file
  → same Feishu/Telegram card gets PATCHed
  → parent resumes and can continue updating the same plan
```

### Orchestrated Execution

In coordinator mode, the main agent delegates all execution to subagents. The plugin ties each spawn to a plan item and auto-updates statuses:

```
Agent creates plan → marks item(s) in_progress
  → plugin injects <orchestration_directive> showing ready items
  → agent spawns subagents (labels optional — auto-binding handles it)
  → plugin binds each spawn to the next pending item via an activation
    queue, with fallback to plan order
  → each subagent runs with live metrics flowing to the card
  → subagent completes → plugin auto-marks the item completed
  → plugin checks for newly unblocked items → re-injects the directive
  → agent dispatches the next batch (parallel if independent)
  → all items done → agent closes the plan and replies
```

Key behaviors:
- Main agent in coordinator mode can only plan/spawn/read/communicate — real work is always in subagents
- Independent items run in parallel (agent spawns multiple subagents in one turn)
- Dependencies are enforced via `blockedBy`; unresolved items cannot be dispatched
- Failed dependencies trigger deadlock detection with explicit decision prompts
- Subagents do NOT call `plan_write` themselves — the coordinator manages all plan state

The agent MUST create a plan before spawning — `sessions_spawn` is blocked otherwise.

### System Prompt Injection

Every turn, the plugin injects plan context based on recency:

| State | Injection | Purpose |
|-------|-----------|---------|
| No plan | `<plan_available>` | Show the criteria for when a plan is warranted (user visibility vs. agent context pressure) |
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

**When to create a plan (create if EITHER applies):**
- **User visibility**: the user would wait long enough without feedback that they'd start wondering what you're doing. Multi-phase work, investigations, long-running tasks — anything where a progress card in their chat would answer "what's happening right now?"
- **Agent context pressure**: the task involves enough heavy tool output (big file reads, many fetches, deep exploration) that delegating items to subagents is meaningfully valuable to keep your main context clean

Plans also gate `sessions_spawn` — you cannot spawn subagents without a plan. By design: if you need to spawn, you probably need a plan.

**When NOT to create a plan:**
- Direct questions answerable with a single lookup or a handful of tool calls
- Single-edit changes (rename a variable, fix a typo, add one line)
- Quick status checks, file peeks, config reads
- Short casual exchanges and clarifications
- Anything you can reasonably finish this turn with a direct reply

Rule of thumb: ask yourself "would the user expect a progress card for this request, or are they waiting for a direct reply?" If the answer is "direct reply", do not plan. A plan that opens and closes in the same turn is pure overhead — card, confirmation gate, coordinator mode, all for a 5-second answer.

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
├── index.ts              # Plugin entry — registers tool + 9 hooks
├── types.ts              # Core types: PlanFile, PlanItem, PlanStatus
├── plan-tool.ts          # plan_write tool schema and description
├── plan-state.ts         # Disk I/O: atomic read/write, DAG validation
├── plan-injection.ts     # Prompt injection (plan reminders, orchestration directive, follow-through rules, card rendering)
├── runtime-state.ts      # In-memory session state: turns, idle counters, delegation, orchestration bindings, managed statuses
├── live-metrics.ts       # Per-subagent live metrics (elapsed, tool count, current activity) + 1s card refresh loop
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
- **Gateway restart during orchestration** — if the gateway restarts while orchestrated subagents are running, progress tracking may be lost; items may need to be re-dispatched manually

## Requirements

- OpenClaw >= 2026.2.0
- Node.js >= 18 (for native `fetch`)

## License

MIT
