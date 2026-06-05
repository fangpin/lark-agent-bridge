import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { log } from '../core/logger';

const COMPLETION_CHECK_MARKDOWN = '请检查';
const COMPLETION_CHECK_RECALL_MS = 12 * 60 * 60 * 1000;

export interface CompletionCheckSendOptions {
  replyTo?: string;
  replyInThread?: true;
}

export async function sendCompletionCheckMessage(
  channel: LarkChannel,
  chatId: string,
  opts?: CompletionCheckSendOptions,
): Promise<void> {
  let messageId: string | undefined;
  try {
    const sent = (await (opts
      ? channel.send(chatId, { markdown: COMPLETION_CHECK_MARKDOWN }, opts)
      : channel.send(chatId, { markdown: COMPLETION_CHECK_MARKDOWN }))) as { messageId?: string } | undefined;
    messageId = sent?.messageId;
    log.info('completion-check', 'sent', { chatId, messageId });
  } catch (err) {
    log.warn('completion-check', 'send-failed', {
      chatId,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  if (!messageId) return;
  setTimeout(() => {
    void recallCompletionCheckMessage(channel, messageId);
  }, COMPLETION_CHECK_RECALL_MS).unref();
}

async function recallCompletionCheckMessage(channel: LarkChannel, messageId: string): Promise<void> {
  try {
    await channel.rawClient.im.v1.message.delete({
      path: { message_id: messageId },
    });
    log.info('completion-check', 'recalled', { messageId });
  } catch (err) {
    log.warn('completion-check', 'recall-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
