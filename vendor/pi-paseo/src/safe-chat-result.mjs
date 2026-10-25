import { chatResult } from './chat-result.mjs';
import { providerTurnError } from './provider-reply.mjs';

/** Never expose a failed provider turn's error, partial reply, or lastMessage. */
export async function safeChatResult(client, agentId, provider, model, timeoutMs, previousCursor = null) {
  const turn = await client.waitForFinish(agentId, timeoutMs);
  const base = { agentId, provider, model, reply: '' };
  if (turn?.status === 'timeout') return { ...base, status: 'pending' };
  if (turn?.status === 'permission') return { ...base, status: 'permission_required' };
  const code = providerTurnError(turn);
  if (code) return { ...base, status: 'error', code };
  // Reuse cursor handling without waiting twice or exposing the failed-turn object.
  const result = await chatResult({
    waitForFinish: async () => ({ status: 'idle' }),
    fetchAgentTimeline: (...args) => client.fetchAgentTimeline(...args),
  }, agentId, provider, model, timeoutMs, previousCursor);
  return result.code ? { ...result, reply: '' } : result;
}
