/**
 * Planning Plugin - plan_write Tool Definition
 */

import { Type, type TSchema } from "@sinclair/typebox";

export const PlanStatusEnum = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);

export const PlanItemSchema = Type.Object({
  id: Type.Optional(
    Type.String({
      description:
        "Item ID. Auto-assigned by the plugin if omitted (recommended). " +
        "When provided, used as-is. Existing items keep their IDs across updates.",
    }),
  ),
  content: Type.String({ description: "Task description in imperative form, ≤80 chars", maxLength: 80 }),
  status: PlanStatusEnum,
  activeForm: Type.Optional(
    Type.String({ description: "Present-tense description shown when in_progress, ≤60 chars", maxLength: 60 }),
  ),
  blockedBy: Type.Optional(
    Type.Array(Type.Union([Type.String(), Type.Number()]), {
      description:
        "Dependencies: IDs of items that must complete before this one starts. " +
        "Use item IDs (strings) or 0-based array indices (numbers) to reference items in the same plan_write call. " +
        "Indices are resolved to IDs after auto-assignment.",
    }),
  ),
  agentTask: Type.Optional(
    Type.String({
      description:
        "Self-contained prompt for a subagent to execute this item. Include ALL context the subagent needs — it cannot see conversation history. " +
        "When provided, the plugin enters orchestrated execution: it tracks subagent↔item mapping, auto-updates item status on completion, and prompts you to dispatch newly unblocked items. " +
        "Each agentTask should be completable in under 2 minutes by a focused subagent.",
    }),
  ),
});

export const PlanWriteSchema = Type.Object({
  title: Type.String({ description: "Overall task title, ≤50 chars", maxLength: 50 }),
  items: Type.Array(PlanItemSchema, {
    description: "Complete list of plan items. This is a full replacement — pass ALL items every time.",
    maxItems: 20,
  }),
  message: Type.Optional(
    Type.String({ description: "Optional status message shown at the bottom of the progress card" }),
  ),
});

export const PLAN_WRITE_DESCRIPTION = `Write or update the current task plan. Creates a structured plan for tracking multi-step work.

When to use:
- Any multi-step task, including purely linear flows (read → analyze → output) — a plan keeps you on track through compaction and gives the user real-time visibility. Don't skip it because a task feels simple.
- Tasks with ≥3 distinct phases or branching decisions
- ALWAYS before spawning sub-agents (sessions_spawn will be BLOCKED if no plan exists). Write the full plan first — break the task into items covering all phases, then spawn. For non-orchestrated spawns, the sub-agent will see and update your plan automatically via delegation. For orchestrated items (with agentTask), the plugin manages status updates — the sub-agent focuses solely on its task

When NOT to use:
- Tasks completable in 1-3 tool calls
- Quick questions or casual conversation

Before creating the plan:
- If the task has ambiguities that would block execution, ask ALL clarifying questions upfront in a single message — do this BEFORE writing the plan
- Once the plan is written, commit to executing it autonomously: do not stop mid-task to ask "shall I proceed?" or "is this okay?" — that is unnecessary and disruptive
- Pause mid-execution ONLY for genuinely unexpected blockers that require a real decision (e.g. two fundamentally different approaches with no clear default, or a destructive action not covered by the original request). Everything else: make a reasonable assumption, note it in the \`message\` field, and keep going

Writing good items:
- The plan is shown directly to the user as a progress card in their chat. Write every item as something the user would recognize as a meaningful step toward their goal. Think "what would a project manager show the client?" not "what are my internal implementation steps?"
- A single-item plan defeats the purpose — if the progress bar jumps from 0% to 100% with nothing in between, the user gets no visibility. Break work into the natural phases they'd expect.
- Avoid exposing implementation mechanics like "spawn sub-agent", "call API", "parse JSON". Describe what each step achieves for the user, not how you achieve it internally.
- 3-10 items is a good range. Each item should represent a milestone the user can look at and think "good, it's making progress" — not a line in a script.
- Good: "Weekly report" → Gather data from sources → Analyze trends → Draft report → Format and send
- Bad: "Weekly report" → Gather data, analyze, write, and send report (one giant item — user sees 0% then 100%)

Best practices:
- Create a plan at the START of complex work, before doing anything else
- Update status as you complete each step (mark in_progress → completed)
- Only one item should be in_progress at a time (unless using orchestrated execution with parallel subagents)
- Item IDs are auto-assigned — you can omit the \`id\` field. On updates, items are matched by content to preserve their IDs. You can also provide explicit IDs if you prefer.
- For \`blockedBy\`, use either item IDs (strings) or 0-based array indices (numbers) to reference other items in the same call. Indices are resolved to IDs automatically.
- Pass the COMPLETE items array every time (full replacement, not incremental)
- If you change item content or add/remove items (not just status), explain why in the \`message\` field
- When ALL items are done, call plan_write one final time with all items marked completed to close the plan — then send your normal reply with the actual results
- When the user cancels a task or tells you to stop, call plan_write immediately: mark remaining pending/in_progress items as "cancelled" and set the \`message\` field to explain why (e.g. "Cancelled by user"). Do NOT leave a plan in a stale state

Multiple concurrent plans:
- Each plan is identified by its title — use the EXACT same title to update an existing plan
- To track a new unrelated task arriving mid-work, call plan_write with a different title
- Each plan gets its own progress card/message in the user's channel
- The system prompt will show all active plans; update each by passing its exact title

Clearing a plan:
- Pass an empty items array with the plan's title to clear that specific plan

Orchestrated execution (subagent-per-item):
- For items that should be executed by subagents, provide an \`agentTask\` field with a self-contained prompt. The subagent has no conversation history — include ALL necessary context: file paths, expected formats, success criteria.
- Declare dependencies with \`blockedBy\` — use 0-based array indices (e.g. \`blockedBy: [0, 1]\` means "wait for the 1st and 2nd items") or item IDs if you provided them explicitly.
- Items without \`agentTask\` are executed by you directly.
- Each agentTask should be completable in under 2 minutes by a focused subagent. If a step would take longer, split it into smaller items.
- Write agentTask like a briefing for a colleague who just joined: goal, context, specific actions, success criteria.
- After creating the plan, dispatch subagents for all unblocked items. Use sessions_spawn with \`label\` set to the item ID (shown in the orchestration_directive) so the system can track which subagent handles which item.
- Spawn multiple unblocked items in a single turn for parallel execution.
- When a subagent completes, the item is automatically marked completed and you will be prompted to dispatch newly unblocked items.`;
