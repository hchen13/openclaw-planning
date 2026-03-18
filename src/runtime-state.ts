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
  /** Resolved plan file path, populated by before_prompt_build. */
  planPath?: string;
  /** agentId for this session, populated by before_prompt_build. */
  agentId?: string;
  /** Actual agentDir used by plan_write tool (authoritative path). */
  agentDir?: string;
  /** Whether this session currently has an active plan. */
  hasActivePlan?: boolean;
}

const MAX_SESSIONS = 1000;
const sessions = new Map<string, SessionState>();

function getOrCreate(sessionKey: string): SessionState {
  let s = sessions.get(sessionKey);
  if (!s) {
    if (sessions.size >= MAX_SESSIONS) {
      // Evict oldest 20% by insertion order
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

/** Call from before_prompt_build to keep planPath + agentId in sync. */
export function setSessionMeta(
  sessionKey: string,
  meta: { planPath?: string; agentId?: string },
): void {
  Object.assign(getOrCreate(sessionKey), meta);
}

export function getIdleCount(sessionKey: string): number {
  return sessions.get(sessionKey)?.planWriteIdleCount ?? 0;
}

export function getPlanPath(sessionKey: string): string | undefined {
  return sessions.get(sessionKey)?.planPath;
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

const agentActivePlan = new Map<string, boolean>();

export function setAgentActivePlan(agentId: string, active: boolean): void {
  agentActivePlan.set(agentId, active);
}

export function getAgentActivePlan(agentId: string): boolean {
  return agentActivePlan.get(agentId) ?? false;
}
