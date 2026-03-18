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
  id: Type.String({ description: "Unique item ID (e.g. t1, t2, t3)" }),
  content: Type.String({ description: "Task description in imperative form, ≤80 chars", maxLength: 200 }),
  status: PlanStatusEnum,
  activeForm: Type.Optional(
    Type.String({ description: "Present-tense description shown when in_progress, ≤60 chars", maxLength: 120 }),
  ),
});

export const PlanWriteSchema = Type.Object({
  title: Type.String({ description: "Overall task title, ≤50 chars", maxLength: 100 }),
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
- ALWAYS before spawning sub-agents — the user has zero visibility during a spawn. Write the full plan first (all phases of the task), then spawn. The sub-agent may complete every item, but the user needs to see the plan before the wait begins

When NOT to use:
- Tasks completable in 1-3 tool calls
- Quick questions or casual conversation

Before creating the plan:
- If the task has ambiguities that would block execution, ask ALL clarifying questions upfront in a single message — do this BEFORE writing the plan
- Once the plan is written, commit to executing it autonomously: do not stop mid-task to ask "shall I proceed?" or "is this okay?" — that is unnecessary and disruptive
- Pause mid-execution ONLY for genuinely unexpected blockers that require a real decision (e.g. two fundamentally different approaches with no clear default, or a destructive action not covered by the original request). Everything else: make a reasonable assumption, note it in the \`message\` field, and keep going

Best practices:
- Create a plan at the START of complex work, before doing anything else
- 3-10 items is a good range — keep them high-level, not step-by-step instructions
- Update status as you complete each step (mark in_progress → completed)
- Only one item should be in_progress at a time
- Pass the COMPLETE items array every time (full replacement, not incremental)
- If you change item content or add/remove items (not just status), explain why in the \`message\` field
- When ALL items are done, call plan_write one final time with all items marked completed to close the plan — then send your normal reply with the actual results

Clearing a plan:
- Pass an empty items array to clear the current plan
- Changing the title starts a fresh plan (new card, new tracking)`;
