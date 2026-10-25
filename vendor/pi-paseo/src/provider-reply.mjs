/** Categorize provider replies without retaining the message or account details. */
export function providerReplyError(text) {
  const reply = String(text || '');
  if (/you.ve hit your (?:weekly|daily|monthly|usage|rate) limit|usage limit reached|quota (?:exceeded|exhausted)|insufficient_quota|\bbilling_error\b|\binsufficient credits?\b|\brequires? more credits?\b|\bcredit balance (?:is )?too low\b|\bpayment required\b/i.test(reply)) return 'PROVIDER_QUOTA_EXHAUSTED';
  if (/not logged in|please (?:log|sign) in|authentication (?:failed|required)|invalid api key|token (?:expired|revoked)/i.test(reply)) return 'PROVIDER_AUTH_REQUIRED';
  return null;
}

/** SDK failed-turn messages are inspected only in memory; return fixed codes. */
export function providerTurnError(turn) {
  if (turn?.status === 'idle') return null;
  if (turn?.status === 'permission') return 'PERMISSION_REQUIRED';
  if (turn?.status === 'timeout') return 'PROVIDER_TIMEOUT';
  return providerReplyError(typeof turn?.error === 'string' ? turn.error : '') || 'PROVIDER_TURN_FAILED';
}
