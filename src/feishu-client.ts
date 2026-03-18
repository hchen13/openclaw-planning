/**
 * Planning Plugin - Lightweight Feishu API client
 *
 * Sends and updates interactive cards via Feishu REST API.
 * Does not depend on the Feishu plugin — uses raw HTTP calls.
 */

interface FeishuCardResult {
  messageId: string;
}

interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain?: string; // "feishu" | "lark"
}

function baseUrl(domain?: string): string {
  return domain === "lark"
    ? "https://open.larksuite.com/open-apis"
    : "https://open.feishu.cn/open-apis";
}

/**
 * Per-appId token cache. Tokens are valid ~2h; refresh 1min before expiry.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getTenantToken(creds: FeishuCredentials): Promise<string> {
  const cached = tokenCache.get(creds.appId);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.token;
  }
  const url = `${baseUrl(creds.domain)}/auth/v3/tenant_access_token/internal`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Feishu token HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { tenant_access_token?: string; expire?: number; code?: number; msg?: string };
  if (!data.tenant_access_token) {
    throw new Error(`Feishu token error: ${data.msg ?? "unknown"}`);
  }
  const ttlMs = (data.expire ?? 7200) * 1000;
  tokenCache.set(creds.appId, { token: data.tenant_access_token, expiresAt: Date.now() + ttlMs });
  return data.tenant_access_token;
}

/**
 * Infer receive_id_type from targetId prefix.
 * ou_ → open_id (user), oc_ → chat_id (group), default → open_id.
 */
function resolveReceiveIdType(targetId: string): string {
  if (targetId.startsWith("oc_")) return "chat_id";
  return "open_id";
}

/**
 * Send a new interactive card message.
 */
export async function sendCard(
  creds: FeishuCredentials,
  targetId: string,
  card: Record<string, unknown>,
): Promise<FeishuCardResult> {
  const token = await getTenantToken(creds);
  const receiveIdType = resolveReceiveIdType(targetId);
  const url = `${baseUrl(creds.domain)}/im/v1/messages?receive_id_type=${receiveIdType}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      receive_id: targetId,
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Feishu send card HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { code: number; msg?: string; data?: { message_id?: string } };
  if (data.code !== 0) {
    throw new Error(`Feishu send card failed: code=${data.code} ${data.msg ?? ""}`);
  }
  const messageId = data.data?.message_id;
  if (!messageId) {
    throw new Error("Feishu send card succeeded (code=0) but returned no message_id");
  }
  return { messageId };
}

/**
 * Update (PATCH) an existing card message.
 */
export async function updateCard(
  creds: FeishuCredentials,
  messageId: string,
  card: Record<string, unknown>,
): Promise<void> {
  const token = await getTenantToken(creds);
  const url = `${baseUrl(creds.domain)}/im/v1/messages/${messageId}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      msg_type: "interactive",
      content: JSON.stringify(card),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Feishu update card HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { code: number; msg?: string };
  if (data.code !== 0) {
    throw new Error(`Feishu update card failed: code=${data.code} ${data.msg ?? ""}`);
  }
}
