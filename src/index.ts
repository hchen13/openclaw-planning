/**
 * OpenClaw Planning Plugin
 *
 * Registered capabilities:
 *   Tool:   plan_write          — create/update structured task plans
 *   Hook:   before_prompt_build — inject plan reminder (sparse / full / stale)
 *   Hook:   after_tool_call     — maintain per-session idle counter
 *   Hook:   subagent_ended      — poke parent session when announce may be skipped
 *   Hook:   message_sending     — intercept pointless confirmation requests
 */

import * as path from "path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PlanWriteSchema, PLAN_WRITE_DESCRIPTION } from "./plan-tool.js";
import { resolvePlanPath, readPlan, writePlan, buildPlan } from "./plan-state.js";
import {
  buildPlanReminder,
  buildPlanReminderSparse,
  buildPlanAvailable,
  isPlanActive,
  renderFeishuCard,
  renderPlainText,
} from "./plan-injection.js";
import { sendCard, updateCard } from "./feishu-client.js";
import { resolveTelegramToken, sendMessageTg, editMessageTg } from "./telegram-client.js";
import {
  recordToolCall,
  setSessionMeta,
  getIdleCount,
  getPlanPath,
  setAgentActivePlan,
  getAgentActivePlan,
  setSessionActivePlan,
  getSessionActivePlan,
  setSessionAgentDir,
  getSessionAgentDir,
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
            const planPath = resolvePlanPath(agentDir, sessionId);
            const existing = await readPlan(planPath);

            // Empty items → clear plan
            if (!input.items || input.items.length === 0) {
              const { unlink } = await import("fs/promises");
              try { await unlink(planPath); } catch (err: any) { if (err.code !== "ENOENT") throw err; }
              logger.info?.(`planning: plan cleared for session ${sessionId.slice(0, 8)}`);
              return { content: [{ type: "text" as const, text: "Plan cleared." }] };
            }

            // New title → treat as fresh plan (clear feishu messageId)
            const isNewPlan = existing !== null && existing.title !== input.title;
            const plan = buildPlan(input, isNewPlan ? null : existing, {
              sessionId,
              agentId: agentId ?? "unknown",
            });

            await writePlan(planPath, plan);
            logger.info?.(
              `planning: plan updated "${plan.title}" ` +
              `${plan.items.filter((i) => i.status === "completed").length}/${plan.items.length} ` +
              `for session ${sessionId.slice(0, 8)}`
            );

            // Channel progress notifications
            const channel = ctx.messageChannel;
            const senderId = ctx.requesterSenderId;

            // Feishu card
            const creds = resolveFeishuCreds(ctx.config, ctx.agentAccountId);

            if (channel === "feishu" && creds && senderId) {
              const cardJson = renderFeishuCard(plan, input.message);
              const feishuSameSession = plan.feishu?.sessionId === sessionId;
              if (plan.feishu?.messageId && feishuSameSession) {
                try {
                  await updateCard(creds, plan.feishu.messageId, cardJson);
                  plan.feishu.lastUpdatedAt = Date.now();
                  await writePlan(planPath, plan);
                } catch (err) {
                  logger.warn?.(`planning: PATCH failed, sending new card: ${err}`);
                  try {
                    const result = await sendCard(creds, senderId, cardJson);
                    plan.feishu = { messageId: result.messageId, targetId: senderId, lastUpdatedAt: Date.now(), sessionId };
                    await writePlan(planPath, plan);
                  } catch (sendErr) {
                    logger.warn?.(`planning: send card also failed: ${sendErr}`);
                  }
                }
              } else {
                try {
                  const result = await sendCard(creds, senderId, cardJson);
                  plan.feishu = { messageId: result.messageId, targetId: senderId, lastUpdatedAt: Date.now(), sessionId };
                  await writePlan(planPath, plan);
                } catch (err) {
                  logger.warn?.(`planning: send card failed: ${err}`);
                }
              }
            }

            // Telegram text message
            const tgToken = resolveTelegramToken(ctx.config, ctx.agentAccountId);
            // Use stored chatId for edits (senderId may be null on session resume after yield)
            const tgChatId = plan.telegram?.chatId ?? senderId;

            if (channel === "telegram" && tgToken && tgChatId) {
              const text = renderPlainText(plan, input.message);
              const tgSameSession = plan.telegram?.sessionId === sessionId;
              if (plan.telegram?.messageId && tgSameSession) {
                try {
                  await editMessageTg(tgToken, plan.telegram.chatId, plan.telegram.messageId, text);
                  plan.telegram.lastUpdatedAt = Date.now();
                  await writePlan(planPath, plan);
                } catch (err) {
                  logger.warn?.(`planning: Telegram edit failed, sending new message: ${err}`);
                  try {
                    const result = await sendMessageTg(tgToken, tgChatId, text);
                    plan.telegram = { messageId: result.messageId, chatId: result.chatId, lastUpdatedAt: Date.now(), sessionId };
                    await writePlan(planPath, plan);
                  } catch (sendErr) {
                    logger.warn?.(`planning: Telegram send also failed: ${sendErr}`);
                  }
                }
              } else {
                try {
                  const result = await sendMessageTg(tgToken, tgChatId, text);
                  plan.telegram = { messageId: result.messageId, chatId: result.chatId, lastUpdatedAt: Date.now(), sessionId };
                  await writePlan(planPath, plan);
                } catch (err) {
                  logger.warn?.(`planning: Telegram send failed: ${err}`);
                }
              }
            }

            const completed = plan.items.filter((i) => i.status === "completed").length;
            const total = plan.items.length;
            const allDone = completed === total && total > 0;
            let resultText = `Plan updated: "${plan.title}" — ${completed}/${total} completed`;
            if (allDone) resultText += " ✓ All tasks done!";
            if (plan.feishu?.messageId) resultText += ` (feishu card: ${plan.feishu.messageId})`;
            if (plan.telegram?.messageId) resultText += ` (telegram msg: ${plan.telegram.messageId})`;

            return { content: [{ type: "text" as const, text: resultText }] };
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
      // agentDir is not in the formal hook type — workspaceDir is the same path at runtime
      // workspaceDir = ~/.openclaw/agents/{agentId}  (the agent root)
      // agentDir     = ~/.openclaw/agents/{agentId}/agent  (the workspace subfolder, used by tools)
      // Plan files are written by plan_write using agentDir, so we must append "agent/".
      // workspaceDir = ~/.openclaw/agents/{agentId}       (agent root, from hook ctx)
      // agentDir     = ~/.openclaw/agents/{agentId}/agent  (workspace subfolder, used by tools)
      // Plan files are written by plan_write using agentDir, so append "agent/" here.
      // Prefer agentDir recorded by plan_write (authoritative).
      // Fallback: workspaceDir + "agent" (runtime observation, not formal API).
      const trackedAgentDir = sessionKey ? getSessionAgentDir(sessionKey) : undefined;
      const workspaceDir: string | undefined = ctx?.workspaceDir ?? ctx?.agentDir;
      const agentDir: string | undefined =
        trackedAgentDir ?? (workspaceDir ? path.join(workspaceDir, "agent") : undefined);

      if (!sessionId || !agentDir) return {};

      const planPath = resolvePlanPath(agentDir, sessionId);

      // Keep cross-hook state up to date
      if (sessionKey) {
        setSessionMeta(sessionKey, { planPath, agentId });
      }

      const plan = await readPlan(planPath);

      if (plan && isPlanActive(plan)) {
        if (agentId) setAgentActivePlan(agentId, true);
        if (sessionKey) setSessionActivePlan(sessionKey, true);

        const idleCount = sessionKey ? getIdleCount(sessionKey) : SPARSE_THRESHOLD;

        let reminder: string;
        if (idleCount < SPARSE_THRESHOLD) {
          // Just updated — short reminder to save tokens
          reminder = buildPlanReminderSparse(plan);
        } else if (idleCount >= STALE_THRESHOLD) {
          // Many tool calls without an update — full + stale warning
          reminder = buildPlanReminder(plan, /* stale= */ true);
        } else {
          // Normal range — full reminder
          reminder = buildPlanReminder(plan, /* stale= */ false);
        }

        return { prependContext: reminder };
      }

      // No active plan
      if (agentId) setAgentActivePlan(agentId, false);
      if (sessionKey) setSessionActivePlan(sessionKey, false);
      return { prependContext: buildPlanAvailable() };
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
      const planPath = getPlanPath(parentKey);
      if (!planPath) return; // Parent session not seen yet, skip

      setTimeout(async () => {
        try {
          const plan = await readPlan(planPath);
          if (!plan || !isPlanActive(plan)) return;

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
      "(plan_write + before_prompt_build + after_tool_call + subagent_ended + message_sending)"
    );
  },
};

export default plugin;
