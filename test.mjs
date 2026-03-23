/**
 * Planning Plugin - Quick Verification Script
 *
 * Tests pure functions without needing a running gateway.
 * Run: node test.mjs
 */

// ── Inline the logic we want to test (no TS compilation needed) ──────────────

const STATUS_SYMBOL = {
  completed: "●", in_progress: "◉", pending: "○", cancelled: "✕", failed: "✗",
};

function formatItemText(item) {
  const sym = STATUS_SYMBOL[item.status];
  switch (item.status) {
    case "completed": return `${sym} [done] ${item.content}`;
    case "in_progress": return `${sym} [active] ${item.content}${item.activeForm ? ` — ${item.activeForm}` : ""}`;
    case "cancelled": return `${sym} [cancelled] ${item.content}`;
    case "failed": return `${sym} [failed] ${item.content}`;
    default: return `${sym} ${item.content}`;
  }
}

function textProgressBar(completed, total) {
  const BAR = 8;
  const filled = total > 0 ? Math.round((completed / total) * BAR) : 0;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return `${"█".repeat(filled)}${"░".repeat(BAR - filled)} ${completed}/${total} (${pct}%)`;
}

function buildPlanReminder(plan, stale = false) {
  const total = plan.items.length;
  const completed = plan.items.filter(i => i.status === "completed").length;
  const inProgress = plan.items.filter(i => i.status === "in_progress");
  const itemLines = plan.items.map(formatItemText).join("\n");
  const noInProgressWarning =
    plan.items.some(i => i.status === "pending") && inProgress.length === 0
      ? "\n⚠️ No task is currently in_progress. Mark the active task in_progress before proceeding."
      : "";
  const staleWarning = stale ? "\n⚠️ plan_write hasn't been called in a while. Update task statuses now." : "";
  return `<plan_reminder>\nCurrent plan: ${plan.title}\n\n${itemLines}\n\nProgress: ${textProgressBar(completed, total)}\n${noInProgressWarning}${staleWarning}\nUpdate plan_write when you complete a step or the plan changes.\nMark items in_progress when starting, completed when done.\n</plan_reminder>`;
}

function buildPlanReminderSparse(plan) {
  const total = plan.items.length;
  const completed = plan.items.filter(i => i.status === "completed").length;
  const active = plan.items.find(i => i.status === "in_progress");
  const activeSuffix = active ? ` · now: ${active.activeForm ?? active.content}` : " · no task in_progress";
  return `<plan_reminder>\nPlan: ${plan.title} (${completed}/${total} done)${activeSuffix}\nUse plan_write to update status as you work.\n</plan_reminder>`;
}

function isUnnecessaryConfirmation(content) {
  const patterns = [
    /如果你认可/, /如果你同意/, /如果你觉得可以/,
    /要不要(我|继续)/, /你看.*行不行/, /需要我继续吗/,
    /是否继续[^？?]*[？?]\s*$/, /可以开始吗/,
    /shall I (?:proceed|continue|go ahead)/i,
    /would you like me to/i,
    /if you(?:'?d)? (?:like|want) me to/i,
    /should I (?:proceed|continue|go ahead)/i,
    /do you want me to continue/i,
  ];
  return patterns.some(p => p.test(content));
}

const PROMISE_GUARD_MAX_LEN = 240;

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

function normalizeGuardContent(content) {
  return content
    .trim()
    .replace(/^\[\[reply_to_current\]\]\s*/i, "")
    .replaceAll("’", "'")
    .replace(/\s+/g, " ");
}

function looksLikeBlockingQuestion(content) {
  const normalized = normalizeGuardContent(content);
  if (!normalized || normalized.length > PROMISE_GUARD_MAX_LEN) return false;
  if (!normalized.includes("?") && !normalized.includes("？")) return false;
  return BLOCKING_QUESTION_PATTERNS.some(pattern => pattern.test(normalized));
}

function hasCompletedResultMarkers(content) {
  return (
    content.includes("```") ||
    content.includes("\n- ") ||
    content.includes("\n1. ") ||
    /`[^`\n]+`/.test(content) ||
    content.includes("/Users/")
  );
}

function looksLikePromiseOnlyMessage(content) {
  const normalized = normalizeGuardContent(content);
  if (!normalized || normalized.length > PROMISE_GUARD_MAX_LEN) return false;
  if (hasCompletedResultMarkers(content)) return false;
  if (looksLikeBlockingQuestion(content)) return false;
  return (
    PROMISE_FUTURE_PATTERNS.some(pattern => pattern.test(normalized)) &&
    PROMISE_ACK_PATTERNS.some(pattern => pattern.test(normalized))
  );
}

// ── Mock plan ────────────────────────────────────────────────────────────────

const MOCK_PLAN = {
  version: "1",
  sessionId: "a3008e39-27bd-457b-af4c-test",
  agentId: "xinge",
  title: "Implement planning plugin",
  createdAt: Date.now() - 60000,
  updatedAt: Date.now(),
  items: [
    { id: "t1", content: "Write plan_write tool",    status: "completed",   activeForm: "Writing plan_write tool",    createdAt: 0, updatedAt: 0 },
    { id: "t2", content: "Add before_prompt_build",  status: "in_progress", activeForm: "Adding prompt injection",     createdAt: 0, updatedAt: 0 },
    { id: "t3", content: "Add subagent_ended hook",  status: "pending",     activeForm: "Adding subagent hook",       createdAt: 0, updatedAt: 0 },
    { id: "t4", content: "Add message_sending guard",status: "pending",     activeForm: "Adding message guardrail",   createdAt: 0, updatedAt: 0 },
  ],
};

const MOCK_PLAN_NO_INPROGRESS = {
  ...MOCK_PLAN,
  items: MOCK_PLAN.items.map(i => ({ ...i, status: i.status === "in_progress" ? "pending" : i.status })),
};

// ── Tests ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg ?? "assertion failed");
}

console.log("\n── Reminder rendering ──────────────────────────────────────────");

test("sparse reminder contains plan title", () => {
  const out = buildPlanReminderSparse(MOCK_PLAN);
  assert(out.includes("Implement planning plugin"), "missing title");
  assert(out.includes("1/4 done"), "missing progress");
  assert(out.includes("now: Adding prompt injection"), "missing activeForm");
  assert(out.includes("<plan_reminder>"), "missing tag");
});

test("full reminder contains all items", () => {
  const out = buildPlanReminder(MOCK_PLAN);
  assert(out.includes("[done] Write plan_write tool"), "missing completed item");
  assert(out.includes("[active] Add before_prompt_build"), "missing in_progress item");
  assert(out.includes("Add subagent_ended hook"), "missing pending item");
  assert(out.includes("1/4 (25%)"), "missing progress bar");
  assert(!out.includes("⚠️ No task"), "should not show no-in_progress warning");
});

test("full reminder with stale warning", () => {
  const out = buildPlanReminder(MOCK_PLAN, true);
  assert(out.includes("plan_write hasn't been called"), "missing stale warning");
});

test("no-in_progress warning when all pending", () => {
  const out = buildPlanReminder(MOCK_PLAN_NO_INPROGRESS);
  assert(out.includes("⚠️ No task is currently in_progress"), "missing no-in_progress warning");
});

test("progress bar correct at 0%", () => {
  const bar = textProgressBar(0, 4);
  assert(bar.includes("0/4 (0%)"), `wrong bar: ${bar}`);
  assert(!bar.includes("█"), "should have no filled blocks");
});

test("progress bar correct at 100%", () => {
  const bar = textProgressBar(4, 4);
  assert(bar.includes("4/4 (100%)"), `wrong bar: ${bar}`);
  assert(!bar.includes("░"), "should have no empty blocks");
});

console.log("\n── Confirmation detection ──────────────────────────────────────");

const SHOULD_BLOCK = [
  "如果你认可，我就继续做",
  "你看这样行不行？",
  "要不要我继续？",
  "如果你同意就开始吧",
  "需要我继续吗？",
  "Shall I proceed?",
  "Would you like me to continue?",
  "Should I go ahead with this?",
  "do you want me to continue",
];

const SHOULD_PASS = [
  "已完成分析，根因是 token 刷新竞态。",
  "修复完成，正在部署。",
  "I found the bug in feishu-client.ts at line 42.",
  "这个方案分三步：首先……其次……最后……",
  "查到了，小微群有新的 overloaded_error。",
];

for (const msg of SHOULD_BLOCK) {
  test(`blocks: "${msg.slice(0, 40)}"`, () => {
    assert(isUnnecessaryConfirmation(msg), `should have been detected as confirmation`);
  });
}

for (const msg of SHOULD_PASS) {
  test(`passes: "${msg.slice(0, 40)}"`, () => {
    assert(!isUnnecessaryConfirmation(msg), `false positive: should not be blocked`);
  });
}

console.log("\n── Promise guard predicates ────────────────────────────────────");

test("blocking question detects real scope question", () => {
  assert(looksLikeBlockingQuestion("你更想先看 To C 还是 SMB？"), "should detect blocking question");
});

test("blocking question ignores promise update", () => {
  assert(!looksLikeBlockingQuestion("收到，我先去看一下"), "false positive blocking question");
});

test("promise-only detects Chinese ack + future intent", () => {
  assert(
    looksLikePromiseOnlyMessage("收到，我接下来会先整理日本市场方向。"),
    "should detect promise-only Chinese message",
  );
});

test("promise-only detects bare Chinese future opener", () => {
  assert(looksLikePromiseOnlyMessage("我会先去整理一版。"), "should detect bare Chinese opener");
});

test("promise-only ignores structured completed result", () => {
  assert(
    !looksLikePromiseOnlyMessage("已完成，结论如下：\n- A\n- B"),
    "should not suppress structured result",
  );
});

test("promise-only detects English contraction", () => {
  assert(looksLikePromiseOnlyMessage("I’ll look into it next."), "should detect English contraction");
});

test("promise-only ignores file-path result", () => {
  assert(
    !looksLikePromiseOnlyMessage("Done. Updated `/tmp/a.ts`."),
    "should not suppress artifact-bearing result",
  );
});

console.log("\n── Plan file I/O ───────────────────────────────────────────────");

import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const TEST_DIR = join(homedir(), ".openclaw", "agents", "xinge", "agent", "plans");
const TEST_PATH = join(TEST_DIR, "testtest.plan.json");

test("write and read back plan.json", async () => {
  await mkdir(TEST_DIR, { recursive: true });
  await writeFile(TEST_PATH, JSON.stringify(MOCK_PLAN, null, 2), "utf-8");
  const raw = await readFile(TEST_PATH, "utf-8");
  const parsed = JSON.parse(raw);
  assert(parsed.title === MOCK_PLAN.title, "title mismatch after roundtrip");
  assert(parsed.items.length === 4, "wrong item count after roundtrip");
  await unlink(TEST_PATH);
});

// ── Results ──────────────────────────────────────────────────────────────────

// Wait for async test
setTimeout(() => {
  console.log(`\n── Result: ${passed} passed, ${failed} failed ──────────────────────\n`);
  if (failed > 0) process.exit(1);
}, 500);
