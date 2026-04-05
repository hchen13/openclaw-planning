/**
 * Planning Plugin - Plan File Read/Write
 *
 * v2: Plans are stored in a per-session directory, one file per plan (keyed by title hash).
 * Legacy v1 single-file format is read for migration but new writes always use v2.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import type { PlanFile, PlanWriteInput } from "./types.js";

/**
 * Resolve the plan directory for a given agent + session.
 * Path: {agentDir}/plans/{sessionHash}/
 */
export function resolvePlanDir(agentDir: string, sessionId: string): string {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(agentDir, "plans", prefix);
}

/**
 * Resolve a specific plan file path within a session directory.
 * Plans are identified by a hash of their title.
 */
export function resolvePlanFilePath(planDir: string, title: string): string {
  const hash = createHash("sha256").update(title).digest("hex").slice(0, 12);
  return path.join(planDir, `${hash}.plan.json`);
}

/**
 * Legacy v1 plan path (single file per session).
 * Used for migration reads only.
 */
export function resolveLegacyPlanPath(agentDir: string, sessionId: string): string {
  const prefix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return path.join(agentDir, "plans", `${prefix}.plan.json`);
}

/**
 * Read an existing plan file. Returns null if not found.
 * Throws on unexpected I/O errors.
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
 * Read all plan files for a session directory.
 */
export async function readAllPlansFromDir(planDir: string): Promise<PlanFile[]> {
  const plans: PlanFile[] = [];
  try {
    const entries = await fs.readdir(planDir);
    for (const entry of entries) {
      if (!entry.endsWith(".plan.json")) continue;
      const plan = await readPlan(path.join(planDir, entry));
      if (plan) plans.push(plan);
    }
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
  return plans;
}

/**
 * Read all plans for a session (v2 directory + legacy v1 single file).
 */
export async function readAllPlans(agentDir: string, sessionId: string): Promise<PlanFile[]> {
  const planDir = resolvePlanDir(agentDir, sessionId);
  const plans = await readAllPlansFromDir(planDir);

  // Also check legacy single-file format and auto-migrate active plans
  const legacyPath = resolveLegacyPlanPath(agentDir, sessionId);
  const legacy = await readPlan(legacyPath);
  if (legacy && !plans.some((p) => p.title === legacy.title)) {
    const hasActiveItems = legacy.items.some((i) => i.status === "pending" || i.status === "in_progress");
    if (hasActiveItems) {
      // Migrate active legacy plan to v2 directory format so plan_write can update it
      const v2Path = resolvePlanFilePath(planDir, legacy.title);
      await writePlan(v2Path, legacy);
      await fs.unlink(legacyPath).catch(() => {});
    }
    plans.push(legacy);
  }

  return plans;
}

/**
 * Write a plan file atomically (tmp + rename). Creates parent directories if needed.
 */
export async function writePlan(planPath: string, plan: PlanFile): Promise<void> {
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  // Unique tmp name avoids collisions when concurrent plan_write calls target the same file
  const tmp = `${planPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(plan, null, 2), "utf-8");
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
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
    // Full replacement: items not present in input are silently dropped (by design —
    // plan_write docs say "pass ALL items every time"). New items (no prev) get fresh timestamps;
    // unchanged items preserve their original updatedAt.
    items: input.items.map((item) => {
      const prev = existing?.items.find((i) => i.id === item.id);
      const changed = !prev || prev.status !== item.status || prev.content !== item.content || prev.activeForm !== item.activeForm;
      return {
        ...item,
        id: item.id as string, // guaranteed by auto-assign in index.ts before buildPlan is called
        blockedBy: item.blockedBy as string[] | undefined, // indices resolved to strings in index.ts
        createdAt: prev?.createdAt ?? now,
        updatedAt: changed ? now : (prev?.updatedAt ?? now),
      };
    }),
  };
}

/**
 * Validate the dependency graph declared by blockedBy fields.
 * Returns null if valid, or an error message string.
 */
export function validateDependencyGraph(
  items: Array<{ id: string; blockedBy?: string[] }>,
): string | null {
  const ids = new Set(items.map((i) => i.id));

  // Check for references to non-existent items
  for (const item of items) {
    for (const dep of item.blockedBy ?? []) {
      if (!ids.has(dep)) return `Item "${item.id}" depends on unknown item "${dep}"`;
      if (dep === item.id) return `Item "${item.id}" depends on itself`;
    }
  }

  // Detect cycles via topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const item of items) {
    inDegree.set(item.id, 0);
    adj.set(item.id, []);
  }
  for (const item of items) {
    for (const dep of item.blockedBy ?? []) {
      adj.get(dep)!.push(item.id);
      inDegree.set(item.id, (inDegree.get(item.id) ?? 0) + 1);
    }
  }
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    for (const neighbor of adj.get(node) ?? []) {
      const d = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, d);
      if (d === 0) queue.push(neighbor);
    }
  }
  if (visited < items.length) return "Circular dependency detected in plan items";

  return null;
}
