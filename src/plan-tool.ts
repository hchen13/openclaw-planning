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

export const PLAN_WRITE_DESCRIPTION = `Write or update the current task plan. Creates a structured, user-visible progress card for tracking work that warrants one.

A plan is expensive: it creates a progress card in the user's chat, triggers a confirmation round, enters coordinator mode (main agent can only plan/spawn/read/communicate), and adds context overhead every turn. It earns that cost only when the task actually needs it.

When TO use — create a plan if EITHER applies:

1. **User visibility**: The user would wait long enough without feedback that they'd start wondering what you're doing. Investigations, multi-phase builds, long-running work, anything where the user would naturally expect a status window. The plan is their view into progress.

2. **Agent context pressure**: The task involves enough heavy tool output (many file reads, large fetches, deep exploration, parallel branches) that doing it all in one context would crowd out your working memory or risk compaction loss. A plan lets you delegate items to subagents, which keeps their tool outputs isolated from your main context.

If neither is true, DO NOT call plan_write.

When NOT to use — just reply or act directly for any of these:

- **Direct questions**: "what's in this file", "when did X happen", "does function Y exist", "is this configured correctly" — answerable with a handful of tool calls and a reply. The user is waiting for an answer, not a deliverable.
- **Single-edit changes**: rename a variable, add one line, fix a typo, adjust one config value.
- **Quick status checks**: peek at a log, check a service, read a file, look up a fact.
- **Casual conversation & clarifications**: greetings, acknowledgments, short back-and-forth, "yes do that", "no the other one".
- **Anything finishable this turn**: if you can reasonably imagine ending this turn with a direct reply (even one that includes 3-5 tool calls), skip the plan. A plan that opens and closes in the same turn is pure overhead — the user sees a card flash by for a 5-second answer, and you've spent confirmation-gate and coordinator-mode cost for nothing.

Rule of thumb — ask yourself: "Would the user expect a progress card to appear for this request, or are they waiting for a direct reply?" If the answer is "direct reply", do not plan.

Note: sessions_spawn is BLOCKED without a plan — but this is because spawning is itself a heavy mechanism, not because planning is the default. If you don't need to spawn, you probably don't need a plan.

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
- For each item: set it to in_progress via plan_write, then spawn a sub-agent (sessions_spawn) to execute it. Write a detailed task prompt for the sub-agent — it has no conversation history, so include all necessary context, file paths, and success criteria.
- Spawn multiple items in parallel when they have no dependencies between them. Set all of them to in_progress in one plan_write call, then spawn them all in the same turn.
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

Dependencies:
- Declare dependencies with \`blockedBy\` — use 0-based array indices (e.g. \`blockedBy: [0, 1]\` means "wait for the 1st and 2nd items") or item IDs if you provided them explicitly.
- Items without blockers can be spawned immediately and in parallel.
- When a sub-agent completes, the item is automatically marked completed and you will be prompted to dispatch newly unblocked items.`;
