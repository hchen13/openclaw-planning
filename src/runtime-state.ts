/**
 * Planning Plugin - In-Memory Runtime State
 *
 * Tracks per-session harness state across hook calls.
 * Resets on gateway restart — that's acceptable; the safe default
 * (full reminder, no idle count) kicks in automatically.
 */

interface SessionState {
  /** Tool calls since the last plan_write (0 means just updated). */
  planWriteIdleCount: number;
  /** Resolved plan directory path, populated by before_prompt_build. */
  planDir?: string;
  /** agentId for this session, populated by before_prompt_build. */
  agentId?: string;
  /** Actual agentDir used by plan_write tool (authoritative path). */
  agentDir?: string;
  /** Whether this session currently has an active plan. */
  hasActivePlan?: boolean;
  /** Conversation ID captured from message_received (for card routing). */
  conversationId?: string;
}

const MAX_SESSIONS = 1000;
const sessions = new Map<string, SessionState>();

function getOrCreate(sessionKey: string): SessionState {
  let s = sessions.get(sessionKey);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // Evict oldest 20% by creation order (FIFO, not LRU — acceptable since cap rarely hit)
      const deleteCount = Math.floor(MAX_SESSIONS * 0.2);
      const iter = sessions.keys();
      for (let i = 0; i < deleteCount; i++) {
        const key = iter.next().value;
        if (key) sessions.delete(key);
      }
    }
    s = { planWriteIdleCount: 0 };
    sessions.set(sessionKey, s);
  }
  return s;
}

/** Call from after_tool_call. */
export function recordToolCall(sessionKey: string, toolName: string): void {
  const s = getOrCreate(sessionKey);
  if (toolName === "plan_write") {
    s.planWriteIdleCount = 0;
  } else {
    s.planWriteIdleCount++;
  }
}

/** Call from before_prompt_build to keep planDir + agentId in sync. */
export function setSessionMeta(
  sessionKey: string,
  meta: { planDir?: string; agentId?: string },
): void {
  Object.assign(getOrCreate(sessionKey), meta);
}

export function getIdleCount(sessionKey: string): number {
  return sessions.get(sessionKey)?.planWriteIdleCount ?? 0;
}

export function getPlanDir(sessionKey: string): string | undefined {
  return sessions.get(sessionKey)?.planDir;
}

// ── Per-session agentDir (set by plan_write tool, read by before_prompt_build) ──

export function setSessionAgentDir(sessionKey: string, agentDir: string): void {
  getOrCreate(sessionKey).agentDir = agentDir;
}

export function getSessionAgentDir(sessionKey: string): string | undefined {
  return sessions.get(sessionKey)?.agentDir;
}

// ── Per-session active plan state (for message_sending hook) ──

export function setSessionActivePlan(sessionKey: string, active: boolean): void {
  getOrCreate(sessionKey).hasActivePlan = active;
}

export function getSessionActivePlan(sessionKey: string): boolean {
  return sessions.get(sessionKey)?.hasActivePlan ?? false;
}

// ── agentId → hasActivePlan (fallback when sessionKey unavailable) ──
// Known limitation: keyed by agentId only, so multiple sessions of the same agent
// can interfere (one session clearing the flag affects all). This is an acceptable
// degradation — the per-session check (getSessionActivePlan) is preferred and this
// only kicks in when message_sending hook context lacks sessionKey.

const agentActivePlan = new Map<string, boolean>();

export function setAgentActivePlan(agentId: string, active: boolean): void {
  agentActivePlan.set(agentId, active);
}

export function getAgentActivePlan(agentId: string): boolean {
  return agentActivePlan.get(agentId) ?? false;
}

// ── Conversation ID tracking (for card routing to group chats) ──

// Per-session (preferred — available when message hooks receive sessionKey at runtime)
export function setSessionConversationId(sessionKey: string, conversationId: string): void {
  getOrCreate(sessionKey).conversationId = conversationId;
}

export function getSessionConversationId(sessionKey: string): string | undefined {
  return sessions.get(sessionKey)?.conversationId;
}

// Per-account (fallback — always available in message hooks)
const accountConversation = new Map<string, string>();

export function setAccountConversationId(accountId: string, conversationId: string): void {
  accountConversation.set(accountId, conversationId);
}

export function getAccountConversationId(accountId: string): string | undefined {
  return accountConversation.get(accountId);
}

// ── Plan delegation (subagent → parent plan) ──
// When a subagent is spawned from a parent with active plans, the subagent
// writes to the parent's planDir instead of its own. This gives the user
// real-time visibility into subagent progress via the parent's Feishu/TG card.

export interface PlanDelegation {
  parentPlanDir: string;
  parentSessionKey: string;
  /** Channel of the original request (for card routing from subagent). */
  messageChannel?: string;
  /** Account ID of the agent (for Feishu/Telegram credential resolution). */
  agentAccountId?: string;
  /** Conversation ID (for card routing to correct chat). */
  conversationId?: string;
}

const planDelegations = new Map<string, PlanDelegation>();

export function setPlanDelegation(childSessionKey: string, delegation: PlanDelegation): void {
  planDelegations.set(childSessionKey, delegation);
}

export function getPlanDelegation(childSessionKey: string): PlanDelegation | undefined {
  return planDelegations.get(childSessionKey);
}
