#!/usr/bin/env node
/**
 * Parent-operated acceptance. No changes without --allow-mutation.
 * Configuration/credentials and evidence stay under the private root. No CLI secrets.
 * Phases: status, models, chat, recovery. Browser import/pair/chat live in browser-acceptance.py.
 * Private acceptance-config.json:
 * { signedInProviders:['claude'], models:{claude:'...'}, modes:{claude:'...'},
 *   sdk:{clientModule:'/absolute/@getpaseo/cli/dist/utils/client.js',
 *        target:{kind:'instance',home:'/managed/paseo/home'}, cwd:'/dedicated/acceptance/workspace'},
 *   recovery:{expectedEnabled:true,expectedReady:true,expectedOnboardingId:'...',samples:3,intervalMs:2000} }
 * SDK module must be the pinned native Paseo CLI connector, never a fake bridge response.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { authorizedTargetMatches } from './acceptance-config.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assistantEntries, latestAssistantCursor } from '../vendor/pi-paseo/src/chat-result.mjs';
import { providerReplyError } from '../vendor/pi-paseo/src/provider-reply.mjs';
import { usingAcceptanceAgent } from '../vendor/pi-paseo/src/acceptance-agent.mjs';

export const PRIVATE_ROOT = process.env.OPENDESIGN_PASEO_ACCEPTANCE_PRIVATE_ROOT ?? path.join(os.homedir(), '.private', 'opendesign-paseo');
export const PROVIDERS = Object.freeze(['claude', 'codex', 'pi']);
const PHASES = ['status', 'models', 'chat', 'recovery'];
const MUTATING = new Set(['chat']);
const PLUGIN_ID = 'woowtech-paseo';
export class AcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AcceptanceError(code); };
export function safeCode(error) {
  return error instanceof AcceptanceError && /^ACCEPTANCE_[A-Z0-9_]{1,70}$/.test(error.code)
    ? error.code : 'ACCEPTANCE_FAILED';
}

export function parseArgs(argv) {
  const result = { phase: 'status', allowMutation: false, config: path.join(PRIVATE_ROOT, 'acceptance-config.json') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-mutation') result.allowMutation = true;
    else if (['--phase', '--config', '--evidence'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) result[arg.slice(2)] = argv[++i];
    else if (arg === '--help') result.help = true;
    else fail('ACCEPTANCE_INVALID_ARGUMENT');
  }
  if (!PHASES.includes(result.phase)) fail('ACCEPTANCE_INVALID_PHASE');
  if (MUTATING.has(result.phase) && !result.allowMutation) fail('ACCEPTANCE_MUTATION_NOT_ALLOWED');
  return result;
}

export function privatePath(file, root = PRIVATE_ROOT) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('ACCEPTANCE_PRIVATE_ROOT_REQUIRED');
  const resolved = path.resolve(file), relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) fail('ACCEPTANCE_PRIVATE_PATH_REQUIRED');
  let cursor = path.parse(resolved).root;
  for (const segment of resolved.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('ACCEPTANCE_UNSAFE_PATH'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

export function readPrivateJson(file, { optional = false, root = PRIVATE_ROOT } = {}) {
  const resolved = privatePath(file, root);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 1_000_000 || (stat.mode & 0o077)) fail('ACCEPTANCE_PRIVATE_FILE_PERMISSIONS');
    const value = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('ACCEPTANCE_INVALID_CONFIG');
    return value;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return {};
    if (error instanceof AcceptanceError) throw error;
    fail('ACCEPTANCE_PRIVATE_CONFIG_UNAVAILABLE');
  }
}

export function signedInProviders(config) {
  const selected = config.signedInProviders;
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(p => !PROVIDERS.includes(p))) fail('ACCEPTANCE_SIGNED_IN_PROVIDERS_REQUIRED');
  return [...selected];
}

export function targetOrigin(target) {
  let url;
  try { url = new URL(target.base); } catch { fail('ACCEPTANCE_INVALID_TARGET'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) fail('ACCEPTANCE_INVALID_TARGET');
  return url.origin;
}

export function authorizedTarget(target, config = {}) {
  if (!authorizedTargetMatches(target, config.authorizedTarget)) fail('ACCEPTANCE_AUTHORIZED_TARGET_REQUIRED');
}

/** Check every SDK write, including follow-up and cleanup, against current private declarations. */
export function guardNativeMutations(client, target, config) {
  const writes = new Set(['createWorkspace', 'createAgent', 'sendAgentMessage', 'archiveAgent']);
  return new Proxy(client, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (writes.has(key)) authorizedTarget(target, config);
        return value.apply(object, args);
      };
    },
  });
}

export async function boundedClientOperation(client, work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => { void client.close().catch(() => {}); reject(new AcceptanceError('ACCEPTANCE_NATIVE_SDK_TIMEOUT')); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// Strict allowlists, rather than redacting arbitrary daemon/auth buffers after capture.
export function statusEvidence(value) {
  const status = value?.status && typeof value.status === 'object' ? value.status : value;
  if (!status || !Array.isArray(status.providers) || !status.daemon) fail('ACCEPTANCE_STATUS_SCHEMA');
  return {
    phase: ['not_installed', 'installing', 'starting', 'running', 'stopped', 'disabled', 'error', 'restart_required'].includes(status.phase) ? status.phase : 'unknown',
    installed: status.installed === true, version: status.version === '0.11.2' ? status.version : null,
    desiredEnabled: status.desiredEnabled === true || status.enabled === true,
    ready: status.daemon.ready === true, running: status.daemon.running === true, reachable: status.daemon.reachable === true,
    providers: PROVIDERS.map(provider => {
      const row = status.providers.find(p => p.provider === provider) || {};
      return { provider, credentialPresent: row.credentialPresent === true,
        authentication: ['chat_verified', 'login_required', 'needs_chat_verification'].includes(row.authentication) ? row.authentication : 'unknown',
        status: ['ready', 'available', 'unavailable', 'unknown', 'error', 'disabled'].includes(row.status) ? row.status : 'unknown' };
    }),
  };
}

function readOnboardingId(value) {
  const status = value?.status && typeof value.status === 'object' ? value.status : value;
  return status?.onboarding?.id || status?.onboarding?.conversationId || status?.onboardingId || status?.onboardingConversationId || status?.onboardingSessionId || null;
}

export async function bridgeRead(origin, auth, action, params = {}, fetchImpl = fetch) {
  const url = new URL('/api/paseo-bridge', origin);
  url.searchParams.set('action', action);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const headers = {};
  if (typeof auth.username === 'string' && typeof auth.password === 'string') headers.Authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  else fail('ACCEPTANCE_AUTH_CONFIG_REQUIRED');
  let response;
  try { response = await fetchImpl(url, { method: 'GET', headers, redirect: 'manual', signal: AbortSignal.timeout(180000) }); }
  catch { fail('ACCEPTANCE_BRIDGE_UNREACHABLE'); }
  if (!response.ok) fail('ACCEPTANCE_BRIDGE_HTTP_FAILED');
  try {
    const body = await response.text();
    if (body.length > 2_000_000) fail('ACCEPTANCE_RESPONSE_TOO_LARGE');
    const value = JSON.parse(body);
    if (value.ok === false || value.error) fail('ACCEPTANCE_BRIDGE_REJECTED');
    return value;
  } catch (error) { if (error instanceof AcceptanceError) throw error; fail('ACCEPTANCE_BRIDGE_JSON_FAILED'); }
}

export async function openNativeClient(config) {
  const sdk = config.sdk;
  if (!sdk || !path.isAbsolute(sdk.clientModule || '') || !sdk.target || typeof sdk.target !== 'object') fail('ACCEPTANCE_NATIVE_SDK_CONFIG_REQUIRED');
  if (!sdk.clientModule.endsWith('/@getpaseo/cli/dist/utils/client.js')) fail('ACCEPTANCE_NATIVE_SDK_MODULE_REQUIRED');
  try {
    const cliPackage = path.resolve(path.dirname(sdk.clientModule), '../../package.json');
    if (JSON.parse(fs.readFileSync(cliPackage, 'utf8')).version !== '0.11.2') fail('ACCEPTANCE_NATIVE_SDK_VERSION');
    const module = await import(pathToFileURL(sdk.clientModule).href);
    if (typeof module.connectToDaemon !== 'function') fail('ACCEPTANCE_NATIVE_SDK_MODULE_REQUIRED');
    return await module.connectToDaemon({ target: sdk.target, timeout: 10000 });
  } catch (error) { if (error instanceof AcceptanceError) throw error; fail('ACCEPTANCE_NATIVE_SDK_CONNECT_FAILED'); }
}

export async function catalogEvidence(client, provider) {
  try {
    const result = await client.listProviderModels(provider);
    if (result.error || !Array.isArray(result.models)) fail('ACCEPTANCE_CATALOG_UNAVAILABLE');
    const snapshot = await client.getProvidersSnapshot();
    const entry = snapshot.entries?.find(row => row.provider === provider);
    return { provider, modelCount: result.models.length, modeCount: entry?.modes?.length || 0, passed: result.models.length > 0 };
  } catch (error) { return { provider, passed: false, code: safeCode(error) }; }
}

export async function verifyConversation(client, config, provider, { target, marker = `OD_PASEO_${randomUUID().replaceAll('-', '').slice(0, 12)}` } = {}) {
  const row = { provider, passed: false, firstReply: false, followup: false, freshCursor: false, cleanup: { archived: false } };
  const timeoutMs = Math.min(Math.max(Number(config.timeoutMs) || 180000, 1000), 600000);
  try {
    if (!signedInProviders(config).includes(provider)) fail('ACCEPTANCE_PROVIDER_NOT_SIGNED_IN');
    authorizedTarget(target, config);
    client = guardNativeMutations(client, target, config);
    const cwd = config.sdk?.cwd;
    if (!path.isAbsolute(cwd || '')) fail('ACCEPTANCE_DEDICATED_WORKSPACE_REQUIRED');
    const result = await client.listProviderModels(provider);
    if (result.error || !Array.isArray(result.models)) fail('ACCEPTANCE_CATALOG_UNAVAILABLE');
    const snapshot = await client.getProvidersSnapshot();
    const entry = snapshot.entries?.find(row => row.provider === provider);
    const model = config.models?.[provider] || result.models.find(model => model.isDefault)?.id || result.models[0]?.id;
    const modeId = config.modes?.[provider] || entry?.defaultModeId;
    if (!model || !result.models.some(item => item.id === model)) fail('ACCEPTANCE_INVALID_MODEL');
    if (!modeId || !entry?.modes?.some(mode => mode.id === modeId)) fail('ACCEPTANCE_INVALID_MODE');
    const workspace = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
    if (!workspace.workspace?.id) fail('ACCEPTANCE_WORKSPACE_FAILED');
    row.selectionConfirmed = true;
    await usingAcceptanceAgent(client, {
      provider, model, modeId, cwd, workspaceId: workspace.workspace.id,
      title: `OpenDesign Paseo acceptance ${provider} ${marker}`,
      labels: { 'opendesign-paseo-acceptance': 'true' },
      initialPrompt: `Connection acceptance only. Do not use tools or edit files. Remember ${marker}. Reply with exactly ${marker}.`,
    }, row, async agent => {
      const firstStatus = (await client.waitForFinish(agent.id, timeoutMs)).status;
      if (firstStatus !== 'idle') fail(firstStatus === 'timeout' ? 'ACCEPTANCE_PROVIDER_TIMEOUT' : firstStatus === 'permission' ? 'ACCEPTANCE_PERMISSION_REQUIRED' : 'ACCEPTANCE_FIRST_TURN_NOT_IDLE');
      const firstEntries = await assistantEntries(client, agent.id);
      const firstText = String(firstEntries.at(-1)?.item.text || '');
      const firstProblem = providerReplyError(firstText);
      if (firstProblem) fail(firstProblem === 'PROVIDER_AUTH_REQUIRED' ? 'ACCEPTANCE_PROVIDER_AUTH_REQUIRED' : 'ACCEPTANCE_PROVIDER_QUOTA_EXHAUSTED');
      row.firstReply = firstText.includes(marker);
      if (!row.firstReply) fail('ACCEPTANCE_FIRST_REPLY_UNEXPECTED');
      const previousCursor = latestAssistantCursor(firstEntries);
      if (!previousCursor) fail('ACCEPTANCE_FIRST_CURSOR_MISSING');
      await client.sendAgentMessage(agent.id, 'Which marker did I ask you to remember? Reply with that marker only. Do not use tools or edit files.');
      const secondStatus = (await client.waitForFinish(agent.id, timeoutMs)).status;
      if (secondStatus !== 'idle') fail(secondStatus === 'timeout' ? 'ACCEPTANCE_PROVIDER_TIMEOUT' : secondStatus === 'permission' ? 'ACCEPTANCE_PERMISSION_REQUIRED' : 'ACCEPTANCE_SECOND_TURN_NOT_IDLE');
      const secondEntries = await assistantEntries(client, agent.id);
      const secondText = String(secondEntries.at(-1)?.item.text || '');
      const secondProblem = providerReplyError(secondText);
      if (secondProblem) fail(secondProblem === 'PROVIDER_AUTH_REQUIRED' ? 'ACCEPTANCE_PROVIDER_AUTH_REQUIRED' : 'ACCEPTANCE_PROVIDER_QUOTA_EXHAUSTED');
      row.freshCursor = latestAssistantCursor(secondEntries) !== previousCursor && !!latestAssistantCursor(secondEntries);
      row.followup = row.freshCursor && secondText.includes(marker) && !providerReplyError(secondText);
      // Only hashes/lengths leave the SDK, never assistant messages or tokens.
      row.transcript = [firstText, secondText].map(text => ({ characters: text.length, sha256: createHash('sha256').update(text).digest('hex'), markerMatched: text.includes(marker) }));
      if (!row.followup) fail('ACCEPTANCE_FOLLOWUP_NOT_FRESH');
    });
    row.passed = row.firstReply && row.followup && row.cleanup?.archived === true;
    if (!row.cleanup?.archived) row.code = 'ACCEPTANCE_CLEANUP_FAILED';
  } catch (error) { row.code = safeCode(error); }
  // Agent IDs may appear only if generated by this invocation; never accept cleanup IDs in config.
  if (row.agentId && !/^[A-Za-z0-9_-]{1,100}$/.test(row.agentId)) delete row.agentId;
  return row;
}

export async function verifyRecovery(readStatus, config) {
  const recovery = config.recovery;
  if (!recovery || typeof recovery.expectedEnabled !== 'boolean' || typeof recovery.expectedReady !== 'boolean' || typeof recovery.expectedOnboardingId !== 'string' || !recovery.expectedOnboardingId) fail('ACCEPTANCE_RECOVERY_EXPECTATIONS_REQUIRED');
  const samples = Math.min(Math.max(Number(recovery.samples) || 3, 2), 30);
  const interval = Math.min(Math.max(Number(recovery.intervalMs) || 2000, 0), 10000);
  const observations = [];
  for (let i = 0; i < samples; i++) {
    const value = await readStatus(), row = statusEvidence(value);
    row.sameOnboarding = readOnboardingId(value) === recovery.expectedOnboardingId;
    row.passed = row.desiredEnabled === recovery.expectedEnabled && row.ready === recovery.expectedReady && row.sameOnboarding;
    if (!recovery.expectedReady) row.passed = row.passed && !row.running && !row.reachable;
    observations.push(row);
    if (i + 1 < samples) await delay(interval);
  }
  return { passed: observations.every(row => row.passed), samples: observations };
}

export function writeEvidence(file, value, root = PRIVATE_ROOT) {
  const resolved = privatePath(file, root);
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, resolved);
}

export async function main(argv = process.argv.slice(2), report = value => process.stdout.write(value)) {
  let options, evidence;
  try {
    options = parseArgs(argv);
    if (options.help) { report('Usage: node scripts/verify-deployed.mjs --phase status|models|chat|recovery [--config PRIVATE_JSON] [--evidence PRIVATE_JSON] [--allow-mutation]\n'); return 0; }
    const config = readPrivateJson(options.config, { optional: ['status', 'recovery'].includes(options.phase) });
    const target = readPrivateJson(path.join(PRIVATE_ROOT, 'target.json'));
    if (MUTATING.has(options.phase)) authorizedTarget(target, config);
    evidence = { schemaVersion: 1, harness: 'native-sdk', phase: options.phase, pluginId: PLUGIN_ID, checkedAt: new Date().toISOString(), mutationAllowed: options.allowMutation, passed: false };
    if (options.phase === 'status' || options.phase === 'recovery') {
      const auth = readPrivateJson(path.join(PRIVATE_ROOT, 'browser-auth.json'));
      const readStatus = () => bridgeRead(targetOrigin(target), auth, 'status');
      if (options.phase === 'status') { evidence.status = statusEvidence(await readStatus()); evidence.passed = true; }
      else Object.assign(evidence, await verifyRecovery(readStatus, config));
    } else {
      if (options.phase === 'chat') signedInProviders(config); // Check before opening any SDK connection.
      const client = await openNativeClient(config);
      try {
        evidence.providers = [];
        for (const provider of options.phase === 'models' ? PROVIDERS : signedInProviders(config)) {
          evidence.providers.push(await boundedClientOperation(client,
            () => options.phase === 'models' ? catalogEvidence(client, provider) : verifyConversation(client, config, provider, { target }),
            options.phase === 'models' ? 180000 : Math.min(Math.max(Number(config.timeoutMs) || 180000, 1000), 600000) * 2 + 60000));
        }
        evidence.passed = evidence.providers.length > 0 && evidence.providers.every(row => row.passed);
        if (options.phase === 'chat') {
          evidence.unverifiedProviders = PROVIDERS.filter(p => !config.signedInProviders.includes(p));
          evidence.allProvidersVerified = PROVIDERS.every(p => evidence.providers.some(row => row.provider === p && row.passed));
        }
      } finally { await client.close().catch(() => {}); }
    }
  } catch (error) {
    evidence = { ...(evidence || { schemaVersion: 1, harness: 'native-sdk', phase: PHASES.includes(options?.phase) ? options.phase : 'invalid', checkedAt: new Date().toISOString() }), passed: false, code: safeCode(error) };
  }
  try { writeEvidence(options?.evidence || path.join(PRIVATE_ROOT, 'evidence', `sdk-${evidence.phase}-${Date.now()}.json`), evidence); }
  catch { evidence = { schemaVersion: 1, passed: false, code: 'ACCEPTANCE_EVIDENCE_WRITE_FAILED' }; }
  report(JSON.stringify(evidence) + '\n');
  return evidence.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // SDK/transport debug logs are not acceptance evidence. Keep the original
  // writer only for our allowlisted report, including on SDK failures.
  const report = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write = () => true;
  delete process.env.DEBUG;
  process.exitCode = await main(process.argv.slice(2), report);
}
