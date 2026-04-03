/**
 * Planning Plugin - Type Definitions
 */

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled" | "failed";

export interface PlanItem {
  id: string;
  content: string;
  status: PlanStatus;
  activeForm?: string;
  /** IDs of items that must complete before this one can start. */
  blockedBy?: string[];
  /** Self-contained prompt for the subagent executing this item. */
  agentTask?: string;
  /** Runtime-only: child session key assigned by the plugin during orchestrated dispatch. */
  assignedChildSession?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlanFeishuState {
  messageId: string;
  targetId: string;
  lastUpdatedAt: number;
  sessionId?: string;
}

export interface PlanTelegramState {
  messageId: number;
  chatId: string;
  lastUpdatedAt: number;
  sessionId?: string;
}

export interface PlanFile {
  /** Reserved for future format migration. Currently always "1" and not checked at read time. */
  version: "1";
  sessionId: string;
  agentId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  feishu?: PlanFeishuState;
  telegram?: PlanTelegramState;
  items: PlanItem[];
}

export interface PlanWriteInput {
  title: string;
  items: Array<{
    id?: string;
    content: string;
    status: PlanStatus;
    activeForm?: string;
    blockedBy?: (string | number)[];
    agentTask?: string;
  }>;
  message?: string;
}

export interface PlanRenderer {
  render(plan: PlanFile, message?: string): Promise<void>;
}
