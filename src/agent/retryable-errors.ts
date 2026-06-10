const KNOWN_RUNTIME_ERROR_PREFIX_PATTERN = /^(?:agent 失败|agent failed|⚠️ agent 失败|(?:claude|codex) exited with code \d+)[:：]\s*/;
const HTTP_429_TOKEN_PATTERN = /(?<![\p{L}\p{N}_-])429(?![\p{L}\p{N}_-])/u;

export function isRetryableUpstreamRateLimitError(message: string | undefined): boolean {
  if (!message) return false;
  const compact = message.replace(/\s+/g, ' ').trim();
  const apiErrorContext = compact.replace(KNOWN_RUNTIME_ERROR_PREFIX_PATTERN, '');
  if (!apiErrorContext.startsWith('API Error:')) return false;
  return HTTP_429_TOKEN_PATTERN.test(apiErrorContext) || apiErrorContext.includes('Too Many Requests');
}
