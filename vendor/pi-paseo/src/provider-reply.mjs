/** Categorize provider replies without retaining the message or account details. */
export function providerReplyError(text) {
  const reply = String(text || '');
  if (/you.ve hit your (?:weekly|daily|monthly|usage|rate) limit|usage limit reached|quota (?:exceeded|exhausted)|insufficient_quota/i.test(reply)) return 'PROVIDER_QUOTA_EXHAUSTED';
  if (/not logged in|please (?:log|sign) in|authentication (?:failed|required)|invalid api key|token (?:expired|revoked)/i.test(reply)) return 'PROVIDER_AUTH_REQUIRED';
  return null;
}
