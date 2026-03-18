/**
 * Planning Plugin - Lightweight Telegram Bot API client
 *
 * Sends and edits messages via Telegram Bot API.
 * Does not depend on the Telegram plugin — uses raw HTTP calls.
 */

interface TelegramSendResult {
  messageId: number;
  chatId: string;
}

function botApiUrl(token: string, method: string): string {
  return `https://api.telegram.org/bot${token}/${method}`;
}

/**
 * Resolve bot token from config, with per-agent account fallback.
 */
export function resolveTelegramToken(config: any, agentAccountId?: string): string | null {
  const tg = config?.channels?.telegram;
  if (!tg) return null;
  if (agentAccountId && tg.accounts?.[agentAccountId]?.botToken) {
    return tg.accounts[agentAccountId].botToken;
  }
  return tg.botToken ?? null;
}

/**
 * Send a new text message.
 */
export async function sendMessageTg(
  token: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
  const res = await fetch(botApiUrl(token, "sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    ok: boolean;
    result?: { message_id: number; chat?: { id: number } };
    description?: string;
  };
  if (!data.ok || !data.result) {
    throw new Error(`Telegram sendMessage failed: ${data.description ?? "missing result"}`);
  }
  return {
    messageId: data.result.message_id,
    chatId: String(data.result.chat?.id ?? chatId),
  };
}

/**
 * Edit an existing message's text.
 */
export async function editMessageTg(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
): Promise<void> {
  const res = await fetch(botApiUrl(token, "editMessageText"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { ok: boolean; description?: string };
  if (!data.ok) {
    throw new Error(`Telegram editMessage failed: ${data.description ?? "unknown"}`);
  }
}
