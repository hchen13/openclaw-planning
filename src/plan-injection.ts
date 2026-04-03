/**
 * Planning Plugin - System Prompt Injection & Card Rendering
 */

import type { PlanFile, PlanStatus } from "./types.js";

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
Update plan_write when you complete a step or the plan changes.
Mark items in_progress when starting, completed when done.
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
plan_write is available. Use it before any multi-step work — even linear tasks. A plan keeps you on track across tool calls and context compaction, and shows the user what's happening instead of leaving them waiting blind.
Multiple concurrent plans are supported — use different titles for unrelated tasks arriving mid-work.
Workflow: ask all clarifying questions upfront (before the plan), then execute the plan autonomously without stopping to confirm each step.
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
You are a sub-agent. The parent task has active plans — update them using plan_write with the EXACT same title.

${sections}${staleWarning}
Mark items in_progress when starting, completed when done.
Execute autonomously — do not stop to ask "shall I proceed?".
</plan_reminder>`;
}

// ─── Static Follow-Through Rules (injected into system prompt via appendSystemContext) ──

export const FOLLOW_THROUGH_RULES = `<planning_rules>
You are an agent that acts, not one that acknowledges. When a user asks you to do something, do it — don't say you will. If you need multiple steps, call plan_write to create a tracked plan before responding. If you genuinely cannot act (missing capability, ambiguous requirements, need credentials), say so plainly instead of making a promise you cannot keep.

Every commitment you make must be backed by either a tool call or a plan_write item in the same turn. A response that contains a commitment but no action — "收到，我去改" / "got it, I'll handle it" / "放心，记着呢" — is not an acceptable output, because there is nothing ensuring follow-through once this turn ends. Either act now, or create a plan item so it becomes tracked.

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

// ─── Feishu Card Rendering (Card DSL format) ─────────────────────────────────

// Bloomberg palette: #F5821F orange for active, grey for done, white for pending
function formatItemCard(item: { content: string; status: PlanStatus; activeForm?: string }): string {
  switch (item.status) {
    case "completed":
      return `<font color=grey>${STATUS_SYMBOL.completed} ~~${item.content}~~</font>`;
    case "in_progress": {
      const suffix = item.activeForm ? ` _— ${item.activeForm}_` : "";
      return `<font color=#F5821F>${STATUS_SYMBOL.in_progress} **${item.content}**${suffix}</font>`;
    }
    case "pending":
      return `${STATUS_SYMBOL.pending} ${item.content}`;
    case "cancelled":
      return `<font color=#8B8000>${STATUS_SYMBOL.cancelled} ~~${item.content}~~</font>`;
    case "failed":
      return `<font color=red>${STATUS_SYMBOL.failed} **${item.content}**</font>`;
    default:
      return `? ${item.content}`;
  }
}

function headerColor(completed: number, total: number): string {
  if (total === 0 || completed === 0) return "grey";
  if (completed === total) return "green";
  return "orange";
}

/**
 * Render a Feishu Card 2.0 JSON object.
 *
 * Card 2.0 supports per-column background_style, enabling a real color
 * progress bar. Individual column weights must be integers in [1, 5].
 */
export function renderFeishuCard(plan: PlanFile, message?: string): Record<string, unknown> {
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
  const itemsText = items.map(formatItemCard).join("\n");

  const bodyElements: Record<string, unknown>[] = [];

  // ── Stacked horizontal barChart as progress bar ──────────────────────────────
  const emptyPct = 100 - pct;
  bodyElements.push({
    tag: "chart",
    height: "24px",
    chart_spec: {
      type: "bar",
      data: [
        {
          values: [
            { x: "p", y: pct, t: "done" },
            { x: "p", y: emptyPct,  t: "todo" },
          ],
        },
      ],
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

  bodyElements.push({
    tag: "div",
    text: { tag: "lark_md", content: itemsText },
  });

  bodyElements.push({ tag: "hr" });

  // `note` is deprecated in Card 2.0 — use a small italic div instead
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
