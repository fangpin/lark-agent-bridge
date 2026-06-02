# Markdown Card Refresh Cutoff Design

## Goal

When `messageReply: "markdown"` uses a Feishu/Lark streaming markdown card for a long-running agent response, the card should stop refreshing after 10 minutes. At the cutoff, the card shows a bottom note explaining that automatic refresh has stopped, while the agent continues running in the background and the card will be updated with the final result when the run finishes.

This applies only to markdown reply mode. Interactive `messageReply: "card"` mode keeps its current streaming behavior.

## Architecture

Keep the behavior localized to `src/bot/channel.ts` in the `replyMode === 'markdown'` branch of `runAgentBatch`.

Introduce a markdown-specific refresh cutoff wrapper around `ctrl.setContent`:

- Before the cutoff, flushes call `ctrl.setContent(renderText(filterForPrefs(state)))` as they do today.
- A one-shot 10-minute timer appends the cutoff note to the latest rendered markdown and sends one final streaming update.
- After the cutoff fires, regular stream flushes become no-ops, but they still update `finalState` so the bridge continues tracking the real run state.
- The agent event stream is never interrupted by the cutoff.
- Existing final-update behavior remains authoritative: after the agent reaches a terminal state, `forceFinalCardUpdate(channel, streamMessageId, filterForPrefs(finalState), 'markdown')` updates the message with the final card.

The cutoff should not be added to `RunState` or shared renderers because it is a transport/UI refresh limit, not agent state.

## User-visible behavior

At roughly 10 minutes, the markdown card receives one bottom note:

`_已运行超过 10 分钟，飞书卡片将停止自动刷新；Agent 会继续在后台工作，完成后会更新最终结果。_`

After that note appears, intermediate progress no longer refreshes. The run remains active, `/stop` and active-run tracking still work, and the final card update still appears when the run completes, fails, or times out.

## Error handling

The cutoff note update is best-effort. If it fails or times out, log a warning and continue consuming the agent stream. A failure to show the cutoff note must not stop the agent or change the run terminal state.

The existing final-update path remains unchanged. If the final update fails, the current logging and fallback behavior continue to handle that condition.

## Testing

Add focused tests around the markdown streaming path and stream processor behavior:

- In markdown mode, after 10 minutes, the stream sends one update containing the cutoff note.
- After the cutoff fires, subsequent non-terminal agent events do not trigger regular markdown updates, while `finalState` continues to advance.
- A final terminal update is still attempted through the existing final-card update path.
- Card reply mode is unaffected by the markdown cutoff.

Run the affected Vitest files first, then `npm run typecheck` and `npm test` before completion.
