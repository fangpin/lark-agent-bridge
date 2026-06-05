import type { LarkChannel, NormalizedMessage } from '@larksuiteoapi/node-sdk';
import type { ChatModeCache } from './chat-mode-cache';

/**
 * Compute the **session scope** for a message.
 *
 *  - **p2p / group**: scope = `chatId`. Replies in regular groups thread the
 *    UI but share the chat's session (matches user expectation).
 *  - **threaded/topic message**: scope = `${chatId}:${threadId}` — each topic is an
 *    independent conversation with its own session / pending queue.
 *    Workspace cwd is keyed separately by chatId so all topics in one topic
 *    group share cwd. Topic-group top-level messages (no threadId, rare) fall
 *    back to chatId.
 *
 * Async because chat mode requires an API lookup (cached after first hit).
 * Callers typically await this once at intake/cardAction entry and pass
 * the resolved scope through.
 */
export async function scopeFor(
  channel: LarkChannel,
  chatId: string,
  threadId: string | undefined,
  cache: ChatModeCache,
): Promise<string> {
  if (threadId) {
    return `${chatId}:${threadId}`;
  }
  await cache.resolve(channel, chatId);
  return chatId;
}

/** Convenience overload from a NormalizedMessage. */
export async function scopeForMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
  cache: ChatModeCache,
): Promise<string> {
  return scopeFor(channel, msg.chatId, msg.threadId, cache);
}
