/**
 * Planning Plugin - Type Definitions
 */

export type PlanStatus = "pending" | "in_progress" | "completed" | "cancelled" | "failed";

export interface PlanItem {
  id: string;
  content: string;
  status: PlanStatus;
  activeForm?: string;
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
    id: string;
    content: string;
    status: PlanStatus;
    activeForm?: string;
  }>;
  message?: string;
}

export interface PlanRenderer {
  render(plan: PlanFile, message?: string): Promise<void>;
}
