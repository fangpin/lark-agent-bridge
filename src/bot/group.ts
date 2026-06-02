import type { LarkChannel } from '@larksuiteoapi/node-sdk';

export interface CreateBoundChatOptions {
  channel: LarkChannel;
  name: string;
  inviteOpenId: string;
  description?: string;
}

export interface CreatedChat {
  chatId: string;
  name: string;
}

const KNOWN_BACKEND_LABELS = new Set(['Claude', 'Codex', 'Cursor']);
const GENERIC_BACKEND_LABEL_RE = /^[A-Z][A-Za-z0-9_-]*$/;

export function backendLabel(key: string): string {
  if (key === 'claude') return 'Claude';
  if (key === 'codex') return 'Codex';
  if (key === 'cursor') return 'Cursor';
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function backendChatName(key: string, date = new Date()): string {
  const pad = (n: number): string => `${n}`.padStart(2, '0');
  return `${date.getMonth() + 1}-${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())} · ${backendLabel(key)}`;
}

export function nameWithBackend(name: string, key: string): string {
  const parts = name.split(' · ').map((part) => part.trim()).filter(Boolean);
  const isKnownLabel = (part: string): boolean => KNOWN_BACKEND_LABELS.has(part) || part === backendLabel(key);
  if (parts.length > 1 && isKnownLabel(parts[0]!)) parts.shift();
  if (parts.length > 1 && isKnownLabel(parts.at(-1)!)) parts.pop();
  if (parts.length > 1 && GENERIC_BACKEND_LABEL_RE.test(parts[0]!)) parts.shift();
  else if (parts.length > 1 && GENERIC_BACKEND_LABEL_RE.test(parts.at(-1)!)) parts.pop();
  const baseName = parts.join(' · ').trim();
  return `${baseName || 'Chat'} · ${backendLabel(key)}`;
}

export async function getChatName(channel: LarkChannel, chatId: string): Promise<string | undefined> {
  const result = await channel.rawClient.im.v1.chat.get({
    path: { chat_id: chatId },
  });
  return (result as { data?: { name?: string } }).data?.name;
}

export async function renameChatForBackend(
  channel: LarkChannel,
  chatId: string,
  currentName: string,
  key: string,
): Promise<void> {
  const resolvedName = await getChatName(channel, chatId).catch(() => undefined);
  await channel.rawClient.im.v1.chat.update({
    path: { chat_id: chatId },
    data: { name: nameWithBackend(resolvedName ?? currentName, key) },
  });
}

/**
 * Create a private group chat with the bot (as creator) and one user. Returns
 * the new chat_id. Requires `im:chat` scope on the bot.
 */
export async function createBoundChat(opts: CreateBoundChatOptions): Promise<CreatedChat> {
  const { channel, name, inviteOpenId, description } = opts;
  const result = await channel.rawClient.im.v1.chat.create({
    data: {
      name,
      description,
      chat_mode: 'group',
      chat_type: 'private',
      user_id_list: [inviteOpenId],
    },
    params: {
      user_id_type: 'open_id',
    },
  });
  const chatId = (result as { data?: { chat_id?: string } }).data?.chat_id;
  if (!chatId) {
    throw new Error(`chat.create returned no chat_id: ${JSON.stringify(result).slice(0, 200)}`);
  }
  return { chatId, name };
}

export function defaultChatName(): string {
  return backendChatName('claude');
}
