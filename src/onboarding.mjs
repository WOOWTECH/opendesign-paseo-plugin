import path from 'node:path';
import { RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { readRecord, writeRecord } from '../vendor/pi-paseo/src/onboarding.mjs';
import { safeError } from './runtime-context.mjs';

export const onboardingPrompt = '這是使用者已授權的 Paseo 連線初始化對話。請由 /paseo/setup 查看安裝、模型與登入狀態，並完成官方配對。沿用 Claude Code、Codex、Pi 現有登入。密碼、API Key、配對連結只輸入受保護的設定畫面，不能貼到聊天或工具。請續用本對話，不建立重複對話，不更改權限或重裝全域工具。';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const conversationIdOf = record => validId(record.conversationId) ? record.conversationId : validId(record.id) ? record.id : null;
const initialized = record => Boolean(conversationIdOf(record)) && (record.initialized === true ||
  // Completed records written before this checkpoint flag remain usable.
  (record.initialized === undefined && !record.code && !['pending', 'retryable'].includes(record.creation)));
export function onboardingUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || value.length > 2000 || /[\x00-\x20]/.test(value)) return null;
  try {
    const url = new URL(value, 'http://opendesign.invalid');
    if (url.origin !== 'http://opendesign.invalid' || url.hash || [...url.searchParams.keys()].some(key => !['conversation', 'conversationId', 'projectId'].includes(key))) return null;
    return url.pathname + url.search;
  } catch { return null; }
}
export function onboardingRecord(context) { return readRecord(path.join(context.stateDir, 'onboarding.json')); }
export function publicOnboarding(record = {}) {
  const conversationId = conversationIdOf(record), ready = initialized(record);
  return { id: conversationId, projectId: validId(record.projectId) ? record.projectId : null, conversationId, url: onboardingUrl(record.url),
    completed: record.completed === true, initialized: ready, phase: ready ? 'created' : ['pending', 'retryable'].includes(record.creation) ? record.creation : conversationId ? 'retryable' : 'not_created', code: record.code ? safeError(record).code : null };
}

export class OnboardingNotStarted extends RuntimeError { constructor() { super('ONBOARDING_NOT_STARTED'); } }

/** Caller holds the manager lifecycle lock across all checkpoints. */
export async function ensureNativeOnboarding(context, callback, { signal, timeoutMs = 30000 } = {}) {
  const file = path.join(context.stateDir, 'onboarding.json');
  let record = onboardingRecord(context);
  if (initialized(record)) return publicOnboarding(record);
  if (!callback) return publicOnboarding(record);
  if (record.creation === 'pending' && !record.projectId && !conversationIdOf(record)) throw new RuntimeError('ONBOARDING_RECONCILIATION_REQUIRED');
  record = { ...record, ...(conversationIdOf(record) ? { conversationId: conversationIdOf(record) } : {}), initialized: false, creation: 'pending', requestedAt: new Date().toISOString() };
  writeRecord(file, record);
  let accepting = true, timer;
  const remember = created => {
    if (!accepting || signal?.aborted) throw new RuntimeError('OPERATION_ABORTED');
    const input = typeof created === 'string' ? { conversationId: created } : created;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('INVALID_ONBOARDING_ID');
    const patch = {};
    for (const key of ['projectId', 'conversationId', 'id']) {
      if (input[key] === undefined) continue;
      if (!validId(input[key]) || (record[key] && record[key] !== input[key])) throw new RuntimeError('INVALID_ONBOARDING_ID');
      patch[key] = input[key];
    }
    if (patch.id) { if (record.conversationId && record.conversationId !== patch.id) throw new RuntimeError('INVALID_ONBOARDING_ID'); patch.conversationId ||= patch.id; }
    if (input.url !== undefined) { patch.url = onboardingUrl(input.url); if (!patch.url) throw new RuntimeError('INVALID_ONBOARDING_URL'); }
    if (!patch.projectId && !patch.conversationId && !patch.url) throw new RuntimeError('INVALID_ONBOARDING_ID');
    record = { ...record, ...patch, initialized: false, ...(patch.conversationId ? { creation: 'retryable', completed: false } : {}) };
    writeRecord(file, record);
  };
  let abort;
  try {
    const boundary = new Promise((_, reject) => {
      abort = () => reject(new RuntimeError('OPERATION_ABORTED'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      timer = setTimeout(() => reject(new RuntimeError('ONBOARDING_TIMEOUT')), timeoutMs);
    });
    const creation = Promise.resolve().then(() => typeof callback === 'function' ? callback(onboardingPrompt, remember, publicOnboarding(record)) : callback.ensure({ prompt: onboardingPrompt, remember, known: publicOnboarding(record), signal }));
    const created = await Promise.race([creation, boundary]);
    if (created !== undefined) remember(created);
    if (!record.conversationId) throw new RuntimeError('ONBOARDING_RECONCILIATION_REQUIRED');
    record = { ...record, initialized: true, creation: 'created', code: null, initializedAt: new Date().toISOString() };
    writeRecord(file, record);
    return publicOnboarding(record);
  } catch (error) {
    record = { ...record, initialized: false, code: 'ONBOARDING_INITIALIZATION_FAILED', ...(record.projectId || record.conversationId || error instanceof OnboardingNotStarted ? { creation: 'retryable' } : {}) };
    writeRecord(file, record);
    throw new RuntimeError('ONBOARDING_INITIALIZATION_FAILED');
  } finally { accepting = false; clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export async function completeNativeOnboarding(context, callback) {
  const record = onboardingRecord(context);
  if (!record.conversationId && !record.id) throw new RuntimeError('ONBOARDING_NOT_CREATED');
  if (typeof callback?.complete === 'function') await callback.complete(publicOnboarding(record));
  writeRecord(path.join(context.stateDir, 'onboarding.json'), { ...record, completed: true, completedAt: new Date().toISOString() });
  return publicOnboarding(onboardingRecord(context));
}
