/**
 * OpenClaw Planning Plugin
 *
 * Registered capabilities:
 *   Tool:   plan_write          — create/update structured task plans
 *   Hook:   before_prompt_build — inject plan reminder (sparse / full / stale)
 *   Hook:   after_tool_call     — maintain per-session idle counter
 *   Hook:   subagent_ended      — poke parent session when announce may be skipped
 *   Hook:   message_received    — capture conversationId for card routing
 *   Hook:   message_sending     — intercept pointless confirmation requests
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
} from "./plan-state.js";
import {
  buildPlanReminder,
  buildPlanReminderSparse,
  buildPlanAvailable,
  buildDelegatedPlanReminder,
  isPlanActive,
  renderFeishuCard,
  renderPlainText,
} from "./plan-injection.js";
import { sendCard, updateCard, normalizeTargetId } from "./feishu-client.js";
import { resolveTelegramToken, sendMessageTg, editMessageTg } from "./telegram-client.js";
import {
  recordToolCall,
  setSessionMeta,
  getIdleCount,
  getPlanDir,
  setAgentActivePlan,
  getAgentActivePlan,
  setSessionActivePlan,
  getSessionActivePlan,
  setSessionAgentDir,
  getSessionAgentDir,
  setSessionConversationId,
  getSessionConversationId,
  setAccountConversationId,
  getAccountConversationId,
  setPlanDelegation,
  getPlanDelegation,
} from "./runtime-state.js";
import type { PlanWriteInput } from "./types.js";

// ── Thresholds ──────────────────────────────────────────────────────────────
/** Below this idle count → sparse reminder (model just updated the plan). */
const SPARSE_THRESHOLD = 3;
/** At or above this idle count → full reminder + stale warning. */
const STALE_THRESHOLD = 8;
/** Delay before poking parent session after a non-ok subagent exit (ms). */
const SUBAGENT_POKE_DELAY_MS = 5_000;
/** Max content length to consider as a standalone confirmation message. */
const CONFIRMATION_MAX_LEN = 200;

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

            // Build and write plan
            // For delegated plans, preserve parent's sessionId so Feishu card PATCH works
            const effectiveSessionId = (delegation && existing?.sessionId)
              ? existing.sessionId
              : sessionId;
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

            if (channel === "feishu" && creds && notifyTarget) {
              const cardJson = renderFeishuCard(plan, input.message);
              const feishuSameSession = plan.feishu?.sessionId === effectiveSessionId;
              if (plan.feishu?.messageId && feishuSameSession) {
                try {
                  await updateCard(creds, plan.feishu.messageId, cardJson);
                  await patchPlanChannelState(planPath, {
                    feishu: { messageId: plan.feishu.messageId, targetId: plan.feishu.targetId, sessionId: plan.feishu.sessionId ?? sessionId, lastUpdatedAt: Date.now() },
                  });
                } catch (err) {
                  logger.warn?.(`planning: PATCH failed, sending new card: ${err}`);
                  try {
                    const result = await sendCard(creds, notifyTarget, cardJson);
                    await patchPlanChannelState(planPath, {
                      feishu: { messageId: result.messageId, targetId: notifyTarget, lastUpdatedAt: Date.now(), sessionId: effectiveSessionId },
                    });
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
                `\nNo dedicated progress card was sent on this channel. ` +
                `Include the <plan_card> above in your next reply to the user — ` +
                `output it verbatim as a progress update, then continue with your own message below it.`;
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

        const idleCount = sessionKey ? getIdleCount(sessionKey) : SPARSE_THRESHOLD;
        const stale = idleCount >= STALE_THRESHOLD;

        let reminder: string;
        if (delegation) {
          // Delegated subagent — show parent's plans with delegation instructions
          reminder = buildDelegatedPlanReminder(activePlans, stale);
        } else if (idleCount < SPARSE_THRESHOLD) {
          // Just updated — short reminder to save tokens
          reminder = buildPlanReminderSparse(activePlans);
        } else {
          // Normal or stale — full reminder
          reminder = buildPlanReminder(activePlans, stale);
        }

        return { prependContext: reminder };
      }

      // No active plan
      if (agentId) setAgentActivePlan(agentId, false);
      if (sessionKey) setSessionActivePlan(sessionKey, false);
      return { prependContext: buildPlanAvailable() };
    });

    // ── before_tool_call Hook ────────────────────────────────────────────────
    // Block sessions_spawn when the parent has no active plan. Forces the agent
    // to create a plan first, ensuring the plugin can inject plan context,
    // enable delegation, and allow the user to cancel/track via the card.
    api.on("before_tool_call", async (event: any, ctx: any) => {
      const toolName: string = event?.toolName ?? "";
      if (toolName !== "sessions_spawn") return;

      const sessionKey: string | undefined = ctx?.sessionKey;
      if (!sessionKey) return;

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
    });

    // ── subagent_ended Hook ──────────────────────────────────────────────────
    // Only fires a fallback poke for non-ok outcomes (error / timeout / killed).
    // Normal successful subagent completions are handled by the announce mechanism.
    api.on("subagent_ended", async (event: any, ctx: any) => {
      const parentKey: string | undefined = ctx?.requesterSessionKey;
      if (!parentKey) return;

      const outcome: string = event?.outcome ?? "ok";
      if (outcome === "ok") return; // Announce will handle it

      const subagentKey: string = event?.targetSessionKey ?? ctx?.childSessionKey ?? "unknown";
      const planDir = getPlanDir(parentKey);
      if (!planDir) return; // Parent session not seen yet, skip

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
    // Establishes plan delegation: subagent writes to parent's plan files so the
    // user sees real-time progress on the parent's Feishu/Telegram card.
    api.on("subagent_spawned", async (event: any, ctx: any) => {
      const childSessionKey: string | undefined = event?.childSessionKey;
      const parentSessionKey: string | undefined = ctx?.requesterSessionKey;
      if (!childSessionKey || !parentSessionKey) return;

      const parentPlanDir = getPlanDir(parentSessionKey);
      if (!parentPlanDir) return; // Parent session not tracked yet

      // Only delegate if parent has active plans
      const parentPlans = await readAllPlansFromDir(parentPlanDir);
      if (!parentPlans.some((p) => isPlanActive(p))) return;

      // Propagate channel context from parent so subagent's plan_write can send cards
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

      if (!content) return;
      const hasActivePlan = sessionKey
        ? getSessionActivePlan(sessionKey)
        : (accountId ? getAgentActivePlan(accountId) : false);
      if (!hasActivePlan) return; // No active plan — don't interfere
      if (content.length > CONFIRMATION_MAX_LEN) return; // Long message likely has real value

      if (isUnnecessaryConfirmation(content)) {
        logger.info?.(`planning: blocked unnecessary confirmation from agent "${accountId}"`);
        return { cancel: true };
      }
    });

    logger.info?.(
      "planning: plugin registered " +
      "(plan_write + before_prompt_build + after_tool_call + subagent_ended + subagent_spawned + message_received + message_sending)"
    );
  },
};

export default plugin;
