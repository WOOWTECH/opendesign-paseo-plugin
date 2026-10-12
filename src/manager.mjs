import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeError, privateDirectory, processIdentity } from '../vendor/pi-paseo/src/state.mjs';
import { readRecord, writeRecord, withLock } from '../vendor/pi-paseo/src/onboarding.mjs';
import { runtimeContext, providers, safeError } from './runtime-context.mjs';
import { publicStatus, publicModels, publicChat, publicAcceptance, redactText } from './public-dto.mjs';
import { ensureNativeOnboarding, completeNativeOnboarding, onboardingRecord, publicOnboarding } from './onboarding.mjs';
import { callRuntime } from './runtime-client.mjs';
import { createAuthFlow } from './auth-flow.mjs';
import { startOwnedSupervisor, stopOwnedSupervisor } from './owned-supervisor.mjs';

export { OnboardingNotStarted } from './onboarding.mjs';

function publicOperation(record) {
  if (!record || !['enable', 'disable', 'acceptance', 'login', 'onboarding', 'complete_onboarding', 'restore'].includes(record.action)) return null;
  const interrupted = record.status === 'running' && processIdentity(record.pid) !== record.identity;
  return { id: /^[a-f0-9-]{36}$/.test(record.id || '') ? record.id : null, action: record.action,
    status: interrupted ? 'interrupted' : ['running', 'completed', 'error'].includes(record.status) ? record.status : 'error',
    startedAt: record.startedAt || null, completedAt: record.completedAt || null, code: interrupted ? 'OPERATION_INTERRUPTED' : record.code ? safeError(record).code : null };
}

/** One instance per host. Tenant environment is passed to workers, never assigned to process.env. */
export function createManager(options, dependencies = {}) {
  const context = runtimeContext(options);
  privateDirectory(context.stateDir);
  const bridgeFile = path.join(context.stateDir, 'bridge.json');
  const lockFile = path.join(context.stateDir, 'bridge-lifecycle.lock');
  const chatsFile = path.join(context.stateDir, 'chat-agents.json');
  const callback = options.onboarding;
  const controller = new AbortController();
  const runtime = dependencies.runtime || callRuntime;
  const supervisor = dependencies.supervisor || { start: startOwnedSupervisor, stop: stopOwnedSupervisor };
  const auth = dependencies.auth || createAuthFlow(context);
  let queue = Promise.resolve(), authQueue = Promise.resolve(), disposed = false, authEpoch = 0, authOperation = null, runtimeEpoch = 0, currentMutation = null;
  const authGenerations = new Map();
  const authRequests = new Set();
  const flights = new Map();
  const saved = () => readRecord(bridgeFile);
  const patch = value => { const record = { version: 1, desiredEnabled: false, ...saved(), ...value }; writeRecord(bridgeFile, record); return record; };
  const checkSignal = signal => { if (signal?.aborted) throw new RuntimeError('OPERATION_ABORTED'); };
  const run = async (action, input = {}, signal = controller.signal) => {
    try { checkSignal(signal); const result = await runtime(context, action, input, { signal }); checkSignal(signal); return result; }
    catch (error) { throw safeError(error); }
  };
  const coalesce = (key, fn) => {
    if (flights.has(key)) return flights.get(key);
    const pending = Promise.resolve().then(fn).finally(() => { if (flights.get(key) === pending) flights.delete(key); });
    flights.set(key, pending);
    return pending;
  };
  const mutation = (action, fn, { operation = true, timeoutMs = 15000, cancellable = true } = {}) => {
    const epoch = runtimeEpoch;
    const pending = queue.then(async () => {
      if (disposed) throw new RuntimeError('SERVICE_DISPOSED');
      if (cancellable && epoch !== runtimeEpoch) throw new RuntimeError('OPERATION_ABORTED');
      const work = { controller: new AbortController(), cancellable };
      const signal = AbortSignal.any([controller.signal, work.controller.signal]);
      currentMutation = work;
      try { return await withLock(lockFile, async () => {
        checkSignal(signal);
        const record = { id: randomUUID(), action, status: 'running', pid: process.pid, identity: processIdentity(process.pid), startedAt: new Date().toISOString() };
        if (operation) patch({ operation: record });
        try {
          const result = await fn(signal);
          checkSignal(signal);
          if (operation) patch({ operation: { ...record, status: 'completed', completedAt: new Date().toISOString() }, lastError: null });
          return result;
        } catch (error) {
          const safe = safeError(error);
          if (operation) patch({ operation: { ...record, status: 'error', code: safe.code, completedAt: new Date().toISOString() }, lastError: { code: safe.code } });
          throw safe;
        }
      }, { timeoutMs, signal, helper: context.env.PI_PASEO_FLOCK_HELPER });
      } finally { if (currentMutation === work) currentMutation = null; }
    });
    queue = pending.catch(() => {});
    return pending;
  };
  const status = () => coalesce('status', async () => {
    let result;
    try { result = await run('status'); }
    catch (error) { result = { ...publicStatus(), diagnosticCode: safeError(error).code }; }
    // Worker results are explicit DTOs. Keep this boundary explicit for injected adapters too.
    const dto = publicStatus(result);
    const record = saved();
    const runtimeOperation = publicOperation(record.operation), currentAuthOperation = publicOperation(authOperation);
    const operation = runtimeOperation?.status === 'running' ? runtimeOperation : currentAuthOperation?.status === 'running' ? currentAuthOperation :
      Date.parse(currentAuthOperation?.startedAt || '') > Date.parse(runtimeOperation?.startedAt || '') ? currentAuthOperation : runtimeOperation || currentAuthOperation;
    return { ...dto, desiredEnabled: record.desiredEnabled === true,
      phase: record.desiredEnabled === false ? 'disabled' : dto.phase,
      onboarding: publicOnboarding(onboardingRecord(context)), operation, authOperation: currentAuthOperation,
      diagnosticCode: dto.diagnosticCode || (record.lastError ? safeError(record.lastError).code : null),
      login: auth.publicStatus() };
  });
  const requireEnabled = () => { if (saved().desiredEnabled !== true) throw new RuntimeError('SERVICE_DISABLED'); };
  const validateProvider = provider => { if (!providers.includes(provider)) throw new RuntimeError('INVALID_PROVIDER'); };
  const ensureOnboarding = () => mutation('onboarding', signal => ensureNativeOnboarding(context, callback, { signal }));
  const enable = () => mutation('enable', async signal => {
    patch({ desiredEnabled: true, recoveryArmed: true });
    // Start supervision first: a failed install retains intent and has bounded retries.
    await supervisor.start(context);
    await run('enable', {}, signal);
    try { await ensureNativeOnboarding(context, callback, { signal }); }
    catch { patch({ onboardingCode: 'ONBOARDING_INITIALIZATION_FAILED' }); }
    return status();
  });
  const disable = () => mutation('disable', async signal => {
    patch({ desiredEnabled: false, recoveryArmed: false });
    auth.cancel();
    await supervisor.stop(context);
    await run('disable', {}, signal);
    return status();
  }, { cancellable: false });
  const restore = () => mutation('restore', async signal => {
    if (saved().desiredEnabled === true) {
      patch({ recoveryArmed: true });
      await supervisor.start(context);
      checkSignal(signal);
      try { await ensureNativeOnboarding(context, callback, { signal }); } catch { patch({ onboardingCode: 'ONBOARDING_INITIALIZATION_FAILED' }); }
    }
    return status();
  });
  const reconcile = () => mutation('restore', async signal => {
    if (saved().desiredEnabled !== true || saved().recoveryArmed === false) return { desiredEnabled: false };
    const value = await run('status', {}, signal);
    if (!value.daemon?.owned || !value.daemon?.running || !value.daemon?.reachable) await run('enable', {}, signal);
    return { desiredEnabled: true };
  }, { operation: false, timeoutMs: 1000 });
  const models = provider => {
    validateProvider(provider);
    return coalesce('models:' + provider, async () => { requireEnabled(); return publicModels(await run('models', { provider }), context.env); });
  };
  const pair = () => mutation('pair', async signal => {
    requireEnabled();
    const offer = await run('pair', {}, signal);
    let url;
    try { url = new URL(offer.url); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
    if (url.protocol !== 'https:' || url.hostname !== 'app.paseo.sh' || url.port || url.username || url.password) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
    return { url: url.href, createdAt: offer.createdAt || new Date().toISOString() };
  }, { operation: false });
  const acceptance = (input = {}) => mutation('acceptance', async signal => {
    requireEnabled();
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['providers', 'models', 'modes', 'timeoutMs'].includes(key))) throw new RuntimeError('INVALID_ACCEPTANCE_OPTIONS');
    if (input.providers !== undefined && (!Array.isArray(input.providers) || !input.providers.length || input.providers.some(provider => !providers.includes(provider)) || new Set(input.providers).size !== input.providers.length)) throw new RuntimeError('INVALID_PROVIDER');
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 10000 || input.timeoutMs > 600000)) throw new RuntimeError('INVALID_TIMEOUT');
    return publicAcceptance(await run('acceptance', input, signal));
  });
  const login = (action, provider, input) => {
    // Accept the parent native adapter's provider-first call as well as the plan API.
    if (providers.includes(action)) [action, provider] = [provider || 'start', action];
    validateProvider(provider);
    if (disposed) return Promise.reject(new RuntimeError('SERVICE_DISPOSED'));
    if (!['start', 'status', 'guide', 'complete', 'cancel'].includes(action)) return Promise.reject(new RuntimeError('INVALID_LOGIN_ACTION'));
    if (action === 'status' || action === 'guide') return Promise.resolve().then(() => auth.login(action, provider, input)).catch(error => { throw safeError(error); });
    // OAuth callbacks use the SDK's own credential-file lock. They must not
    // wait on the daemon/acceptance lock or write that operation's journal.
    if (action === 'cancel') authGenerations.set(provider, (authGenerations.get(provider) || 0) + 1);
    const generation = authGenerations.get(provider) || 0, epoch = authEpoch;
    const execute = async () => {
      if (disposed) throw new RuntimeError('SERVICE_DISPOSED');
      if (epoch !== authEpoch || generation !== (authGenerations.get(provider) || 0)) throw new RuntimeError('OPERATION_ABORTED');
      const record = { id: randomUUID(), action: 'login', status: 'running', pid: process.pid, identity: processIdentity(process.pid), startedAt: new Date().toISOString() };
      authOperation = record;
      try {
        const result = await auth.login(action, provider, input);
        if (disposed) throw new RuntimeError('SERVICE_DISPOSED');
        if (authOperation?.id === record.id) authOperation = { ...record, status: 'completed', completedAt: new Date().toISOString() };
        return result;
      } catch (error) {
        const safe = safeError(error);
        if (authOperation?.id === record.id) authOperation = { ...record, status: 'error', code: safe.code, completedAt: new Date().toISOString() };
        throw safe;
      }
    };
    // Cancellation preempts a start/complete currently waiting on the browser.
    const pending = action === 'cancel' ? execute() : authQueue.then(execute);
    if (action !== 'cancel') authQueue = pending.catch(() => {});
    authRequests.add(pending);
    void pending.then(() => authRequests.delete(pending), () => authRequests.delete(pending));
    return pending;
  };
  const chatInput = (input, continuation = false) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RuntimeError('INVALID_CHAT_OPTIONS');
    const allowed = continuation ? ['agentId', 'message', 'timeoutMs'] : ['provider', 'model', 'mode', 'thinking', 'message', 'cwd', 'title', 'timeoutMs'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new RuntimeError('INVALID_CHAT_OPTIONS');
    if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000 || redactText(input.message, context.env) !== input.message) throw new RuntimeError('INVALID_MESSAGE');
    if (!continuation) validateProvider(input.provider);
    if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 600000)) throw new RuntimeError('INVALID_TIMEOUT');
    return input;
  };
  const createChat = (input = {}) => mutation('createchat', async signal => {
    requireEnabled(); chatInput(input);
    const value = publicChat(await run('createchat', input, signal), context.env);
    if (value.agentId) {
      const record = readRecord(chatsFile);
      writeRecord(chatsFile, { ...record, [value.agentId]: { provider: value.provider, createdAt: new Date().toISOString() } });
    }
    return value;
  }, { operation: false });
  const continueChat = (input = {}) => mutation('continue', async signal => {
    requireEnabled(); chatInput(input, true);
    if (typeof input.agentId !== 'string' || !Object.hasOwn(readRecord(chatsFile), input.agentId)) throw new RuntimeError('AGENT_NOT_OWNED');
    return publicChat(await run('continue', input, signal), context.env);
  }, { operation: false });
  let shutdownPromise;
  const cancelQueuedOperations = () => {
    runtimeEpoch++; authEpoch++;
    if (currentMutation?.cancellable) currentMutation.controller.abort();
    auth.cancel();
  };
  const cancelPending = () => { disposed = true; runtimeEpoch++; authEpoch++; controller.abort(); auth.dispose(); };
  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    cancelPending();
    shutdownPromise = Promise.allSettled([queue, ...authRequests]).then(() => withLock(lockFile, async () => {
      patch({ recoveryArmed: false });
      await supervisor.stop(context);
      // Stock deactivate clears its own intent; bridge.json remains authoritative.
      await runtime(context, 'disable', {}, {});
      return { desiredEnabled: saved().desiredEnabled === true, stopped: true };
    }, { timeoutMs: 15000, helper: context.env.PI_PASEO_FLOCK_HELPER })).catch(error => { throw safeError(error); });
    return shutdownPromise;
  };
  return Object.freeze({ status, enable, disable, models, pair, acceptance, login, ensureOnboarding, restore, reconcile, createChat, continueChat, shutdown, cancelPending, cancelQueuedOperations,
    completeOnboarding: () => mutation('complete_onboarding', () => completeNativeOnboarding(context, callback)),
    dispose: shutdown });
}
