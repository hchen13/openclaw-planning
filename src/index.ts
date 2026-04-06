/**
 * OpenClaw Planning Plugin
 *
 * Registered capabilities:
 *   Tool:   plan_write          — create/update structured task plans
 *   Hook:   before_prompt_build — inject plan reminder + orchestration directive + follow-through rules
 *   Hook:   before_tool_call    — spawn gating (no plan → no spawn) + dependency check
 *   Hook:   after_tool_call     — maintain per-session idle counter
 *   Hook:   subagent_spawned    — orchestrated binding or plan delegation
 *   Hook:   subagent_ended      — orchestrated status auto-update + fallback poke
 *   Hook:   message_received    — capture conversationId for card routing
 *   Hook:   message_sending     — confirmation suppression + promise-only turn guard
 *   Hook:   agent_end           — promise guard recovery repoke
 */

import * as path from "path";
import { unlink } from "fs/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PlanWriteSchema, PLAN_WRITE_DESCRIPTION } from "./plan-tool.js";
import {
  resolvePlanDir,
  resolvePlanFilePath,
  resolveLegacyPlanPath,
  readPlan,
  readAllPlans,
  readAllPlansFromDir,
  writePlan,
  buildPlan,
  validateDependencyGraph,
} from "./plan-state.js";
import {
  buildPlanReminder,
  buildPlanReminderSparse,
  buildPlanAvailable,
  buildDelegatedPlanReminder,
  buildOrchestrationDirective,
  hasOrchestratedItems,
  isPlanActive,
  renderFeishuCard,
  renderPlainText,
  FOLLOW_THROUGH_RULES,
} from "./plan-injection.js";
import { sendCard, updateCard, normalizeTargetId } from "./feishu-client.js";
import { resolveTelegramToken, sendMessageTg, editMessageTg } from "./telegram-client.js";
import {
  recordToolCall,
  beginTurn,
  finishTurn,
  getConsecutivePromiseGuardRecoveries,
  getCurrentTurn,
  setSessionMeta,
  getIdleCount,
  getPlanDir,
  incrementConsecutivePromiseGuardRecoveries,
  markTurnAskedBlockingQuestion,
  markTurnSuppressedConfirmation,
  recordTurnToolCall,
  resetConsecutivePromiseGuardRecoveries,
  setAgentActivePlan,
  getAgentActivePlan,
  setSessionActivePlan,
  getSessionActivePlan,
  setSessionAgentDir,
  getSessionAgentDir,
  setSessionConversationId,
  getSessionConversationId,
  setSuppressedPromiseText,
  setTurnPromptState,
  setAccountConversationId,
  getAccountConversationId,
  setPlanDelegation,
  getPlanDelegation,
  setOrchestratedBinding,
  getOrchestratedBinding,
  setManagedStatus,
  getManagedStatus,
  deleteManagedStatus,
  clearManagedStatuses,
  getOrchestratedBindingsForParent,
  deleteOrchestratedBinding,
  deletePlanDelegation,
  pushActivatedItem,
  popActivatedItem,
  isPlanTitleConfirmed,
  markPlanTitleConfirmed,
  getPlanAbandonmentRepokes,
  getPlanCloseNudges,
  incrementPlanCloseNudges,
  resetPlanCloseNudges,
  incrementPlanAbandonmentRepokes,
  resetPlanAbandonmentRepokes,
  type TurnState,
} from "./runtime-state.js";
import type { PlanWriteInput } from "./types.js";
import {
  startMetricsTracking,
  recordToolStart,
  recordToolEnd,
  clearMetrics,
  buildLiveMetricsMap,
  initCardRefresh,
  registerCardRefreshTarget,
  unregisterCardRefreshTarget,
  hasActiveMetricsForPlan,
} from "./live-metrics.js";

// ── Thresholds ──────────────────────────────────────────────────────────────
/** Below this idle count → sparse reminder (model just updated the plan). */
const SPARSE_THRESHOLD = 3;
/** At or above this idle count → full reminder + stale warning. */
const STALE_THRESHOLD = 8;
/** Delay before poking parent session after a non-ok subagent exit (ms). */
const SUBAGENT_POKE_DELAY_MS = 5_000;
/** Max consecutive plan-abandonment repokes before giving up. */
const PLAN_ABANDONMENT_MAX_REPOKES = 3;
/** Max nudges for completed-but-not-closed plans. */
const PLAN_CLOSE_MAX_NUDGES = 2;
/** Max content length to consider as a standalone confirmation message. */
const CONFIRMATION_MAX_LEN = 200;
/** Rollout mode for promise-only turn guard. */
type PromiseGuardMode = "off" | "observe" | "enforce_active_plan" | "enforce_task_turn";
const PROMISE_GUARD_MODE = "enforce_active_plan" as PromiseGuardMode;
const PROMISE_GUARD_MAX_LEN = 240;
const PROMISE_GUARD_MAX_CONSECUTIVE_REPOKES = 1;
const PROMISE_GUARD_RECOVERY_PROMPT = `[planning] Your previous user-visible message was suppressed because it stated intent without action.
Continue this task now.
Do exactly one of:
1. ask a blocking question
2. call plan_write
3. call an execution tool
Do not send another promise-only update.`;

const PROMISE_GUARD_STREAMING_RECOVERY_PROMPT = `[planning] Your previous message stated intent without taking action.
Your message was delivered, but you must follow through now.
Do exactly one of:
1. ask a blocking question
2. call plan_write
3. call an execution tool
Do not end this turn without a concrete action.`;

const BLOCKING_QUESTION_PATTERNS = [
  /(?:是否|还是|优先|想确认|确认一下|需要确认|先确认|你更想|要不要|可以吗|行不行|要哪个)/,
  /\b(should|which|what scope|what kind|do you want|would you like|can you confirm|which one|whether)\b/i,
];

const PROMISE_FUTURE_PATTERNS = [
  /我(会|先|去|来|接下来|现在就|马上)/,
  /我这边先/,
  /我先.*再/,
  /接下来我会/,
  /\b(i will|i'?ll|let me|i am going to|next i will|next i'?ll)\b/i,
];

const PROMISE_ACK_PATTERNS = [
  /^(?:收到|明白|好|好的|可以|行|了解|嗯|对)(?:[\s,，。!！?？:]|$)|^(?:ok|okay|got it|understood|alright)\b/i,
  /^(那我|我这边|接下来|next|then i)\b/i,
  /^(我(会|先|去|来|接下来|现在就|马上)|我这边先|我先.*再|接下来我会)/,
  /^(i will|i'?ll|i am going to|let me|next i will|next i'?ll)\b/i,
];

const missingSessionKeyLogCache = new Map<string, number>();

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveFeishuCreds(
  config: any,
  agentAccountId?: string,
): { appId: string; appSecret: string; domain?: string } | null {
  const feishu = config?.channels?.feishu;
  if (!feishu) return null;
  if (agentAccountId && feishu.accounts?.[agentAccountId]) {
    const acct = feishu.accounts[agentAccountId];
    if (acct.appId && acct.appSecret) {
      return { appId: acct.appId, appSecret: acct.appSecret, domain: acct.domain ?? feishu.domain };
    }
  }
  if (feishu.appId && feishu.appSecret) {
    return { appId: feishu.appId, appSecret: feishu.appSecret, domain: feishu.domain };
  }
  return null;
}

/**
 * Returns true if the message content looks like an unnecessary confirmation
 * request while the agent has an active plan and should just proceed.
 *
 * Only applied to short messages (< CONFIRMATION_MAX_LEN chars).
 */
function isUnnecessaryConfirmation(content: string): boolean {
  const patterns = [
    // Chinese — typical Xinge failure modes
    /如果你认可/,
    /如果你同意/,
    /如果你觉得可以/,
    /要不要(我|继续)/,
    /你看.*行不行/,
    /需要我继续吗/,
    /是否继续[^？?]*[？?]\s*$/,
    /可以开始吗/,
    // English
    /shall I (?:proceed|continue|go ahead)/i,
    /would you like me to/i,
    /if you(?:'?d)? (?:like|want) me to/i,
    /should I (?:proceed|continue|go ahead)/i,
    /do you want me to continue/i,
  ];
  return patterns.some((p) => p.test(content));
}

function normalizeGuardContent(content: string): string {
  return content
    .trim()
    .replace(/^\[\[reply_to_current\]\]\s*/i, "")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ");
}

function looksLikeBlockingQuestion(content: string): boolean {
  const normalized = normalizeGuardContent(content);
  if (!normalized || normalized.length > PROMISE_GUARD_MAX_LEN) return false;
  if (!normalized.includes("?") && !normalized.includes("？")) return false;
  return BLOCKING_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasCompletedResultMarkers(content: string): boolean {
  return (
    content.includes("```") ||
    content.includes("\n- ") ||
    content.includes("\n1. ") ||
    /`[^`\n]+`/.test(content) ||
    content.includes("/Users/")
  );
}

function looksLikePromiseOnlyMessage(content: string): boolean {
  const normalized = normalizeGuardContent(content);
  if (!normalized || normalized.length > PROMISE_GUARD_MAX_LEN) return false;
  if (hasCompletedResultMarkers(content)) return false;
  if (looksLikeBlockingQuestion(content)) return false;
  const matchesFuture = PROMISE_FUTURE_PATTERNS.some((pattern) => pattern.test(normalized));
  const matchesAck = PROMISE_ACK_PATTERNS.some((pattern) => pattern.test(normalized));
  return matchesFuture && matchesAck;
}

function isTaskLikeTurn(turn: TurnState): boolean {
  switch (PROMISE_GUARD_MODE) {
    case "off":
      return false;
    case "observe":
    case "enforce_active_plan":
      return turn.hasActivePlanAtStart === true;
    case "enforce_task_turn":
      return turn.hasActivePlanAtStart === true || turn.promptKind === "plan_available";
    default:
      return false;
  }
}

function shouldSuppressPromiseOnlyMessage(content: string, turn?: TurnState): boolean {
  return Boolean(
    turn &&
    isTaskLikeTurn(turn) &&
    turn.planWrites === 0 &&
    turn.actionToolCalls === 0 &&
    turn.askedBlockingQuestion === false &&
    looksLikePromiseOnlyMessage(content),
  );
}

function shouldRecoverFromPromiseOnlyEnd(turn: TurnState, sessionKey: string): boolean {
  return Boolean(
    turn.suppressedPromiseText &&
    turn.planWrites === 0 &&
    turn.actionToolCalls === 0 &&
    turn.askedBlockingQuestion === false &&
    getConsecutivePromiseGuardRecoveries(sessionKey) < PROMISE_GUARD_MAX_CONSECUTIVE_REPOKES,
  );
}

function truncateForLog(content: string): string {
  const normalized = normalizeGuardContent(content);
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function buildPromiseGuardLog(
  eventName: string,
  payload: {
    sessionKey?: string;
    agentId?: string;
    turn?: TurnState;
    content?: string;
  },
): string {
  const detail = {
    sessionKey: payload.sessionKey,
    agentId: payload.agentId,
    turnSeq: payload.turn?.turnSeq,
    mode: PROMISE_GUARD_MODE,
    toolCalls: payload.turn?.allToolCalls ?? [],
    planWrites: payload.turn?.planWrites,
    askedBlockingQuestion: payload.turn?.askedBlockingQuestion,
    promptKind: payload.turn?.promptKind,
    content: payload.content ? truncateForLog(payload.content) : undefined,
  };
  return `${eventName} ${JSON.stringify(detail)}`;
}

function shouldLogMissingSessionKey(accountId?: string, conversationId?: string): boolean {
  const key = `${accountId ?? "unknown"}:${conversationId ?? "unknown"}`;
  const now = Date.now();
  const prev = missingSessionKeyLogCache.get(key) ?? 0;
  if (now - prev < 5_000) return false;
  missingSessionKeyLogCache.set(key, now);
  return true;
}

/**
 * Resolve the best target ID for sending channel notifications.
 * Prefers conversationId (correct for group chats) over requesterSenderId (user DM).
 *
 * Edge case: if message_received hasn't fired yet (e.g. plan_write on the very first
 * turn), conversationId is undefined and card falls back to requester DM. This is
 * acceptable — the next plan_write update will route correctly once conversationId
 * has been captured.
 */
function resolveNotificationTarget(
  sessionKey: string | undefined,
  agentAccountId: string | undefined,
  requesterSenderId: string | undefined,
): string | undefined {
  // 1. Per-session conversationId (most precise)
  if (sessionKey) {
    const sessionConv = getSessionConversationId(sessionKey);
    if (sessionConv) return sessionConv;
  }
  // 2. Per-account conversationId (fallback when session not tracked)
  if (agentAccountId) {
    const accountConv = getAccountConversationId(agentAccountId);
    if (accountConv) return accountConv;
  }
  // 3. Original sender ID (legacy behavior — sends to DM)
  return requesterSenderId;
}

/**
 * Read-then-patch channel state on plan file to avoid TOCTOU race condition.
 * Between the initial writePlan and the channel API call (which may take seconds),
 * another plan_write could have updated the file. Re-read before patching ensures
 * we don't overwrite concurrent changes.
 */
async function patchPlanChannelState(
  planPath: string,
  patch: { feishu?: { messageId: string; targetId: string; lastUpdatedAt: number; sessionId: string };
           telegram?: { messageId: number; chatId: string; lastUpdatedAt: number; sessionId: string } },
): Promise<void> {
  const latest = await readPlan(planPath);
  if (!latest) return; // Plan was deleted between write and now
  if (patch.feishu) latest.feishu = patch.feishu;
  if (patch.telegram) latest.telegram = patch.telegram;
  await writePlan(planPath, latest);
}

// ── Plugin ───────────────────────────────────────────────────────────────────

const plugin = {
  id: "planning",
  name: "Planning",

  register(api: OpenClawPluginApi) {
    const logger = api.logger;
    logger.info?.("planning: registering plugin");

    // ── Initialize live-metrics card refresh ────────────────────────────────
    initCardRefresh({
      readPlan,
      renderCard: renderFeishuCard,
      applyManagedStatuses: (parentSessionKey, plan) => {
        for (const item of plan.items) {
          const managed = getManagedStatus(parentSessionKey, plan.title, item.id);
          if (managed) item.status = managed;
        }
      },
      logger,
    });

    // ── plan_write Tool ──────────────────────────────────────────────────────
    api.registerTool(
      (ctx) => {
        const sessionId = ctx.sessionId;
        const agentId = ctx.agentId;
        const agentDir = ctx.agentDir;

        if (!sessionId || !agentDir) return null;

        // Record agentDir so before_prompt_build can use the authoritative path
        const sessionKey = ctx.sessionKey;
        if (sessionKey) setSessionAgentDir(sessionKey, agentDir);

        return {
          name: "plan_write",
          label: "Plan Write",
          description: PLAN_WRITE_DESCRIPTION,
          parameters: PlanWriteSchema,
          async execute(_toolCallId: string, params: unknown) {
            const input = params as PlanWriteInput;

            // ── Delegation: subagent writes to parent's planDir ──────────────
            const delegation = sessionKey ? getPlanDelegation(sessionKey) : undefined;
            const effectivePlanDir = delegation
              ? delegation.parentPlanDir
              : resolvePlanDir(agentDir, sessionId);
            const planPath = resolvePlanFilePath(effectivePlanDir, input.title);

            // Read existing plan for this specific title
            let existing = await readPlan(planPath);

            // Migration: check legacy single-file format (non-delegated only)
            if (!existing && !delegation) {
              const legacyPath = resolveLegacyPlanPath(agentDir, sessionId);
              const legacy = await readPlan(legacyPath);
              if (legacy && legacy.title === input.title) {
                existing = legacy;
              }
            }

            // Empty items → clear this specific plan
            if (!input.items || input.items.length === 0) {
              try { await unlink(planPath); } catch (err: any) { if (err.code !== "ENOENT") throw err; }
              // Also try legacy path (non-delegated only)
              if (!delegation) {
                const legacyPath = resolveLegacyPlanPath(agentDir, sessionId);
                const legacyPlan = await readPlan(legacyPath);
                if (legacyPlan && legacyPlan.title === input.title) {
                  try { await unlink(legacyPath); } catch (err: any) { if (err.code !== "ENOENT") throw err; }
                }
              }
              // Clean up managed statuses for the cleared plan
              const clearKey = delegation?.parentSessionKey ?? sessionKey;
              if (clearKey) clearManagedStatuses(clearKey, input.title);

              // Sync runtime state so message_sending hook doesn't think a plan is still active
              const remainingPlans = delegation
                ? await readAllPlansFromDir(effectivePlanDir)
                : await readAllPlans(agentDir, sessionId);
              const stillActive = remainingPlans.some((p) => isPlanActive(p));
              if (sessionKey) setSessionActivePlan(sessionKey, stillActive);
              if (agentId) setAgentActivePlan(agentId ?? "unknown", stillActive);

              logger.info?.(`planning: plan "${input.title}" cleared for session ${sessionId.slice(0, 8)}`);
              return { content: [{ type: "text" as const, text: `Plan "${input.title}" cleared.` }], details: undefined };
            }

            // Coerce empty-string agentTask to undefined (not a valid subagent prompt)
            for (const item of input.items) {
              if (item.agentTask !== undefined && !item.agentTask.trim()) {
                item.agentTask = undefined;
              }
            }

            // ── Auto-assign item IDs ──────────────────────────────────────
            // Items without an ID get one auto-generated. Existing items (updates)
            // keep their ID from the previous version, matched by content.
            {
              // Collect IDs already provided by the agent
              const usedIds = new Set(input.items.filter((i) => i.id).map((i) => i.id!));
              let autoCounter = 1;
              const generateId = () => {
                while (usedIds.has(`t${autoCounter}`)) autoCounter++;
                const id = `t${autoCounter}`;
                usedIds.add(id);
                autoCounter++;
                return id;
              };

              for (const item of input.items) {
                if (!item.id) {
                  // Try to match an existing item by content (preserves ID across updates)
                  const prev = existing?.items.find(
                    (p) => p.content === item.content && !usedIds.has(p.id),
                  );
                  if (prev) {
                    item.id = prev.id;
                    usedIds.add(prev.id);
                  } else {
                    item.id = generateId();
                  }
                }
              }

              // Resolve index-based blockedBy references to IDs
              for (const item of input.items) {
                if (!item.blockedBy) continue;
                item.blockedBy = item.blockedBy.map((ref) => {
                  if (typeof ref === "number") {
                    if (ref < 0 || ref >= input.items.length) return `__invalid_index_${ref}`;
                    return input.items[ref].id!;
                  }
                  return ref;
                }) as string[];
              }
            }

            // Validate unique item IDs (after auto-assignment)
            const itemIds = new Set<string>();
            for (const item of input.items) {
              if (itemIds.has(item.id!)) {
                return {
                  content: [{ type: "text" as const, text: `Plan rejected: duplicate item ID "${item.id}". Each item must have a unique ID.` }],
                  details: undefined,
                };
              }
              itemIds.add(item.id!);
            }

            // Validate dependency graph if any item declares blockedBy
            if (input.items.some((i) => i.blockedBy && i.blockedBy.length > 0)) {
              const dagError = validateDependencyGraph(input.items as Array<{ id: string; blockedBy?: string[] }>);
              if (dagError) {
                return {
                  content: [{ type: "text" as const, text: `Plan rejected: ${dagError}. Fix the blockedBy fields and try again.` }],
                  details: undefined,
                };
              }
            }

            // Apply plugin-managed statuses: if the plugin has auto-updated an item
            // (e.g. subagent completed), preserve that status regardless of what the agent passes.
            // Exceptions:
            // - Agent sets "pending" → retry intent, clear managed status
            // - Agent sets a terminal status (completed/failed/cancelled) while managed is "in_progress"
            //   → forward progress, accept and clear managed status (handles gateway restart losing bindings)
            const parentSessionKey = delegation?.parentSessionKey ?? sessionKey;
            const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
            if (parentSessionKey) {
              for (const item of input.items) {
                const managed = getManagedStatus(parentSessionKey, input.title, item.id!);
                if (managed && managed !== item.status) {
                  if (item.status === "pending") {
                    // Agent wants to retry — delete managed status so it no longer overrides
                    deleteManagedStatus(parentSessionKey, input.title, item.id!);
                    logger.info?.(`planning: cleared managed status for item "${item.id}" (agent retry)`);
                  } else if (TERMINAL_STATUSES.has(item.status) && managed === "in_progress") {
                    // Agent is marking forward progress — accept and clear stale managed status
                    deleteManagedStatus(parentSessionKey, input.title, item.id!);
                    logger.info?.(`planning: accepted forward progress for item "${item.id}": ${managed} → ${item.status} (managed status cleared)`);
                  } else {
                    logger.info?.(`planning: enforcing managed status for item "${item.id}": ${item.status} → ${managed}`);
                    item.status = managed;
                  }
                }
              }
            }

            // Build and write plan
            // For delegated plans, preserve parent's sessionId so Feishu card PATCH works
            const effectiveSessionId = (delegation && existing?.sessionId)
              ? existing.sessionId
              : sessionId;
            // Detect items transitioning to in_progress (for auto-binding spawns)
            // Must happen BEFORE buildPlan since input.items has the final statuses
            const activatingSessionKey = delegation?.parentSessionKey ?? sessionKey;
            if (activatingSessionKey) {
              for (const item of input.items) {
                if (item.status !== "in_progress") continue;
                const prevStatus = existing?.items.find((i) => i.id === item.id)?.status;
                // Only push if transitioning from non-in_progress (or new item)
                if (!prevStatus || prevStatus !== "in_progress") {
                  pushActivatedItem(activatingSessionKey, input.title, item.id!);
                }
              }
            }

            const plan = buildPlan(input, existing, {
              sessionId: effectiveSessionId,
              agentId: agentId ?? "unknown",
            });
            await writePlan(planPath, plan);

            // Clean up legacy file if we migrated (non-delegated only)
            if (existing && !delegation) {
              const legacyPath = resolveLegacyPlanPath(agentDir, sessionId);
              const legacyPlan = await readPlan(legacyPath);
              if (legacyPlan && legacyPlan.title === input.title) {
                try { await unlink(legacyPath); } catch { /* best effort */ }
              }
            }

            logger.info?.(
              `planning: plan updated "${plan.title}" ` +
              `${plan.items.filter((i) => i.status === "completed").length}/${plan.items.length} ` +
              `for session ${sessionId.slice(0, 8)}${delegation ? " (delegated)" : ""}`
            );

            // ── Channel progress notifications ──────────────────────────────
            // For delegated plans, use parent's channel info
            const channel = delegation?.messageChannel ?? ctx.messageChannel;
            const notifyTarget = delegation?.conversationId
              ?? resolveNotificationTarget(sessionKey, ctx.agentAccountId, ctx.requesterSenderId);
            const effectiveAccountId = delegation?.agentAccountId ?? ctx.agentAccountId;
            let channelNotificationSent = false;

            // Feishu card
            const creds = resolveFeishuCreds(ctx.config, effectiveAccountId);

            if (channel === "feishu" && creds && notifyTarget && parentSessionKey) {
              // Include live metrics in card render so plan_write never wipes them
              const metricsMap = buildLiveMetricsMap(parentSessionKey, input.title);
              const cardJson = renderFeishuCard(plan, input.message, metricsMap);
              const feishuSameSession = plan.feishu?.sessionId === effectiveSessionId;
              if (plan.feishu?.messageId && feishuSameSession) {
                try {
                  await updateCard(creds, plan.feishu.messageId, cardJson);
                  await patchPlanChannelState(planPath, {
                    feishu: { messageId: plan.feishu.messageId, targetId: plan.feishu.targetId, sessionId: plan.feishu.sessionId ?? sessionId, lastUpdatedAt: Date.now() },
                  });
                  // Register for live-metrics periodic refresh if orchestrated items are active
                  if (plan.items.some((i) => i.status === "in_progress")) {
                    registerCardRefreshTarget({
                      planPath, planTitle: plan.title, parentSessionKey,
                      creds, messageId: plan.feishu.messageId,
                    });
                  }
                } catch (err) {
                  logger.warn?.(`planning: PATCH failed, sending new card: ${err}`);
                  try {
                    const result = await sendCard(creds, notifyTarget, cardJson);
                    await patchPlanChannelState(planPath, {
                      feishu: { messageId: result.messageId, targetId: notifyTarget, lastUpdatedAt: Date.now(), sessionId: effectiveSessionId },
                    });
                    if (plan.items.some((i) => i.status === "in_progress")) {
                      registerCardRefreshTarget({
                        planPath, planTitle: plan.title, parentSessionKey,
                        creds, messageId: result.messageId,
                      });
                    }
                  } catch (sendErr) {
                    logger.warn?.(`planning: send card also failed: ${sendErr}`);
                  }
                }
              } else {
                try {
                  const result = await sendCard(creds, notifyTarget, cardJson);
                  await patchPlanChannelState(planPath, {
                    feishu: { messageId: result.messageId, targetId: notifyTarget, lastUpdatedAt: Date.now(), sessionId: effectiveSessionId },
                  });
                  if (plan.items.some((i) => i.status === "in_progress")) {
                    registerCardRefreshTarget({
                      planPath, planTitle: plan.title, parentSessionKey,
                      creds, messageId: result.messageId,
                    });
                  }
                } catch (err) {
                  logger.warn?.(`planning: send card failed: ${err}`);
                }
              }
              channelNotificationSent = true;
            }

            // Telegram text message
            const tgToken = resolveTelegramToken(ctx.config, effectiveAccountId);
            // Use stored chatId for edits; fall back to notifyTarget for new messages.
            // Strip channel prefix (e.g. "telegram:5181221468" → "5181221468") since
            // the Telegram Bot API requires a raw numeric chat_id.
            const rawTgTarget = notifyTarget?.replace(/^telegram:/, "");
            const tgChatId = plan.telegram?.chatId ?? rawTgTarget;

            if (channel === "telegram" && tgToken && tgChatId) {
              const text = renderPlainText(plan, input.message);
              const tgSameSession = plan.telegram?.sessionId === effectiveSessionId;
              if (plan.telegram?.messageId && tgSameSession) {
                try {
                  await editMessageTg(tgToken, plan.telegram.chatId, plan.telegram.messageId, text);
                  await patchPlanChannelState(planPath, {
                    telegram: { messageId: plan.telegram.messageId, chatId: plan.telegram.chatId, sessionId: plan.telegram.sessionId ?? sessionId, lastUpdatedAt: Date.now() },
                  });
                } catch (err) {
                  logger.warn?.(`planning: Telegram edit failed, sending new message: ${err}`);
                  try {
                    const result = await sendMessageTg(tgToken, tgChatId, text);
                    await patchPlanChannelState(planPath, {
                      telegram: { messageId: result.messageId, chatId: result.chatId, lastUpdatedAt: Date.now(), sessionId: effectiveSessionId },
                    });
                  } catch (sendErr) {
                    logger.warn?.(`planning: Telegram send also failed: ${sendErr}`);
                  }
                }
              } else {
                try {
                  const result = await sendMessageTg(tgToken, tgChatId, text);
                  await patchPlanChannelState(planPath, {
                    telegram: { messageId: result.messageId, chatId: result.chatId, lastUpdatedAt: Date.now(), sessionId: effectiveSessionId },
                  });
                } catch (err) {
                  logger.warn?.(`planning: Telegram send failed: ${err}`);
                }
              }
              channelNotificationSent = true;
            }

            // ── Result summary ──────────────────────────────────────────────
            // Re-read from disk since patchPlanChannelState may have updated channel state
            const latestPlan = await readPlan(planPath);
            const allPlans = delegation
              ? await readAllPlansFromDir(effectivePlanDir)
              : await readAllPlans(agentDir, sessionId);
            const activePlans = allPlans.filter((p) => isPlanActive(p));

            const completed = plan.items.filter((i) => i.status === "completed").length;
            const total = plan.items.length;
            const allDone = completed === total && total > 0;
            let resultText = `Plan "${plan.title}" updated: ${completed}/${total} completed`;
            if (allDone) resultText += " ✓ All tasks done!";
            if (activePlans.length > 1) {
              resultText += ` (${activePlans.length} active plans total)`;
            }
            if (latestPlan?.feishu?.messageId) resultText += ` (feishu card: ${latestPlan.feishu.messageId})`;
            if (latestPlan?.telegram?.messageId) resultText += ` (telegram msg: ${latestPlan.telegram.messageId})`;

            // For channels without a dedicated notification (no card, no message edit),
            // include the rendered plan in the tool result so the agent can relay it.
            if (!channelNotificationSent) {
              const renderedCard = renderPlainText(plan, input.message);
              resultText += `\n\n<plan_card>\n${renderedCard}\n</plan_card>` +
                `\nThis channel has no live progress card. The user can only see your plan when you send it as a message. ` +
                `You don't need to send it after every plan_write — that would be noisy. ` +
                `Good moments to show the card: when the plan is first created, after a major milestone, and when everything is done. ` +
                `A few updates across a long task is enough to keep the user informed without flooding the chat.`;
            }

            return { content: [{ type: "text" as const, text: resultText }], details: undefined };
          },
        };
      },
      { name: "plan_write" },
    );

    // ── before_prompt_build Hook ─────────────────────────────────────────────
    api.on("before_prompt_build", async (_event: unknown, ctx: any) => {
      const sessionKey: string | undefined = ctx?.sessionKey;
      if (sessionKey) beginTurn(sessionKey);
      const sessionId: string | undefined = ctx?.sessionId;
      const agentId: string | undefined = ctx?.agentId;
      // Prefer agentDir recorded by plan_write (authoritative).
      // Fallback: workspaceDir + "agent" (runtime observation, not formal API).
      const trackedAgentDir = sessionKey ? getSessionAgentDir(sessionKey) : undefined;
      const workspaceDir: string | undefined = ctx?.workspaceDir ?? ctx?.agentDir;
      const agentDir: string | undefined =
        trackedAgentDir ?? (workspaceDir ? path.join(workspaceDir, "agent") : undefined);

      if (!sessionId || !agentDir) return {};

      const planDir = resolvePlanDir(agentDir, sessionId);

      // Keep cross-hook state up to date
      if (sessionKey) {
        setSessionMeta(sessionKey, { planDir, agentId });
      }

      // Check for plan delegation (subagent → parent plans)
      const delegation = sessionKey ? getPlanDelegation(sessionKey) : undefined;
      const allPlans = delegation
        ? await readAllPlansFromDir(delegation.parentPlanDir)
        : await readAllPlans(agentDir, sessionId);
      const activePlans = allPlans.filter((p) => isPlanActive(p));

      if (activePlans.length > 0) {
        if (agentId) setAgentActivePlan(agentId, true);
        if (sessionKey) setSessionActivePlan(sessionKey, true);

        // Apply managedStatuses BEFORE building any prompt content.
        // managedStatus lives in runtime state (set by subagent_ended) and may not be
        // written to disk yet. We apply it so both the plan reminder and the orchestration
        // directive reflect the true state.
        const effectiveParentKey = delegation?.parentSessionKey ?? sessionKey;
        if (effectiveParentKey) {
          for (const plan of activePlans) {
            for (const item of plan.items) {
              const managed = getManagedStatus(effectiveParentKey, plan.title, item.id);
              if (managed) item.status = managed;
            }
          }
        }

        const idleCount = sessionKey ? getIdleCount(sessionKey) : SPARSE_THRESHOLD;
        // Suppress stale warning when orchestrated items are actively running —
        // the agent may not call plan_write frequently since the plugin auto-manages statuses.
        const hasActiveOrchestration = activePlans.some(
          (p) => hasOrchestratedItems(p) && p.items.some((i) => i.agentTask && i.status === "in_progress"),
        );
        const stale = !hasActiveOrchestration && idleCount >= STALE_THRESHOLD;

        let reminder: string;
        if (delegation) {
          reminder = buildDelegatedPlanReminder(activePlans, stale);
          if (sessionKey) setTurnPromptState(sessionKey, "plan_reminder_delegated", true);
        } else if (idleCount < SPARSE_THRESHOLD) {
          reminder = buildPlanReminderSparse(activePlans);
          if (sessionKey) setTurnPromptState(sessionKey, "plan_reminder_sparse", true);
        } else {
          reminder = buildPlanReminder(activePlans, stale);
          if (sessionKey) setTurnPromptState(sessionKey, "plan_reminder_full", true);
        }

        // Append orchestration directive for plans with agentTask items
        const orchDirective = activePlans.some(hasOrchestratedItems)
          ? buildOrchestrationDirective(activePlans)
          : null;
        const fullContext = orchDirective ? `${reminder}\n\n${orchDirective}` : reminder;

        return { prependContext: fullContext, appendSystemContext: FOLLOW_THROUGH_RULES };
      }

      // No active plan
      if (agentId) setAgentActivePlan(agentId, false);
      if (sessionKey) setSessionActivePlan(sessionKey, false);
      if (sessionKey) setTurnPromptState(sessionKey, "plan_available", false);
      return { prependContext: buildPlanAvailable(), appendSystemContext: FOLLOW_THROUGH_RULES };
    });

    // ── before_tool_call Hook ────────────────────────────────────────────────
    // 1. Block sessions_spawn when the parent has no active plan.
    // 2. Track live metrics for orchestrated subagent tool calls.
    api.on("before_tool_call", async (event: any, ctx: any) => {
      const toolName: string = event?.toolName ?? "";
      const sessionKey: string | undefined = ctx?.sessionKey;

      // ── Live metrics: record tool start for orchestrated subagents ──
      if (sessionKey && toolName) {
        const binding = getOrchestratedBinding(sessionKey);
        if (binding) {
          recordToolStart(sessionKey, toolName, event?.params ?? event?.args);
        }
      }

      // ── Block plan_write from ALL subagents (bound or delegated) ──
      // Subagents execute tasks, they don't create or update plans.
      // The main agent (coordinator) manages all plan state.
      if (toolName === "plan_write" && sessionKey) {
        if (getOrchestratedBinding(sessionKey) || getPlanDelegation(sessionKey)) {
          logger.info?.(`planning: blocked plan_write from subagent (session ${sessionKey.slice(-8)})`);
          return {
            block: true,
            blockReason:
              "You are a sub-agent executing a specific task. Do not create or update plans — " +
              "just do the work directly. Break your task into steps mentally and execute them sequentially.",
          };
        }
      }

      // ── Plan confirmation gate ──
      // First plan_write for a NEW plan title is blocked: agent must present the
      // plan to the user and confirm scope before creating it. This prevents
      // plans that are off-target — especially important for weaker models (GPT).
      // Skip for subagents (delegated or bound) — they execute, not plan.
      // Skip for cron jobs — no human present to confirm, and the task is already
      // defined by the cron trigger prompt. Blocking just wastes a turn.
      if (toolName === "plan_write" && sessionKey) {
        const hasDelegation = !!getPlanDelegation(sessionKey);
        const hasBound = !!getOrchestratedBinding(sessionKey);
        const isCron = sessionKey.includes(":cron:");
        if (!hasDelegation && !hasBound && !isCron) {
          const params = event?.params ?? event?.args ?? {};
          const title: string = params.title ?? "";
          const items: unknown[] = params.items ?? [];
          if (title && items.length > 0 && !isPlanTitleConfirmed(sessionKey, title)) {
            // Check if a plan with this title already exists on disk (update, not new)
            const planDir = getPlanDir(sessionKey);
            if (planDir) {
              const existingPath = resolvePlanFilePath(planDir, title);
              const existing = await readPlan(existingPath);
              if (!existing) {
                // New plan — block and require confirmation
                markPlanTitleConfirmed(sessionKey, title); // Allow next attempt
                logger.info?.(`planning: plan confirmation gate — blocked new plan "${title}" (session ${sessionKey.slice(-8)})`);
                return {
                  block: true,
                  blockReason:
                    "STOP. Before creating this plan, align with the user on what they actually want. A plan written from assumptions wastes everyone's time — the goal here is to produce a plan the user will actually accept on the first try.\n\n" +
                    "Two-phase process:\n\n" +
                    "1. EXPLORE what's discoverable yourself (do NOT ask the user about these):\n" +
                    "   - File structure, existing code, configs, recent commits, docs in the repo\n" +
                    "   - Anything you can find by reading files or running read-only tools\n" +
                    "   - If the user referenced something specific (a file, a bug, a feature), go look at it first\n\n" +
                    "2. ASK the user about what you genuinely cannot know — things that live in their head:\n" +
                    "   - Goal & success criteria: what does 'done' look like? What problem is this really solving?\n" +
                    "   - Scope boundaries: what's in, what's explicitly out? How deep should this go?\n" +
                    "   - Constraints: deadlines, tools/libraries to use or avoid, style preferences, things that must not break\n" +
                    "   - Tradeoffs & preferences: when there are multiple reasonable approaches, which does the user prefer and why?\n" +
                    "   - Unknowns you surfaced during exploration: ambiguities in existing code, conflicting signals, missing context\n\n" +
                    "How to ask:\n" +
                    "- Batch ALL your questions into ONE message. Do not drip-feed questions one at a time — that's exhausting for the user.\n" +
                    "- Skip questions whose answers are obvious from context or already stated. Don't ask for confirmation of things the user already told you.\n" +
                    "- For each ambiguity, either ask directly OR state your assumption clearly so the user can correct it. Prefer asking when stakes are high (irreversible work, big scope) and assuming when stakes are low.\n" +
                    "- If the task is already crystal clear (simple, well-scoped, unambiguous), skip straight to presenting the plan — don't manufacture questions.\n\n" +
                    "After the user responds, call plan_write again with the refined plan. It will go through. If the user has ALREADY answered your questions earlier in this conversation, call plan_write again now — this gate only fires once per plan title.",
                };
              }
            }
          }
        }
      }

      // ── Coordinator mode: block execution tools when active plan exists ──
      // When a plan is active, the main agent acts as coordinator — it can only
      // plan, spawn, read, and communicate. Actual work must go through subagents.
      // This guarantees every item has a subagent → live metrics always work.
      const COORDINATOR_ALLOWED_TOOLS = new Set([
        // Planning & coordination
        "plan_write", "sessions_spawn", "sessions_yield", "sessions_send",
        "sessions_list", "sessions_history", "session_status", "subagents",
        // Read-only (agent needs to understand context before spawning)
        "read", "Glob", "Grep", "Read",
        // Communication
        "message",
        // Memory & admin
        "memory_search", "memory_get", "cron", "agents_list", "gateway",
        // Feishu read-only
        "feishu_id", "feishu_id_admin", "feishu_group_context", "feishu_app_scopes",
      ]);

      if (sessionKey && toolName && !COORDINATOR_ALLOWED_TOOLS.has(toolName)) {
        // Only enforce for main sessions (not subagents)
        if (!getPlanDelegation(sessionKey) && !getOrchestratedBinding(sessionKey)) {
          if (getSessionActivePlan(sessionKey)) {
            logger.info?.(`planning: coordinator mode blocked "${toolName}" — session ${sessionKey.slice(-8)} has active plan`);
            return {
              block: true,
              blockReason:
                "You have an active plan. As coordinator, you must delegate execution to sub-agents. " +
                "Set the next item to in_progress via plan_write, then use sessions_spawn to assign it. " +
                "Do not execute work directly — your role is to plan, dispatch, and synthesize results.",
            };
          }
        }
      }

      // ── Spawn gating ──
      if (toolName !== "sessions_spawn") return;
      if (!sessionKey) return;

      // Block subagent chains: subagents with delegation or orchestrated binding should not spawn further
      const delegation = getPlanDelegation(sessionKey);
      const orchBinding = getOrchestratedBinding(sessionKey);
      if (delegation || orchBinding) {
        logger.info?.(`planning: blocked subagent chain — session ${sessionKey.slice(-8)} is already a subagent`);
        return {
          block: true,
          blockReason:
            "You are a sub-agent. Do not spawn further sub-agents — do the work directly yourself. " +
            "If the task is too large, break it into steps and execute them sequentially.",
        };
      }

      const hasActive = getSessionActivePlan(sessionKey);
      if (hasActive) return; // Plan exists — allow spawn

      // Double-check by reading plan files (hasActivePlan may not be set on first turn)
      const planDir = getPlanDir(sessionKey);
      if (planDir) {
        const plans = await readAllPlansFromDir(planDir);
        if (plans.some((p) => isPlanActive(p))) return; // Plan exists on disk
      }

      logger.info?.(`planning: blocked sessions_spawn — no active plan in session ${sessionKey.slice(-8)}`);
      return {
        block: true,
        blockReason:
          "You must create a plan with plan_write BEFORE spawning a sub-agent. " +
          "The plan gives the user visibility into your progress and lets them cancel cleanly. " +
          "Create the plan first (break down the full task into items), then spawn.",
      };
    });

    // ── after_tool_call Hook ─────────────────────────────────────────────────
    api.on("after_tool_call", async (event: any, ctx: any) => {
      const sessionKey: string | undefined = ctx?.sessionKey;
      if (!sessionKey) return;
      const toolName: string = event?.toolName ?? ctx?.toolName ?? "";
      recordToolCall(sessionKey, toolName);
      recordTurnToolCall(sessionKey, toolName);
      // Reset close-nudge counter when agent calls plan_write (responded to nudge)
      if (toolName === "plan_write") {
        resetPlanCloseNudges(sessionKey);
      }
      // Live metrics: tool finished → show completed tool name with ✓
      const binding = getOrchestratedBinding(sessionKey);
      if (binding) {
        recordToolEnd(sessionKey, toolName);
      }
    });

    // ── subagent_ended Hook ──────────────────────────────────────────────────
    // Two responsibilities:
    // 1. Orchestrated items: auto-update item status in managedStatus
    // 2. Fallback poke for non-ok outcomes (error / timeout / killed)
    api.on("subagent_ended", async (event: any, ctx: any) => {
      const parentKey: string | undefined = ctx?.requesterSessionKey;
      if (!parentKey) return;

      const outcome: string = event?.outcome ?? "ok";
      const subagentKey: string = event?.targetSessionKey ?? ctx?.childSessionKey ?? "unknown";
      const errorDetail: string = event?.error ?? "";

      // ── Orchestrated item auto-update ──────────────────────────────────
      const binding = getOrchestratedBinding(subagentKey);
      if (binding) {
        const newStatus = outcome === "ok" ? "completed" as const : "failed" as const;
        setManagedStatus(binding.parentSessionKey, binding.planTitle, binding.itemId, newStatus);
        // Clean up live metrics and binding for this subagent
        clearMetrics(subagentKey);
        deleteOrchestratedBinding(subagentKey);
        // Unregister card refresh if no more in_progress items for this specific plan
        if (!hasActiveMetricsForPlan(binding.parentSessionKey, binding.planTitle)) {
          unregisterCardRefreshTarget(binding.parentSessionKey, binding.planTitle);
        }
        logger.info?.(
          `planning: orchestrated item "${binding.itemId}" in "${binding.planTitle}" → ${newStatus} ` +
          `(subagent ${subagentKey.slice(-8)}, outcome=${outcome})`
        );

        // For failed items, poke parent with error details so it can decide what to do
        if (outcome !== "ok") {
          const enqueue = (api as any).runtime?.system?.enqueueSystemEvent?.bind(
            (api as any).runtime?.system,
          );
          if (enqueue) {
            const msg =
              `[planning] Subagent for item "${binding.itemId}" failed (outcome=${outcome}).` +
              (errorDetail ? ` Error: ${errorDetail}` : "") +
              ` Decide: retry (spawn a new subagent for this item), skip (mark as failed in plan_write), or abort.`;
            enqueue(msg, { sessionKey: parentKey });
          }
        }
        // Success case: announce mechanism will trigger a new main agent turn,
        // and before_prompt_build will inject orchestration directive with newly unblocked items.
        return;
      }

      // ── Non-orchestrated fallback poke (existing behavior) ─────────────
      // Clean up delegation state regardless of outcome
      deletePlanDelegation(subagentKey);

      if (outcome === "ok") return; // Announce will handle it

      const planDir = getPlanDir(parentKey);
      if (!planDir) return;

      setTimeout(async () => {
        try {
          const plans = await readAllPlansFromDir(planDir);
          if (!plans.some((p) => isPlanActive(p))) return;

          const msg =
            `[planning] Subagent ${subagentKey.slice(0, 8)} ended with outcome="${outcome}". ` +
            `Review result and update plan status accordingly.`;

          const enqueue = (api as any).runtime?.system?.enqueueSystemEvent?.bind(
            (api as any).runtime?.system,
          );
          if (enqueue) {
            enqueue(msg, { sessionKey: parentKey });
            logger.info?.(`planning: poked parent session ${parentKey.slice(-8)} after subagent ${outcome}`);
          } else {
            logger.warn?.("planning: enqueueSystemEvent not available, cannot poke parent");
          }
        } catch (err) {
          logger.warn?.(`planning: subagent_ended poke failed: ${err}`);
        }
      }, SUBAGENT_POKE_DELAY_MS);
    });

    // ── subagent_spawned Hook ────────────────────────────────────────────────
    // Two paths:
    // 1. Orchestrated: label matches a plan item ID → bind child↔item, skip delegation
    // 2. Non-orchestrated (existing): establish plan delegation for manual subagent plan updates
    api.on("subagent_spawned", async (event: any, ctx: any) => {
      const childSessionKey: string | undefined = event?.childSessionKey;
      const parentSessionKey: string | undefined = ctx?.requesterSessionKey;
      if (!childSessionKey || !parentSessionKey) return;

      const parentPlanDir = getPlanDir(parentSessionKey);
      if (!parentPlanDir) return; // Parent session not tracked yet

      const parentPlans = await readAllPlansFromDir(parentPlanDir);
      if (!parentPlans.some((p) => isPlanActive(p))) return;

      // ── Check for orchestrated dispatch (label matches an item ID with agentTask) ──
      // Label format: "itemId" or "planTitle:itemId" (the latter disambiguates across concurrent plans)
      const rawLabel: string | undefined = event?.label;
      if (rawLabel) {
        const colonIdx = rawLabel.indexOf(":");
        const labelPlanTitle = colonIdx >= 0 ? rawLabel.slice(0, colonIdx) : undefined;
        const labelItemId = colonIdx >= 0 ? rawLabel.slice(colonIdx + 1) : rawLabel;

        for (const plan of parentPlans) {
          // If label includes a plan title prefix, skip non-matching plans
          if (labelPlanTitle && plan.title !== labelPlanTitle) continue;

          // Apply managedStatus to get true item status before matching
          const effectiveStatus = (item: typeof plan.items[0]) =>
            getManagedStatus(parentSessionKey, plan.title, item.id) ?? item.status;
          const matchedItem = plan.items.find(
            (item) => item.id === labelItemId && item.agentTask,
          );
          if (matchedItem) {
            // Guard: skip if item is already in_progress or terminal (prevents duplicate dispatch)
            const currentStatus = effectiveStatus(matchedItem);
            if (currentStatus !== "pending") {
              logger.warn?.(
                `planning: rejected duplicate dispatch for item "${matchedItem.id}" — already ${currentStatus}`
              );
              // Do NOT fall through to delegation — this subagent should not get plan access
              return;
            }
            // Record binding: this child session handles this specific item
            setOrchestratedBinding(childSessionKey, {
              parentSessionKey,
              planTitle: plan.title,
              itemId: matchedItem.id,
            });
            // Auto-mark item as in_progress
            setManagedStatus(parentSessionKey, plan.title, matchedItem.id, "in_progress");
            // Start live metrics tracking for this subagent
            startMetricsTracking(childSessionKey);
            logger.info?.(
              `planning: orchestrated bind ${childSessionKey.slice(-8)} → ` +
              `item "${matchedItem.id}" in "${plan.title}" (parent ${parentSessionKey.slice(-8)})`
            );
            // Skip delegation — orchestrated subagents don't write to parent plan files
            return;
          }
        }
        // Label didn't match any orchestrated item — fall through to auto-bind.
        // Agents almost always write labels (just not in item-ID format),
        // so skipping auto-bind here would disable it entirely in practice.
        logger.info?.(
          `planning: spawn label "${rawLabel}" did not match any orchestrated item — trying auto-bind`
        );
      }

      {
      // ── Auto-bind: match spawn to plan item ─────────────────────────────
      // Priority 1: use recently-activated items queue (plan_write set item to in_progress)
      // Priority 2: find first unbound pending/in_progress item in plan order
      let bindPlanTitle: string | undefined;
      let bindItemId: string | undefined;

      const activated = popActivatedItem(parentSessionKey);
      if (activated) {
        const plan = parentPlans.find((p) => p.title === activated.planTitle);
        const item = plan?.items.find((i) => i.id === activated.itemId);
        const status = item ? (getManagedStatus(parentSessionKey, activated.planTitle, activated.itemId) ?? item.status) : undefined;
        if (status === "in_progress" || status === "pending") {
          bindPlanTitle = activated.planTitle;
          bindItemId = activated.itemId;
        }
      }

      // Fallback: find first unbound non-terminal item in plan order
      if (!bindItemId) {
        const boundItemIds = new Set<string>();
        for (const [, b] of getOrchestratedBindingsForParent(parentSessionKey)) {
          boundItemIds.add(`${b.planTitle}:${b.itemId}`);
        }
        for (const plan of parentPlans) {
          if (!isPlanActive(plan)) continue;
          for (const item of plan.items) {
            if (item.status === "completed" || item.status === "cancelled" || item.status === "failed") continue;
            const managed = getManagedStatus(parentSessionKey, plan.title, item.id);
            if (managed === "completed" || managed === "failed" || managed === "cancelled") continue;
            if (managed === "in_progress" && boundItemIds.has(`${plan.title}:${item.id}`)) continue; // already has a subagent
            bindPlanTitle = plan.title;
            bindItemId = item.id;
            break;
          }
          if (bindItemId) break;
        }
      }

      if (bindPlanTitle && bindItemId) {
        setOrchestratedBinding(childSessionKey, {
          parentSessionKey,
          planTitle: bindPlanTitle,
          itemId: bindItemId,
        });
        setManagedStatus(parentSessionKey, bindPlanTitle, bindItemId, "in_progress");
        startMetricsTracking(childSessionKey);
        logger.info?.(
          `planning: auto-bind ${childSessionKey.slice(-8)} → ` +
          `item "${bindItemId}" in "${bindPlanTitle}" (parent ${parentSessionKey.slice(-8)})`
        );
        return; // Skip delegation — bound subagents don't write to parent plan
      }
      } // close auto-bind block

      // ── Non-orchestrated: establish plan delegation (existing behavior) ──
      const parentConvId =
        getSessionConversationId(parentSessionKey) ??
        (event?.requester?.accountId ? getAccountConversationId(event.requester.accountId) : undefined);

      setPlanDelegation(childSessionKey, {
        parentPlanDir,
        parentSessionKey,
        messageChannel: event?.requester?.channel,
        agentAccountId: event?.requester?.accountId,
        conversationId: parentConvId,
      });

      logger.info?.(
        `planning: delegated plan to subagent ${childSessionKey.slice(-8)} ` +
        `from parent ${parentSessionKey.slice(-8)} ` +
        `(${parentPlans.filter((p) => isPlanActive(p)).length} active plans)`
      );
    });

    // ── message_received Hook ────────────────────────────────────────────────
    // Captures conversationId for correct card routing (group chat vs DM).
    api.on("message_received", async (_event: any, ctx: any) => {
      const conversationId: string | undefined = ctx?.conversationId;
      if (!conversationId) return;

      // Per-session (most precise — sessionKey may be available at runtime)
      const sessionKey: string | undefined = ctx?.sessionKey;
      if (sessionKey) {
        setSessionConversationId(sessionKey, conversationId);
      }

      // Per-account (fallback — always available in message hooks)
      const accountId: string | undefined = ctx?.accountId;
      if (accountId) {
        setAccountConversationId(accountId, conversationId);
      }
    });

    // ── message_sending Hook ─────────────────────────────────────────────────
    // Intercepts short standalone confirmation requests when an active plan exists.
    // Only cancels high-confidence patterns — conservative to avoid false positives.
    api.on("message_sending", async (event: any, ctx: any) => {
      const content: string = event?.content ?? "";
      // Prefer per-session check; fall back to agent-level for contexts without sessionKey
      const sessionKey: string = ctx?.sessionKey ?? "";
      const accountId: string = ctx?.accountId ?? "";
      const agentId: string = ctx?.agentId ?? accountId ?? "";
      const turn = sessionKey ? getCurrentTurn(sessionKey) : undefined;

      if (!content) return;
      if (content === "NO_REPLY") return;
      const hasActivePlanForConfirmation = sessionKey
        ? getSessionActivePlan(sessionKey)
        : (agentId ? getAgentActivePlan(agentId) : false);

      if (
        hasActivePlanForConfirmation &&
        content.length <= CONFIRMATION_MAX_LEN &&
        isUnnecessaryConfirmation(content)
      ) {
        if (sessionKey) markTurnSuppressedConfirmation(sessionKey);
        logger.info?.(`planning: blocked unnecessary confirmation from agent "${agentId}"`);
        return { cancel: true };
      }

      if (!sessionKey) {
        if (shouldLogMissingSessionKey(accountId, ctx?.conversationId)) {
          logger.info?.(
            buildPromiseGuardLog("planning.promise_guard.session_key_missing", {
              agentId,
              content,
            }),
          );
        }
        return;
      }
      if (looksLikeBlockingQuestion(content)) {
        markTurnAskedBlockingQuestion(sessionKey);
        return;
      }

      if (!shouldSuppressPromiseOnlyMessage(content, turn)) return;

      const isStreaming = event?.metadata?.streaming === true;

      logger.info?.(
        buildPromiseGuardLog("planning.promise_guard.detected", {
          sessionKey,
          agentId,
          turn,
          content,
        }),
      );

      if (PROMISE_GUARD_MODE === "observe") {
        logger.info?.(
          buildPromiseGuardLog("planning.promise_guard.observe_only", {
            sessionKey,
            agentId,
            turn,
            content,
          }),
        );
        return;
      }

      // Streaming cards are already visible to the user — cannot cancel.
      // Mark for recovery so agent_end triggers a follow-through repoke.
      if (isStreaming) {
        setSuppressedPromiseText(sessionKey, content, { streaming: true });
        logger.info?.(
          buildPromiseGuardLog("planning.promise_guard.streaming_passthrough", {
            sessionKey,
            agentId,
            turn,
            content,
          }),
        );
        return;
      }

      setSuppressedPromiseText(sessionKey, content);
      logger.info?.(
        buildPromiseGuardLog("planning.promise_guard.suppressed", {
          sessionKey,
          agentId,
          turn,
          content,
        }),
      );
      return { cancel: true };
    });

    api.on("agent_end", async (_event: any, ctx: any) => {
      const sessionKey: string | undefined = ctx?.sessionKey;
      if (!sessionKey) return;

      const finishedTurn = finishTurn(sessionKey);
      if (!finishedTurn) return;

      // ── Plan abandonment guard ─────────────────────────────────────────
      // If the agent ends its turn while an active plan has incomplete items
      // and no subagents are currently running, force it to continue.
      // This is a hard code-level enforcement that catches models (esp. GPT)
      // that ignore prompt-level instructions and stop mid-plan.
      const hasActivePlan = getSessionActivePlan(sessionKey);
      if (hasActivePlan) {
        const planDir = getPlanDir(sessionKey);
        if (planDir) {
          try {
            const plans = await readAllPlansFromDir(planDir);
            // Apply managed statuses (subagent auto-updates) to get real state
            for (const plan of plans) {
              for (const item of plan.items) {
                const managed = getManagedStatus(sessionKey, plan.title, item.id);
                if (managed) item.status = managed;
              }
            }
            // Check for completed-but-not-closed plans: all items are done
            // (via managedStatus overlay applied above) but the plan still has items
            // — the agent never called plan_write to sync final status to disk.
            const completedButNotClosed = plans.filter((p) => {
              if (p.items.length === 0) return false; // already cleared
              return p.items.every((i) => i.status === "completed" || i.status === "cancelled" || i.status === "failed");
            });
            if (completedButNotClosed.length > 0) {
              const nudgeCount = getPlanCloseNudges(sessionKey);
              if (nudgeCount < PLAN_CLOSE_MAX_NUDGES) {
                const enqueue = (api as any).runtime?.system?.enqueueSystemEvent?.bind(
                  (api as any).runtime?.system,
                );
                if (enqueue) {
                  const titles = completedButNotClosed.map((p) => `"${p.title}"`).join(", ");
                  enqueue(
                    `[planning] Your plan ${titles} is fully completed but you haven't synced the final status. ` +
                    `Call plan_write now with all items marked completed to close the plan and update the user's progress card.`,
                    { sessionKey },
                  );
                  incrementPlanCloseNudges(sessionKey);
                  logger.info?.(
                    `planning: completed-but-not-closed nudge (${nudgeCount + 1}/${PLAN_CLOSE_MAX_NUDGES}) for ${titles} (session ${sessionKey.slice(-8)})`,
                  );
                  return;
                }
              } else {
                // Give up nudging — reset counter for future plans
                resetPlanCloseNudges(sessionKey);
              }
            }

            const activePlans = plans.filter((p) => isPlanActive(p));
            if (activePlans.length > 0) {
              // If agent asked a blocking question this turn, it's legitimate to stop
              if (finishedTurn.askedBlockingQuestion) {
                resetPlanAbandonmentRepokes(sessionKey);
              } else {
              // Collect completed IDs for dependency checking
              const completedIds = new Set(
                activePlans.flatMap((p) =>
                  p.items.filter((i) => i.status === "completed").map((i) => i.id),
                ),
              );
              // Collect all items that still need work
              const pendingItems = activePlans.flatMap((p) =>
                p.items.filter((i) => i.status === "pending" || i.status === "in_progress"),
              );
              // Items the agent genuinely needs to act on:
              // - Exclude orchestrated items that are in_progress (subagent running)
              // - Exclude orchestrated pending items whose blockers aren't all completed
              //   (agent can't dispatch these yet — waiting is correct)
              const agentOwned = pendingItems.filter((i) => {
                // Orchestrated + in_progress = subagent handling it
                if (i.agentTask && i.status === "in_progress") return false;
                // Orchestrated + pending + has unresolved blockers = can't dispatch yet
                if (i.agentTask && i.status === "pending" && i.blockedBy?.length) {
                  const allResolved = i.blockedBy.every((dep) => completedIds.has(dep));
                  if (!allResolved) return false;
                }
                return true;
              });

              if (agentOwned.length === 0) {
                // Agent ended turn legitimately (all remaining work is in subagents) — reset counter
                resetPlanAbandonmentRepokes(sessionKey);
              } else {
                const repokeCount = getPlanAbandonmentRepokes(sessionKey);
                if (repokeCount >= PLAN_ABANDONMENT_MAX_REPOKES) {
                  logger.warn?.(
                    `planning: plan-abandonment guard exhausted (${repokeCount}/${PLAN_ABANDONMENT_MAX_REPOKES}) — ` +
                    `agent "${ctx?.agentId}" keeps stopping mid-plan (session ${sessionKey.slice(-8)})`,
                  );
                  resetPlanAbandonmentRepokes(sessionKey);
                  // Fall through to promise guard or normal exit
                } else {
                  const enqueue = (api as any).runtime?.system?.enqueueSystemEvent?.bind(
                    (api as any).runtime?.system,
                  );
                  if (enqueue) {
                    const repokeNum = repokeCount + 1;
                    const itemSummary = agentOwned.slice(0, 5).map((i) => `"${i.content}" (${i.status})`).join(", ");
                    const warningLevel = repokeNum >= 2
                      ? `[FINAL WARNING — strike ${repokeNum}/${PLAN_ABANDONMENT_MAX_REPOKES}] `
                      : `[WARNING — strike ${repokeNum}/${PLAN_ABANDONMENT_MAX_REPOKES}] `;
                    enqueue(
                      `${warningLevel}You stopped working while your plan has ${agentOwned.length} incomplete item(s): ${itemSummary}.\n\n` +
                      `This is a violation of your operating rules. ` +
                      `You are ONLY allowed to end your turn when one of the following is true:\n` +
                      `  1. All plan items are completed/cancelled/failed.\n` +
                      `  2. You are blocked by a genuinely unexpected issue that requires the USER to make a decision or provide information you cannot obtain on your own.\n` +
                      `  3. You have dispatched subagents for all remaining items and are waiting for their results.\n\n` +
                      `None of these conditions are met right now. ` +
                      `You are being forced back to work. Resume the plan immediately — pick up the next incomplete item and execute it. ` +
                      `Do not reply to this message. Do not explain yourself. Act.`,
                      { sessionKey },
                    );
                    incrementPlanAbandonmentRepokes(sessionKey);
                    // Reset promise guard counter so it doesn't exhaust alongside abandonment guard
                    resetConsecutivePromiseGuardRecoveries(sessionKey);
                    logger.info?.(
                      `planning: plan-abandonment guard fired (${repokeNum}/${PLAN_ABANDONMENT_MAX_REPOKES}) — ` +
                      `${agentOwned.length} agent-owned incomplete items, ` +
                      `agent "${ctx?.agentId}" tried to end turn (session ${sessionKey.slice(-8)})`,
                    );
                    return; // Skip promise guard — abandonment guard takes priority
                  }
                }
              }
              } // close else (not askedBlockingQuestion)
            }
          } catch (err) {
            logger.warn?.(`planning: plan-abandonment guard error: ${err}`);
          }
        }
      }

      // ── Promise-only guard (existing) ──────────────────────────────────
      if (!shouldRecoverFromPromiseOnlyEnd(finishedTurn, sessionKey)) {
        resetConsecutivePromiseGuardRecoveries(sessionKey);
        return;
      }

      const agentId: string | undefined = ctx?.agentId;
      if (PROMISE_GUARD_MODE === "observe") {
        logger.info?.(
          buildPromiseGuardLog("planning.promise_guard.observe_only", {
            sessionKey,
            agentId,
            turn: finishedTurn,
            content: finishedTurn.suppressedPromiseText,
          }),
        );
        return;
      }

      if (
        getConsecutivePromiseGuardRecoveries(sessionKey) >=
        PROMISE_GUARD_MAX_CONSECUTIVE_REPOKES
      ) {
        logger.info?.(
          buildPromiseGuardLog("planning.promise_guard.repoke_exhausted", {
            sessionKey,
            agentId,
            turn: finishedTurn,
            content: finishedTurn.suppressedPromiseText,
          }),
        );
        return;
      }

      try {
        const enqueue = (api as any).runtime?.system?.enqueueSystemEvent?.bind(
          (api as any).runtime?.system,
        );
        if (!enqueue) {
          logger.warn?.(
            buildPromiseGuardLog("planning.promise_guard.repoke_unavailable", {
              sessionKey,
              agentId,
              turn: finishedTurn,
              content: finishedTurn.suppressedPromiseText,
            }),
          );
          return;
        }

        const recoveryPrompt = finishedTurn.promiseWasStreaming
          ? PROMISE_GUARD_STREAMING_RECOVERY_PROMPT
          : PROMISE_GUARD_RECOVERY_PROMPT;
        enqueue(recoveryPrompt, { sessionKey });
        incrementConsecutivePromiseGuardRecoveries(sessionKey);
        logger.info?.(
          buildPromiseGuardLog("planning.promise_guard.repoke", {
            sessionKey,
            agentId,
            turn: finishedTurn,
            content: finishedTurn.suppressedPromiseText,
          }),
        );
      } catch (err) {
        logger.warn?.(
          `${buildPromiseGuardLog("planning.promise_guard.repoke_unavailable", {
            sessionKey,
            agentId,
            turn: finishedTurn,
            content: finishedTurn.suppressedPromiseText,
          })} error=${String(err)}`,
        );
      }
    });

    logger.info?.(
      "planning: plugin registered " +
      "(plan_write + before_prompt_build + after_tool_call + subagent_ended + subagent_spawned + message_received + message_sending + agent_end)"
    );
  },
};

export default plugin;
