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

/**
 * Build full <plan_reminder> for injection when an active plan exists.
 * Optionally appends a stale-plan warning when idleCount is high.
 */
export function buildPlanReminder(plan: PlanFile, stale = false): string {
  const total = plan.items.length;
  const completed = plan.items.filter((i) => i.status === "completed").length;
  const inProgress = plan.items.filter((i) => i.status === "in_progress");
  const itemLines = plan.items.map(formatItemText).join("\n");

  const noInProgressWarning =
    plan.items.some((i) => i.status === "pending") && inProgress.length === 0
      ? "\n⚠️ No task is currently in_progress. Mark the active task in_progress before proceeding."
      : "";

  const staleWarning = stale
    ? "\n⚠️ plan_write hasn't been called in a while. Update task statuses now."
    : "";

  return `<plan_reminder>
Current plan: ${plan.title}

${itemLines}

Progress: ${textProgressBar(completed, total)}
${noInProgressWarning}${staleWarning}
Update plan_write when you complete a step or the plan changes.
Mark items in_progress when starting, completed when done.
Execute autonomously — do not stop to ask "shall I proceed?" or "is this okay?". Only pause for genuinely unexpected blockers requiring a real decision.
</plan_reminder>`;
}

/**
 * Build sparse <plan_reminder> — used when plan was just updated (low idle count).
 * Saves tokens; model already has full context from the recent plan_write call.
 */
export function buildPlanReminderSparse(plan: PlanFile): string {
  const total = plan.items.length;
  const completed = plan.items.filter((i) => i.status === "completed").length;
  const active = plan.items.find((i) => i.status === "in_progress");
  const activeSuffix = active
    ? ` · now: ${active.activeForm ?? active.content}`
    : " · no task in_progress";

  return `<plan_reminder>
Plan: ${plan.title} (${completed}/${total} done)${activeSuffix}
Use plan_write to update status as you work.
</plan_reminder>`;
}

/**
 * Build <plan_available> for injection when no plan exists.
 */
export function buildPlanAvailable(): string {
  return `<plan_available>
plan_write is available. Use it before any multi-step work — even linear tasks. A plan keeps you on track across tool calls and context compaction, and shows the user what's happening instead of leaving them waiting blind.
Workflow: ask all clarifying questions upfront (before the plan), then execute the plan autonomously without stopping to confirm each step.
</plan_available>`;
}

/**
 * Check if a plan has any active (non-terminal) items.
 */
export function isPlanActive(plan: PlanFile): boolean {
  return plan.items.some((i) => i.status === "pending" || i.status === "in_progress");
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
  // linearProgress mark-level styles are sandboxed by Feishu; barChart + color[]
  // is the most stable coloring API available in Feishu's VChart environment.
  const filledPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const emptyPct = 100 - filledPct;
  bodyElements.push({
    tag: "chart",
    height: "24px",
    chart_spec: {
      type: "bar",
      data: [
        {
          values: [
            { x: "p", y: filledPct, t: "done" },
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
