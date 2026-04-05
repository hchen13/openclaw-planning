/**
 * Planning Plugin - Live Subagent Metrics
 *
 * Tracks real-time activity indicators for orchestrated subagent sessions:
 * - Elapsed time since spawn
 * - Content block count (tool_call blocks via before/after_tool_call hooks)
 * - Current tool activity (friendly display name + context from args)
 *
 * Also manages periodic Feishu card refresh for live metric display.
 */

import type { PlanFile } from "./types.js";
import { getOrchestratedBindingsForParent } from "./runtime-state.js";
import { updateCard } from "./feishu-client.js";

// ─── Tool Display Name Mapping ──────────────────────────────────────────────

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  exec: "跑命令",
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  browser: "看网页",
  web_search: "搜网络",
  web_fetch: "抓网页",
  process: "处理数据",
  image: "处理图片",
  image_generate: "生成图片",
  plan_write: "更新计划",
  sessions_spawn: "分任务",
  sessions_yield: "等结果",
  sessions_send: "发消息",
  sessions_list: "看任务",
  sessions_history: "看历史",
  session_status: "看状态",
  subagents: "管子任务",
  message: "发消息",
  memory_search: "查记忆",
  memory_get: "读记忆",
  cron: "定时任务",
  pdf: "处理PDF",
  apply_patch: "打补丁",
  feishu_sheet: "编辑表格",
  feishu_wiki: "编辑文档",
  feishu_drive: "访问云盘",
  feishu_doc: "编辑文档",
  feishu_id: "查用户",
  feishu_task_create: "建任务",
  Grep: "搜代码",
  Read: "读文件",
  Write: "写文件",
  Edit: "改文件",
  Bash: "跑命令",
  Glob: "找文件",
  WebFetch: "抓网页",
  WebSearch: "搜网络",
  NotebookEdit: "编辑笔记",
};

function friendlyToolName(toolName: string): string {
  return TOOL_DISPLAY_NAMES[toolName] ?? toolName;
}

/** Return a user-friendly tool name. No context/args — card space is limited. */
export function formatToolActivity(toolName: string, _args?: Record<string, unknown>): string {
  return friendlyToolName(toolName);
}

// ─── Per-Subagent Metrics State ─────────────────────────────────────────────

export interface SubagentMetrics {
  startedAt: number;
  blockCount: number;
  currentActivity: string;
  lastEventAt: number;
}

const metricsStore = new Map<string, SubagentMetrics>();

export function startMetricsTracking(childSessionKey: string): void {
  metricsStore.set(childSessionKey, {
    startedAt: Date.now(),
    blockCount: 0,
    currentActivity: "思考中…",
    lastEventAt: Date.now(),
  });
}

/** Called on before_tool_call: a new tool block is starting. */
export function recordToolStart(childSessionKey: string, toolName: string, toolArgs?: Record<string, unknown>): void {
  const m = metricsStore.get(childSessionKey);
  if (!m) return;
  m.blockCount++;
  m.lastEventAt = Date.now();
  m.currentActivity = formatToolActivity(toolName, toolArgs);
}

/** Called on after_tool_call: tool finished, show completed tool instead of "思考中". */
export function recordToolEnd(childSessionKey: string, toolName?: string): void {
  const m = metricsStore.get(childSessionKey);
  if (!m) return;
  m.lastEventAt = Date.now();
  // Show the completed tool with ✓ — more informative than "思考中" and stays visible
  // until the next tool starts
  m.currentActivity = toolName ? `${friendlyToolName(toolName)} ✓` : "处理中…";
}

export function getMetrics(childSessionKey: string): SubagentMetrics | undefined {
  return metricsStore.get(childSessionKey);
}

export function clearMetrics(childSessionKey: string): void {
  metricsStore.delete(childSessionKey);
}

/** Check if any live metrics exist for a specific plan (not global). */
export function hasActiveMetricsForPlan(parentSessionKey: string, planTitle: string): boolean {
  const bindings = getOrchestratedBindingsForParent(parentSessionKey);
  for (const [childKey, binding] of bindings) {
    if (binding.planTitle === planTitle && metricsStore.has(childKey)) return true;
  }
  return false;
}

// ─── Display Helpers ────────────────────────────────────────────────────────

export function formatElapsed(startedAt: number): string {
  const ms = Math.max(0, Date.now() - startedAt);
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = ms / 60_000;
  return `${minutes.toFixed(1)}m`;
}

export interface LiveItemMetrics {
  elapsed: string;
  blockCount: number;
  currentActivity: string;
}

/**
 * Build a map of itemId → live metrics for a specific plan.
 * Bridges orchestrated bindings (runtime-state) with metrics tracking.
 */
export function buildLiveMetricsMap(parentSessionKey: string, planTitle: string): Map<string, LiveItemMetrics> {
  const bindings = getOrchestratedBindingsForParent(parentSessionKey);
  const result = new Map<string, LiveItemMetrics>();
  for (const [childKey, binding] of bindings) {
    if (binding.planTitle !== planTitle) continue;
    const m = metricsStore.get(childKey);
    if (!m) continue;
    result.set(binding.itemId, {
      elapsed: formatElapsed(m.startedAt),
      blockCount: m.blockCount,
      currentActivity: m.currentActivity,
    });
  }
  return result;
}

// ─── Periodic Card Refresh ──────────────────────────────────────────────────

interface CardRefreshTarget {
  planPath: string;
  planTitle: string;
  parentSessionKey: string;
  creds: { appId: string; appSecret: string; domain?: string };
  messageId: string;
  consecutiveFailures: number;
}

const MAX_REFRESH_FAILURES = 10;

const refreshTargets = new Map<string, CardRefreshTarget>();
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let refreshInProgress = false;

const REFRESH_INTERVAL_MS = 1_000;

export function registerCardRefreshTarget(target: Omit<CardRefreshTarget, "consecutiveFailures">): void {
  const key = `${target.parentSessionKey}:${target.planTitle}`;
  refreshTargets.set(key, { ...target, consecutiveFailures: 0 });
  ensureTimerRunning();
}

export function unregisterCardRefreshTarget(parentSessionKey: string, planTitle: string): void {
  refreshTargets.delete(`${parentSessionKey}:${planTitle}`);
  if (refreshTargets.size === 0) stopTimer();
}

function ensureTimerRunning(): void {
  if (refreshTimer) return;
  refreshTimer = setInterval(doRefreshCycle, REFRESH_INTERVAL_MS);
  refreshTimer.unref(); // Allow clean process exit
}

function stopTimer(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

type PlanReader = (planPath: string) => Promise<PlanFile | null>;
type CardRenderer = (plan: PlanFile, message: string | undefined, liveMetrics: Map<string, LiveItemMetrics>) => Record<string, unknown>;
type StatusOverlay = (parentSessionKey: string, plan: PlanFile) => void;
type Logger = { info?: (...args: any[]) => void; warn?: (...args: any[]) => void };

let _planReader: PlanReader | null = null;
let _cardRenderer: CardRenderer | null = null;
let _statusOverlay: StatusOverlay | null = null;
let _logger: Logger = {};

/**
 * Must be called once during plugin init to wire dependencies.
 * Avoids circular imports — index.ts passes the functions in.
 */
export function initCardRefresh(deps: {
  readPlan: PlanReader;
  renderCard: CardRenderer;
  applyManagedStatuses: StatusOverlay;
  logger: Logger;
}): void {
  _planReader = deps.readPlan;
  _cardRenderer = deps.renderCard;
  _statusOverlay = deps.applyManagedStatuses;
  _logger = deps.logger;
}

async function doRefreshCycle(): Promise<void> {
  if (refreshInProgress) return;
  if (!_planReader || !_cardRenderer) return;
  refreshInProgress = true;

  try {
    for (const [key, target] of [...refreshTargets]) {
      try {
        const plan = await _planReader(target.planPath);
        if (!plan) continue;

        // Use messageId from plan file (authoritative) instead of cached target
        const messageId = plan.feishu?.messageId ?? target.messageId;

        // Apply managed statuses so card reflects orchestrated state
        _statusOverlay?.(target.parentSessionKey, plan);

        // Check if any items are still in_progress
        const hasActive = plan.items.some((i) => i.status === "in_progress");
        if (!hasActive) {
          // Do one final render then unregister
          const metricsMap = buildLiveMetricsMap(target.parentSessionKey, target.planTitle);
          const cardJson = _cardRenderer(plan, undefined, metricsMap);
          await updateCard(target.creds, messageId, cardJson).catch(() => {});
          refreshTargets.delete(key);
          continue;
        }

        const metricsMap = buildLiveMetricsMap(target.parentSessionKey, target.planTitle);
        if (metricsMap.size === 0) continue; // No active metrics to display

        const cardJson = _cardRenderer(plan, undefined, metricsMap);
        await updateCard(target.creds, messageId, cardJson);
        target.consecutiveFailures = 0; // Reset on success
      } catch (err) {
        target.consecutiveFailures++;
        if (target.consecutiveFailures >= MAX_REFRESH_FAILURES) {
          _logger.warn?.(`planning: live-metrics refresh gave up after ${MAX_REFRESH_FAILURES} failures for "${target.planTitle}"`);
          refreshTargets.delete(key);
        } else {
          _logger.warn?.(`planning: live-metrics refresh failed (${target.consecutiveFailures}/${MAX_REFRESH_FAILURES}): ${err}`);
        }
      }
    }

    if (refreshTargets.size === 0) stopTimer();
  } finally {
    refreshInProgress = false;
  }
}
