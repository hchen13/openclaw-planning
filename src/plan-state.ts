/**
 * Planning Plugin - Plan File Read/Write
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import type { PlanFile, PlanWriteInput } from "./types.js";

/**
 * Resolve the plan file path for a given agent + session.
 * Path: ~/.openclaw/agents/{agentId}/plans/{sessionId-prefix}.plan.json
 */
export function resolvePlanPath(agentDir: string, sessionId: string): string {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(agentDir, "plans", `${prefix}.plan.json`);
}

/**
 * Read an existing plan file. Returns null if not found.
 * Throws on JSON corruption or unexpected I/O errors.
 */
export async function readPlan(planPath: string): Promise<PlanFile | null> {
  try {
    const raw = await fs.readFile(planPath, "utf-8");
    return JSON.parse(raw) as PlanFile;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    if (err instanceof SyntaxError) return null; // corrupted plan file — degrade gracefully
    throw err;
  }
}

/**
 * Write a plan file atomically (tmp + rename). Creates parent directories if needed.
 */
export async function writePlan(planPath: string, plan: PlanFile): Promise<void> {
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  const tmp = planPath + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(plan, null, 2), "utf-8");
  try {
    await fs.rename(tmp, planPath);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * Build a new PlanFile from input, preserving timestamps from existing plan.
 */
export function buildPlan(
  input: PlanWriteInput,
  existing: PlanFile | null,
  ctx: { sessionId: string; agentId: string },
): PlanFile {
  const now = Date.now();
  return {
    version: "1",
    sessionId: ctx.sessionId,
    agentId: ctx.agentId,
    title: input.title,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    feishu: existing?.feishu,
    telegram: existing?.telegram,
    items: input.items.map((item) => {
      const prev = existing?.items.find((i) => i.id === item.id);
      const changed = !prev || prev.status !== item.status || prev.content !== item.content || prev.activeForm !== item.activeForm;
      return {
        ...item,
        createdAt: prev?.createdAt ?? now,
        updatedAt: changed ? now : (prev?.updatedAt ?? now),
      };
    }),
  };
}
