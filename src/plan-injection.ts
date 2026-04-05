/**
 * Planning Plugin - System Prompt Injection & Card Rendering
 */

import type { PlanFile, PlanItem, PlanStatus } from "./types.js";
import type { LiveItemMetrics } from "./live-metrics.js";

// ─── Status Visual Config ────────────────────────────────────────────────────

const STATUS_SYMBOL: Record<PlanStatus, string> = {
  completed: "●",
  in_progress: "◉",
  pending: "○",
  cancelled: "✕",
  failed: "✗",
};

// ─── System Prompt (plain text, no HTML) ─────────────────────────────────────

function formatItemText(item: { content: string; status: PlanStatus; activeForm?: string }): string {
  const sym = STATUS_SYMBOL[item.status];
  switch (item.status) {
    case "completed":
      return `${sym} [done] ${item.content}`;
    case "in_progress": {
      const suffix = item.activeForm ? ` — ${item.activeForm}` : "";
      return `${sym} [active] ${item.content}${suffix}`;
    }
    case "cancelled":
      return `${sym} [cancelled] ${item.content}`;
    case "failed":
      return `${sym} [failed] ${item.content}`;
    default:
      return `${sym} ${item.content}`;
  }
}

function textProgressBar(completed: number, total: number): string {
  const BAR = 8;
  const filled = total > 0 ? Math.round((completed / total) * BAR) : 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return `${"█".repeat(filled)}${"░".repeat(BAR - filled)} ${completed}/${total} (${pct}%)`;
}

function buildSinglePlanSection(plan: PlanFile): string {
  const total = plan.items.length;
  const completed = plan.items.filter((i) => i.status === "completed").length;
  const inProgress = plan.items.filter((i) => i.status === "in_progress");
  const itemLines = plan.items.map(formatItemText).join("\n");

  const noInProgressWarning =
    plan.items.some((i) => i.status === "pending") && inProgress.length === 0
      ? "\n⚠️ No task is currently in_progress. Mark the active task in_progress before proceeding."
      : "";

  return `── ${plan.title} ──\n${itemLines}\nProgress: ${textProgressBar(completed, total)}${noInProgressWarning}`;
}

/**
 * Build full <plan_reminder> for injection when active plans exist.
 * Optionally appends a stale-plan warning when idleCount is high.
 */
export function buildPlanReminder(plans: PlanFile[], stale = false): string {
  const planCount = plans.length;
  const sections = plans.map(buildSinglePlanSection).join("\n\n");

  const header = planCount === 1
    ? `Current plan: ${plans[0].title}`
    : `You have ${planCount} active plans. Update each by passing its exact title to plan_write.`;

  const staleWarning = stale
    ? "\n⚠️ plan_write hasn't been called in a while. Update task statuses now."
    : "";

  // Single plan reuses buildSinglePlanSection to avoid logic duplication
  const body = planCount === 1
    ? `\n${buildSinglePlanSection(plans[0])}`
    : `\n\n${sections}`;

  return `<plan_reminder>
${header}${body}${staleWarning}
For each pending item: set it to in_progress via plan_write, then spawn a sub-agent (sessions_spawn) to execute it. You coordinate; sub-agents do the work. Spawn multiple items in parallel when they have no dependencies.
Execute autonomously — do not stop to ask "shall I proceed?" or "is this okay?". Only pause for genuinely unexpected blockers requiring a real decision.
</plan_reminder>`;
}

/**
 * Build sparse <plan_reminder> — used when plan was just updated (low idle count).
 * Saves tokens; model already has full context from the recent plan_write call.
 */
export function buildPlanReminderSparse(plans: PlanFile[]): string {
  const summaries = plans.map((plan) => {
    const total = plan.items.length;
    const completed = plan.items.filter((i) => i.status === "completed").length;
    const active = plan.items.find((i) => i.status === "in_progress");
    const activeSuffix = active
      ? ` · now: ${active.activeForm ?? active.content}`
      : " · no task in_progress";
    return `"${plan.title}" (${completed}/${total} done)${activeSuffix}`;
  });

  const hint = plans.length > 1
    ? " Pass the plan's exact title to update the right plan."
    : "";

  return `<plan_reminder>
${plans.length === 1 ? "Plan" : "Plans"}: ${summaries.join(" | ")}
Use plan_write to update status as you work.${hint}
</plan_reminder>`;
}

/**
 * Build <plan_available> for injection when no plan exists.
 */
export function buildPlanAvailable(): string {
  return `<plan_available>
plan_write is available for work that genuinely benefits from a tracked, user-visible progress card.

Create a plan when EITHER is true:
- The user would wait long enough without visibility that they'd start wondering what you're doing (investigations, multi-phase builds, long-running work). A plan is their status window.
- The work involves enough heavy tool output (big file reads, many fetches, deep exploration) that it should be delegated to subagents to keep your main context clean. A plan is the coordination structure.

Do NOT create a plan for these — just reply or act directly:
- Direct questions answerable from a single lookup or a handful of tool calls
- Single-edit changes (rename, add a line, fix a typo)
- Quick status checks, file peeks, config reads
- Short casual exchanges, acknowledgments, clarifications
- Anything where the user is waiting for an answer, not a deliverable

Rule of thumb: if you can reasonably finish this turn with a direct reply, DO NOT call plan_write. A plan that closes in the same turn it was opened is pure noise for the user — a card, a confirmation round, coordinator overhead, all for a 5-second answer.

Multiple concurrent plans are supported — use different titles for unrelated long-running tasks arriving mid-work.
</plan_available>`;
}

/**
 * Build <plan_reminder> for delegated subagents — tells the subagent to update
 * the parent's plan rather than creating its own.
 */
export function buildDelegatedPlanReminder(plans: PlanFile[], stale = false): string {
  const sections = plans.map(buildSinglePlanSection).join("\n\n");

  const staleWarning = stale
    ? "\n⚠️ plan_write hasn't been called in a while. Update task statuses now."
    : "";

  return `<plan_reminder>
You are a sub-agent executing a specific task from the parent's plan. Do NOT call plan_write — the coordinator manages all plan updates. Focus on completing your assigned task.

${sections}
Execute autonomously — do not stop to ask "shall I proceed?".
</plan_reminder>`;
}

// ─── Static Follow-Through Rules (injected into system prompt via appendSystemContext) ──

export const FOLLOW_THROUGH_RULES = `<planning_rules>
You are an agent that acts, not one that acknowledges. When a user asks you to do something, do it — don't say you will. For simple requests (a lookup, a single edit, a direct question), reply with the answer in this turn. For genuinely multi-phase work the user would want to track, create a plan first (see plan_write criteria). If you cannot act because the request is ambiguous or you lack a capability, say so plainly instead of promising.

Every commitment you make must be backed by either a tool call or (for multi-phase work) a plan_write item in the same turn. A response that contains a commitment but no action — "收到，我去改" / "got it, I'll handle it" / "放心，记着呢" — is not acceptable, because there's nothing ensuring follow-through once this turn ends. Either act now, or create a tracked item.

When you have a plan, execute items by spawning sub-agents (sessions_spawn). Set the item to in_progress, then immediately spawn. Multiple independent items should spawn in parallel in the same turn. The coordinator pattern (plan + spawn) is for work that warrants it — do not put trivial single-step actions into a plan just to have one.

When you claim completion, ground it: what did you change, what command did you run, what output did you see. Never characterize unverified or incomplete work as done.
</planning_rules>`;

/**
 * Check if a plan has any active (non-terminal) items.
 */
export function isPlanActive(plan: PlanFile): boolean {
  return plan.items.some((i) => i.status === "pending" || i.status === "in_progress");
}

/**
 * Check if a plan has any orchestrated items (items with agentTask).
 */
export function hasOrchestratedItems(plan: PlanFile): boolean {
  return plan.items.some((i) => i.agentTask);
}

/**
 * Build <orchestration_directive> for injection when plans have orchestrated items
 * that are ready for dispatch or awaiting results.
 *
 * Returns null if no orchestrated items need attention.
 */
export function buildOrchestrationDirective(plans: PlanFile[]): string | null {
  const readyItems: Array<{ planTitle: string; id: string; content: string }> = [];
  const blockedItems: Array<{ planTitle: string; id: string; content: string; waitingOn: string[] }> = [];
  const deadlockedItems: Array<{ planTitle: string; id: string; content: string; failedDeps: string[] }> = [];
  const runningItems: Array<{ planTitle: string; id: string; content: string }> = [];
  const completedItems: Array<{ planTitle: string; id: string; content: string }> = [];

  for (const plan of plans) {
    if (!hasOrchestratedItems(plan)) continue;

    const completedIds = new Set(
      plan.items.filter((i) => i.status === "completed").map((i) => i.id),
    );
    const terminalFailedIds = new Set(
      plan.items.filter((i) => i.status === "failed" || i.status === "cancelled").map((i) => i.id),
    );

    for (const item of plan.items) {
      if (!item.agentTask) continue; // Not orchestrated

      if (item.status === "completed" || item.status === "cancelled" || item.status === "failed") {
        completedItems.push({ planTitle: plan.title, id: item.id, content: item.content });
        continue;
      }

      if (item.status === "in_progress") {
        runningItems.push({ planTitle: plan.title, id: item.id, content: item.content });
        continue;
      }

      // pending — check if all blockers are resolved
      const unresolvedBlockers = (item.blockedBy ?? []).filter((dep) => !completedIds.has(dep));
      if (unresolvedBlockers.length === 0) {
        readyItems.push({ planTitle: plan.title, id: item.id, content: item.content });
      } else {
        // Check if any unresolved blocker is in a terminal failed state (deadlock)
        const failedDeps = unresolvedBlockers.filter((dep) => terminalFailedIds.has(dep));
        if (failedDeps.length > 0) {
          deadlockedItems.push({ planTitle: plan.title, id: item.id, content: item.content, failedDeps });
        } else {
          blockedItems.push({ planTitle: plan.title, id: item.id, content: item.content, waitingOn: unresolvedBlockers });
        }
      }
    }
  }

  // Nothing to orchestrate
  if (readyItems.length === 0 && runningItems.length === 0 && blockedItems.length === 0 && deadlockedItems.length === 0) return null;

  // When multiple plans have orchestrated items, use "planTitle:itemId" labels to disambiguate
  const orchestratedPlanCount = plans.filter(hasOrchestratedItems).length;
  const needsQualifiedLabel = orchestratedPlanCount > 1;
  const labelFor = (item: { planTitle: string; id: string }) =>
    needsQualifiedLabel ? `${item.planTitle}:${item.id}` : item.id;

  const lines: string[] = [];

  if (readyItems.length > 0) {
    lines.push("Ready to dispatch (no blockers — spawn subagents now):");
    for (const item of readyItems) {
      const label = labelFor(item);
      lines.push(`  → ${item.id}: "${item.content}" — use sessions_spawn with label="${label}"`);
    }
    if (readyItems.length > 1) {
      lines.push(`Spawn all ${readyItems.length} ready items in a single turn for parallel execution.`);
    }
  }

  if (runningItems.length > 0) {
    lines.push("Running (subagent in progress):");
    for (const item of runningItems) {
      lines.push(`  ◉ ${item.id}: "${item.content}"`);
    }
  }

  if (blockedItems.length > 0) {
    lines.push("Blocked (waiting for dependencies):");
    for (const item of blockedItems) {
      lines.push(`  ○ ${item.id}: "${item.content}" — waiting on ${item.waitingOn.join(", ")}`);
    }
  }

  if (deadlockedItems.length > 0) {
    lines.push("⚠️ Deadlocked (dependency failed/cancelled — cannot proceed automatically):");
    for (const item of deadlockedItems) {
      lines.push(`  ✗ ${item.id}: "${item.content}" — blocked by failed: ${item.failedDeps.join(", ")}`);
    }
    lines.push("Decide for each: retry the failed dependency (set it to pending in plan_write), skip this item (mark cancelled), or abort the plan.");
  }

  if (completedItems.length > 0) {
    lines.push("Completed:");
    for (const item of completedItems) {
      lines.push(`  ● ${item.id}: "${item.content}"`);
    }
  }

  // Remind agent to sync plan status to disk (updates the progress card)
  if (readyItems.length > 0 || completedItems.length > 0) {
    lines.push("After dispatching, call plan_write to sync item statuses — this updates the user's progress card.");
  }

  return `<orchestration_directive>\n${lines.join("\n")}\n</orchestration_directive>`;
}

// ─── Feishu Card Rendering (Card 2.0 — column_set per item) ─────────────────

function headerColor(completed: number, total: number): string {
  if (total === 0 || completed === 0) return "grey";
  if (completed === total) return "green";
  return "orange";
}

/** Build the icon markdown for an item based on its status. */
function itemIconMd(status: PlanStatus): string {
  switch (status) {
    case "completed":  return `<font color=grey>${STATUS_SYMBOL.completed}</font>`;
    case "in_progress": return `<font color=#F5821F>${STATUS_SYMBOL.in_progress}</font>`;
    case "failed":     return `<font color=red>${STATUS_SYMBOL.failed}</font>`;
    case "cancelled":  return `<font color=grey>${STATUS_SYMBOL.cancelled}</font>`;
    default:           return STATUS_SYMBOL.pending;
  }
}

/** Build the title markdown for an item. */
function itemTitleMd(item: PlanItem): string {
  switch (item.status) {
    case "completed":
      return `<font color=grey>~~${item.content}~~</font>`;
    case "in_progress": {
      const suffix = item.activeForm ? ` _— ${item.activeForm}_` : "";
      return `<font color=#F5821F>**${item.content}**${suffix}</font>`;
    }
    case "cancelled":
      return `<font color=grey>~~${item.content}~~</font>`;
    case "failed":
      return `<font color=red>**${item.content}**</font>`;
    default:
      return item.content;
  }
}

/**
 * Build one or two elements for a plan item.
 * - Line 1: icon + title (column_set)
 * - Line 2 (optional): live metrics sub-line or blocked-by hint
 */
function buildItemElements(item: PlanItem, metrics?: LiveItemMetrics): Record<string, unknown>[] {
  const elements: Record<string, unknown>[] = [];

  // Line 1: icon + title
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "default",
    columns: [
      {
        tag: "column",
        width: "auto",
        vertical_align: "center",
        elements: [{ tag: "markdown", content: itemIconMd(item.status) }],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [{ tag: "markdown", content: itemTitleMd(item) }],
      },
    ],
  });

  // Line 2: live metrics (in_progress with active subagent)
  if (item.status === "in_progress" && metrics) {
    elements.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "default",
      columns: [
        {
          tag: "column",
          width: "weighted",
          weight: 1,
          vertical_align: "center",
          elements: [{ tag: "markdown", content: `<font color=#F5821F>　正在 ${metrics.currentActivity}　已执行 ${metrics.blockCount} 步</font>` }],
        },
        {
          tag: "column",
          width: "auto",
          vertical_align: "center",
          elements: [{ tag: "markdown", content: `<font color=grey>耗时 ${metrics.elapsed}</font>` }],
        },
      ],
    });
  }

  // Line 2: blocked-by hint (pending with dependencies)
  if (item.status === "pending" && item.blockedBy && item.blockedBy.length > 0) {
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: `<font color=grey>　等待 ${item.blockedBy.join(", ")} 完成</font>` },
    });
  }

  return elements;
}

/**
 * Render a Feishu Card 2.0 JSON object.
 *
 * Each plan item is a `column_set` row with status icon, title, and
 * optional live metrics (elapsed time, block count, current activity)
 * for in_progress orchestrated items.
 */
export function renderFeishuCard(
  plan: PlanFile,
  message?: string,
  liveMetrics?: Map<string, LiveItemMetrics>,
): Record<string, unknown> {
  const items = plan.items;
  const total = items.length;
  const completed = items.filter((i) => i.status === "completed").length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const color = headerColor(completed, total);

  const time = new Date(plan.updatedAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Shanghai",
  });

  const noteContent = message ? `${message} · ${time}` : time;

  const bodyElements: Record<string, unknown>[] = [];

  // ── Progress bar (stacked horizontal chart) ──────────────────────────────
  const emptyPct = 100 - pct;
  bodyElements.push({
    tag: "chart",
    height: "24px",
    chart_spec: {
      type: "bar",
      data: [{ values: [
        { x: "p", y: pct, t: "done" },
        { x: "p", y: emptyPct, t: "todo" },
      ]}],
      xField: "y",
      yField: "x",
      seriesField: "t",
      direction: "horizontal",
      stack: true,
      color: ["#F5821F", "#2D2D2D"],
      bar: { style: { cornerRadius: 4 } },
      axes: [
        { orient: "left", visible: false },
        { orient: "bottom", visible: false },
      ],
      label: { visible: false },
      legends: { visible: false },
      tooltip: { visible: false },
      padding: 0,
    },
  });

  bodyElements.push({
    tag: "div",
    text: { tag: "lark_md", content: `**${completed}/${total} 完成 (${pct}%)**` },
  });

  bodyElements.push({ tag: "hr" });

  // ── Items: each item is a module (title line + optional metrics/blocked sub-line) ──
  for (const item of items) {
    const metrics = liveMetrics?.get(item.id);
    for (const el of buildItemElements(item, metrics)) {
      bodyElements.push(el);
    }
  }

  bodyElements.push({ tag: "hr" });

  bodyElements.push({
    tag: "div",
    text: { tag: "lark_md", content: `_${noteContent}_` },
  });

  return {
    schema: "2.0",
    config: { update_multi: true },
    header: {
      title: { tag: "plain_text", content: `🗂 ${plan.title}` },
      template: color,
    },
    body: { elements: bodyElements },
  };
}

/**
 * Render a plain text representation of the plan for non-Feishu channels.
 */
export function renderPlainText(plan: PlanFile, message?: string): string {
  const total = plan.items.length;
  const completed = plan.items.filter((i) => i.status === "completed").length;
  const itemLines = plan.items.map(formatItemText).join("\n");
  const bar = textProgressBar(completed, total);

  let text = `📋 ${plan.title}\n\n${itemLines}\n\nProgress: ${bar}`;
  if (message) text += `\n\n${message}`;
  return text;
}
