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
  /** Current turn state for promise-only guard logic. */
  currentTurn?: TurnState;
  /** Consecutive hidden recovery pokes for this session. */
  consecutivePromiseGuardRecoveries?: number;
  /** Monotonic per-session turn counter. */
  turnSeqCounter?: number;
}

export type TurnPromptKind =
  | "unknown"
  | "plan_available"
  | "plan_reminder_sparse"
  | "plan_reminder_full"
  | "plan_reminder_delegated";

export interface TurnState {
  turnSeq: number;
  startedAt: number;
  promptKind: TurnPromptKind;
  hasActivePlanAtStart: boolean;
  planWrites: number;
  actionToolCalls: number;
  allToolCalls: string[];
  askedBlockingQuestion: boolean;
  sawSuppressedConfirmation: boolean;
  suppressedPromiseText?: string;
  /** When true, the promise-only message was delivered via streaming (not suppressed). */
  promiseWasStreaming?: boolean;
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

// ── Per-turn promise-guard state ────────────────────────────────────────────

export function beginTurn(sessionKey: string): TurnState {
  const s = getOrCreate(sessionKey);
  const turnSeq = (s.turnSeqCounter ?? 0) + 1;
  s.turnSeqCounter = turnSeq;
  s.currentTurn = {
    turnSeq,
    startedAt: Date.now(),
    promptKind: "unknown",
    hasActivePlanAtStart: false,
    planWrites: 0,
    actionToolCalls: 0,
    allToolCalls: [],
    askedBlockingQuestion: false,
    sawSuppressedConfirmation: false,
  };
  return s.currentTurn;
}

export function getCurrentTurn(sessionKey: string): TurnState | undefined {
  return sessions.get(sessionKey)?.currentTurn;
}

export function setTurnPromptState(
  sessionKey: string,
  promptKind: TurnPromptKind,
  hasActivePlan: boolean,
): void {
  const turn = getOrCreate(sessionKey).currentTurn;
  if (!turn) return;
  turn.promptKind = promptKind;
  turn.hasActivePlanAtStart = hasActivePlan;
}

export function recordTurnToolCall(sessionKey: string, toolName: string): void {
  const turn = getOrCreate(sessionKey).currentTurn;
  if (!turn) return;
  turn.allToolCalls.push(toolName);
  if (toolName === "plan_write") {
    turn.planWrites++;
    return;
  }
  if (toolName === "message") return;
  turn.actionToolCalls++;
}

export function markTurnAskedBlockingQuestion(sessionKey: string): void {
  const turn = getOrCreate(sessionKey).currentTurn;
  if (!turn) return;
  turn.askedBlockingQuestion = true;
}

export function markTurnSuppressedConfirmation(sessionKey: string): void {
  const turn = getOrCreate(sessionKey).currentTurn;
  if (!turn) return;
  turn.sawSuppressedConfirmation = true;
}

export function setSuppressedPromiseText(
  sessionKey: string,
  content: string,
  opts?: { streaming?: boolean },
): void {
  const turn = getOrCreate(sessionKey).currentTurn;
  if (!turn) return;
  turn.suppressedPromiseText = content;
  if (opts?.streaming) turn.promiseWasStreaming = true;
}

export function finishTurn(sessionKey: string): TurnState | undefined {
  const s = getOrCreate(sessionKey);
  const turn = s.currentTurn;
  s.currentTurn = undefined;
  return turn;
}

export function getConsecutivePromiseGuardRecoveries(sessionKey: string): number {
  return sessions.get(sessionKey)?.consecutivePromiseGuardRecoveries ?? 0;
}

export function incrementConsecutivePromiseGuardRecoveries(sessionKey: string): number {
  const s = getOrCreate(sessionKey);
  s.consecutivePromiseGuardRecoveries = (s.consecutivePromiseGuardRecoveries ?? 0) + 1;
  return s.consecutivePromiseGuardRecoveries;
}

export function resetConsecutivePromiseGuardRecoveries(sessionKey: string): void {
  getOrCreate(sessionKey).consecutivePromiseGuardRecoveries = 0;
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

// ── Orchestrated execution state ──
// Tracks the mapping between subagent child sessions and plan items,
// plus plugin-managed item statuses that override agent-provided statuses.

/** Maps childSessionKey → { parentSessionKey, planTitle, itemId } */
interface OrchestratedItemBinding {
  parentSessionKey: string;
  planTitle: string;
  itemId: string;
}

const orchestratedBindings = new Map<string, OrchestratedItemBinding>();

export function setOrchestratedBinding(childSessionKey: string, binding: OrchestratedItemBinding): void {
  orchestratedBindings.set(childSessionKey, binding);
}

export function getOrchestratedBinding(childSessionKey: string): OrchestratedItemBinding | undefined {
  return orchestratedBindings.get(childSessionKey);
}

/**
 * Plugin-managed item statuses. When the plugin auto-updates an item
 * (e.g. on subagent completion), the status is recorded here.
 * plan_write handler merges these, preventing agent-provided statuses
 * from overwriting plugin-managed ones.
 *
 * Key: `${parentSessionKey}:${planTitle}:${itemId}`
 */
const managedStatuses = new Map<string, import("./types.js").PlanStatus>();

function managedStatusKey(sessionKey: string, planTitle: string, itemId: string): string {
  return `${sessionKey}:${planTitle}:${itemId}`;
}

export function setManagedStatus(
  sessionKey: string,
  planTitle: string,
  itemId: string,
  status: import("./types.js").PlanStatus,
): void {
  managedStatuses.set(managedStatusKey(sessionKey, planTitle, itemId), status);
}

export function getManagedStatus(
  sessionKey: string,
  planTitle: string,
  itemId: string,
): import("./types.js").PlanStatus | undefined {
  return managedStatuses.get(managedStatusKey(sessionKey, planTitle, itemId));
}

export function deleteManagedStatus(sessionKey: string, planTitle: string, itemId: string): void {
  managedStatuses.delete(managedStatusKey(sessionKey, planTitle, itemId));
}

export function clearManagedStatuses(sessionKey: string, planTitle: string): void {
  const prefix = `${sessionKey}:${planTitle}:`;
  for (const key of managedStatuses.keys()) {
    if (key.startsWith(prefix)) managedStatuses.delete(key);
  }
}
