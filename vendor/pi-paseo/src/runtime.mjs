import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { locations, readState, updateState, atomicJson, privateDirectory, withRuntimeLock, processIdentity, RuntimeError } from './state.mjs';
import { findExecutable, runProcess } from './process.mjs';
import { resolveProviderLaunchers, configureProviders } from './provider-launchers.mjs';
import { providerReplyError } from './provider-reply.mjs';
import { assistantEntries, latestAssistantCursor, chatResult } from './chat-result.mjs';
import {singleFlight,daemonStatusWindow} from './single-flight.mjs';
import {usingAcceptanceAgent} from './acceptance-agent.mjs';
import {runtimeDirectory,runtimeReady,prepareRuntimeManifest,markRuntimeReady,RUNTIME_REVISION} from './runtime-layout.mjs';
export { locations, readState, updateState } from './state.mjs';
export const PASEO_VERSION = '0.11.2';
const PROVIDERS = ['claude', 'codex', 'pi'];
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'RUNTIME_FAILED';
function packageRoot(pkg = 'cli') { return path.join(runtimeDirectory(locations()), 'node_modules/@getpaseo', pkg); }
function cliPath() { return path.join(packageRoot(), 'bin/paseo'); }
function runtimeVersion() { try { return JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version; } catch { return null; } }
function inheritedEnv() {
  const loc = locations(); const env = { ...process.env, HOME: loc.home, PI_CODING_AGENT_DIR: loc.agentDir, PI_AGENT_DATA_DIR: process.env.PI_AGENT_DATA_DIR || loc.agentDir, PASEO_HOME: loc.paseoHome, NO_COLOR: '1' };
  delete env.PASEO_HOST; delete env.PASEO_AGENT_ID; delete env.PASEO_WORKSPACE_ID; delete env.PASEO_PASSWORD;
  // Web login protects the host UI; provider children do not need this credential.
  delete env.PI_WEB_PASSWORD;
  env.PI_PASEO_RUNTIME_REVISION=RUNTIME_REVISION;
  return env;
}
async function cli(args, options = {}) {
  const result = await runProcess(process.execPath, [cliPath(), '--home', locations().paseoHome, '--json', ...args], { env: inheritedEnv(), ...options });
  try { return JSON.parse(result); } catch { throw new RuntimeError('INVALID_COMMAND_OUTPUT'); }
}
function ownerFile() { return path.join(locations().paseoHome, '.pi-paseo-owner.json'); }
function ensureOwnedHome() {
  const loc = locations(); const state = readState().installationId ? readState() : updateState({ phase: 'installing' });
  if (fs.existsSync(ownerFile())) {
    const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8'));
    if (marker.installationId !== state.installationId || marker.home !== loc.paseoHome) throw new RuntimeError('DAEMON_NOT_OWNED');
  } else {
    if (fs.existsSync(loc.paseoHome) && fs.readdirSync(loc.paseoHome).length) throw new RuntimeError('DAEMON_NOT_OWNED');
    privateDirectory(loc.paseoHome); atomicJson(ownerFile(), { installationId: state.installationId, home: loc.paseoHome });
  }
  return state;
}
function ownsHome() {
  try { const marker = JSON.parse(fs.readFileSync(ownerFile(), 'utf8')); return marker.installationId === readState().installationId && marker.home === locations().paseoHome; } catch { return false; }
}
function legacyVersion() {try{return JSON.parse(fs.readFileSync(path.join(locations().runtimeDir,'node_modules/@getpaseo/cli/package.json'))).version;}catch{return null;}}
async function serverModule(relative) { const root=fs.existsSync(packageRoot('server'))?packageRoot('server'):path.join(locations().runtimeDir,'node_modules/@getpaseo/server');return import(pathToFileURL(path.join(root, relative)).href); }
async function controlModule() { return serverModule('dist/server/server/daemon-instance.js'); }
async function currentInstance() { if ((runtimeVersion() !== PASEO_VERSION&&legacyVersion()!==PASEO_VERSION) || !ownsHome()) return null; return (await controlModule()).readDaemonInstance(locations().paseoHome); }
function instanceNeedsRuntimeRestart(instance) {
 if(process.platform!=='linux')return false;
 try{return !fs.readFileSync(`/proc/${instance.pid}/environ`,'utf8').split('\0').includes(`PI_PASEO_RUNTIME_REVISION=${RUNTIME_REVISION}`);}catch{return true;}
}
async function verifyInstanceOwnership(instance) {
  if (!ownsHome() || !instance || !processIdentity(instance.pid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  if (instance.uid !== (process.getuid?.() ?? instance.uid)) throw new RuntimeError('DAEMON_NOT_OWNED');
  // Linux metadata additionally checks argv and the home actually inherited by this PID.
  if (process.platform === 'linux') {
    try {
      const args = fs.readFileSync(`/proc/${instance.pid}/cmdline`, 'utf8').split('\0');
      const env = fs.readFileSync(`/proc/${instance.pid}/environ`, 'utf8').split('\0');
      const entry = path.join(packageRoot('server'), 'dist/scripts/supervisor-entrypoint.js');
      const executable = fs.realpathSync(`/proc/${instance.pid}/exe`);
      const expectedNode = fs.realpathSync(process.execPath);
      // Paseo sets process.title, which replaces its original argv on Linux.
      const supervisor = args.includes(entry) || args[0] === 'Paseo Supervisor';
      if (!supervisor || executable !== expectedNode || instance.heartbeat !== true || !env.includes(`PASEO_HOME=${locations().paseoHome}`)) throw new RuntimeError('DAEMON_NOT_OWNED');
    } catch { throw new RuntimeError('DAEMON_NOT_OWNED'); }
  }
}
async function installRuntime() {
  privateDirectory(locations().runtimeDir);
  if (!runtimeReady(locations())) {
    const npm = findExecutable('npm'); if (!npm) throw new RuntimeError('NPM_UNAVAILABLE');
    const root=prepareRuntimeManifest(locations());
    await runProcess(npm, ['ci', '--prefix', root, '--omit=dev', '--no-audit', '--no-fund'], { timeoutMs: 300000, env: inheritedEnv() });
  }
  const version = await runProcess(process.execPath, [cliPath(), '--version'], { env: inheritedEnv() });
  if (version.trim() !== PASEO_VERSION || runtimeVersion() !== PASEO_VERSION) throw new RuntimeError('VERSION_MISMATCH');
  if (!fs.existsSync(path.join(packageRoot('server'), 'dist/server/web-ui/index.html'))) throw new RuntimeError('WEB_UI_MISSING');
  markRuntimeReady(locations());
  updateState({ installedVersion: PASEO_VERSION,installedRuntimeRevision:RUNTIME_REVISION });
}
async function choosePort(preferred) {
  for (let port = preferred; port <= Math.min(65535, preferred + 50); port++) {
    const free = await new Promise(resolve => { const server = net.createServer(); server.once('error', () => resolve(false)); server.listen(port, '127.0.0.1', () => server.close(() => resolve(true))); });
    if (free) return port;
  }
  throw new RuntimeError('PORT_UNAVAILABLE');
}
async function detectLaunchers({ installMissing = false } = {}) {
  return resolveProviderLaunchers(locations(), { installMissing, env: inheritedEnv() });
}
async function writeConfig(port, launchers) {
  const loc = locations(); const file = path.join(loc.paseoHome, 'config.json');
  let config = {};
  if (fs.existsSync(file)) { try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new RuntimeError('CONFIG_CORRUPT'); } }
  const providers = configureProviders(config.agents?.providers, launchers, loc, inheritedEnv());
  let name=config.daemon?.name;
  try {
    const preferences=JSON.parse(fs.readFileSync(path.join(loc.stateDir,'preferences.json'),'utf8'));
    if(typeof preferences.name!=='string'||preferences.name.length>100||/[\x00-\x1f]/.test(preferences.name))throw new RuntimeError('CONFIG_INVALID');
    name=preferences.name;
  } catch(error) {if(error.code!=='ENOENT')throw new RuntimeError('CONFIG_INVALID');}
  const providersChanged = JSON.stringify(config.agents?.providers || {}) !== JSON.stringify(providers);
  config = {
    ...config, $schema: 'https://paseo.sh/schemas/paseo.config.v1.json', version: 1,
    daemon: { ...config.daemon, ...(name?{name}:{}), listen: `127.0.0.1:${port}`, hostnames: ['localhost', '127.0.0.1', '.localhost'], relay: { ...config.daemon?.relay, enabled: true }, mcp: { ...config.daemon?.mcp, enabled: true } },
    agents: { ...config.agents, providers, metadataGeneration: config.agents?.metadataGeneration || { providers: [] } },
    features: { ...config.features, webUi: { ...config.features?.webUi, enabled: true } },
    log: { ...config.log, console: { level: 'warn' }, file: { level: 'warn', path: 'daemon.log', rotate: { maxSize: '5m', maxFiles: 2 } } },
  };
  const { savePersistedConfig } = await serverModule('dist/server/server/config.js');
  try { savePersistedConfig(loc.paseoHome, config); fs.chmodSync(file, 0o600); } catch { throw new RuntimeError('CONFIG_INVALID'); }
  updateState({ port, providerLaunchers: launchers });
  return providersChanged;
}
function safeProvider(entry) {
  return { provider: entry.provider, label: entry.label || entry.provider, status: entry.status || (entry.available === true ? 'ready' : entry.available === false ? 'unavailable' : 'unknown'), enabled: entry.enabled !== false, defaultModeId: entry.defaultModeId || null, modes: (entry.modes || []).map(mode => ({ id: mode.id, label: mode.label || mode.id })), chatVerified: readState().acceptance?.providers?.some(row => row.provider === entry.provider && row.passed) || false };
}
async function withClient(fn, timeoutMs = 30000) {
  const { connectToDaemon } = await import(pathToFileURL(path.join(packageRoot(), 'dist/utils/client.js')).href);
  const client = await connectToDaemon({ target: { kind: 'instance', home: locations().paseoHome }, timeout: 5000 });
  let timer;
  try {
    return await Promise.race([fn(client), new Promise((_, reject) => { timer = setTimeout(() => { void client.close().catch(() => {}); reject(new RuntimeError('DAEMON_REQUEST_TIMEOUT')); }, timeoutMs); timer.unref(); })]);
  } catch (error) { throw new RuntimeError(safeCode(error)); }
  finally { clearTimeout(timer); await client.close().catch(() => {}); }
}
export async function activate(options = {}) {
  return withRuntimeLock(async () => {
    ensureOwnedHome(); updateState({ desiredEnabled: true, phase: 'installing', lastError: null });
    try {
      if (Number(process.versions.node.split('.')[0]) < 22) throw new RuntimeError('NODE_VERSION_UNSUPPORTED');
      await installRuntime();
      const existing = await currentInstance(); const launchers = await detectLaunchers({ installMissing: true });
      if (existing) {
        await verifyInstanceOwnership(existing);
        if(instanceNeedsRuntimeRestart(existing)) {
          updateState({phase:'restart_required',lastError:{code:'RESTART_REQUIRED',at:new Date().toISOString()}});
          return status();
        }
        const pending = readState().providerReloadPending;
        const needsApply = await writeConfig(locations().port, launchers) || (pending?.pid === existing.pid && pending?.startedAt === existing.startedAt);
        updateState({ providerReloadPending: { pid: existing.pid, startedAt: existing.startedAt } });
        try {
          const reload = await withClient(client => client.reloadDaemonConfig());
          if (!Array.isArray(reload?.appliedPaths) || !Array.isArray(reload?.restartRequiredPaths) || !Array.isArray(reload?.overrideControlledPaths) ||
              reload.restartRequiredPaths.length || reload.overrideControlledPaths.some(p => p === 'agents.providers' || p.startsWith('agents.providers.')) ||
              (needsApply && !reload.appliedPaths.includes('agents.providers'))) throw new RuntimeError('RESTART_REQUIRED');
        } catch { throw new RuntimeError('RESTART_REQUIRED'); }
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: existing.pid, daemonStartedAt: existing.startedAt });
      } else {
        const port = await choosePort(locations().port); await writeConfig(port, launchers);
        updateState({ phase: 'starting' });
        await cli(['daemon', 'start', '--timeout', '90'], { timeoutMs: 105000 });
        const instance = await currentInstance(); await verifyInstanceOwnership(instance);
        updateState({ phase: 'running', providerReloadPending: null, daemonPid: instance.pid, daemonStartedAt: instance.startedAt });
      }
      const result = await status();
      if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
      updateState({ lastDiagnostic: { checkedAt: new Date().toISOString(), daemonReachable: true, providers: result.providers.map(row => ({ provider: row.provider, status: row.status })) } });
      return status();
    } catch (error) { updateState({ phase: error.code === 'RESTART_REQUIRED' ? 'restart_required' : 'error', lastError: { code: safeCode(error), at: new Date().toISOString() } }); throw new RuntimeError(safeCode(error)); }
  }, { timeoutMs: options.lockTimeoutMs || 360000 });
}
export async function deactivate() {
  return withRuntimeLock(async () => {
    updateState({ desiredEnabled: false });
    const instance = await currentInstance();
    if (instance) {
      await verifyInstanceOwnership(instance);
      const control = await controlModule();
      // The official lifecycle rechecks PID plus startedAt immediately before signaling.
      try { await control.stopDaemonInstance(locations().paseoHome, { instance, timeoutMs: 20000, force: false }); }
      catch (error) { throw new RuntimeError(safeCode(error)); }
    }
    updateState({ phase: 'disabled', daemonPid: null, daemonStartedAt: null });
    return status();
  });
}
export async function status() {
  return singleFlight(`status:${locations().paseoHome}`,readStatus);
}
async function readStatus() {
  const state = readState(); const installed = runtimeReady(locations()); const owned = ownsHome();
  const daemon = { running: false, reachable: false, owned, pid: null, listen: null, relayEnabled: false, relayConnected: null, relayVerified: state.relayVerification?.verified === true, relayVerifiedAt: state.relayVerification?.checkedAt || null };
  let providers = [], diagnosticCode = state.lastError?.code === 'RESTART_REQUIRED' ? 'RESTART_REQUIRED' : null;
  if ((installed||legacyVersion()===PASEO_VERSION) && owned) {
    try {
      const instance = await currentInstance();
      if (instance) {
        await verifyInstanceOwnership(instance); daemon.running = true; daemon.pid = instance.pid; daemon.listen = instance.listen;
        if(instanceNeedsRuntimeRestart(instance))diagnosticCode='RESTART_REQUIRED';
        const key=JSON.stringify([locations().paseoHome,instance.pid,instance.startedAt,state.updatedAt]);
        const sample = await daemonStatusWindow(key,()=>withClient(client => client.getDaemonStatus({ timeout: 5000 }), 8000));
        const result=sample.value;
        daemon.statusCheckedAt=new Date(sample.checkedAt).toISOString();daemon.statusMaxAgeMs=3000;
        daemon.reachable = true; daemon.workerPid = result.pid; daemon.relayEnabled = result.relay?.enabled === true; daemon.relayConnected = typeof result.relay?.connected === 'boolean' ? result.relay.connected : null;
        providers = (result.providers || []).filter(row => PROVIDERS.includes(row.provider)).map(safeProvider);
      }
    } catch (error) { diagnosticCode = safeCode(error); }
  }
  const phase = state.phase === 'running' && !daemon.running ? 'stopped' : state.phase || 'not_installed';
  return { installed, version: installed ? PASEO_VERSION : null, enabled: state.desiredEnabled === true, phase, daemon, providers, chatVerified: state.acceptance?.passed === true, pairingAvailable: fs.existsSync(path.join(locations().stateDir, 'pairing.private.json')), diagnosticCode, state };
}
export async function diagnose() {
  const snapshot = await status(); const launchers = await detectLaunchers();
  let providers = snapshot.providers;
  if (snapshot.daemon.reachable) {
    try { providers = await withClient(async client => (await client.getProvidersSnapshot()).entries.filter(row => PROVIDERS.includes(row.provider)).map(safeProvider), 150000); }
    catch (error) { snapshot.diagnosticCode = safeCode(error); }
  }
  const loc = locations();
  const credentialPaths = { claude: [path.join(loc.home, '.claude/.credentials.json')], codex: [path.join(process.env.CODEX_HOME || path.join(loc.home, '.codex'), 'auth.json')], pi: [path.join(loc.agentDir, 'auth.json')] };
  providers = PROVIDERS.map(provider => {
    const check = snapshot.state.acceptance?.providers?.find(row => row.provider === provider);
    return { ...(providers.find(row => row.provider === provider) || { provider, status: 'unknown', modes: [] }), launcher: launchers[provider], credentialPresent: credentialPaths[provider].some(file => fs.existsSync(file)), authentication: check?.passed ? 'chat_verified' : check?.code === 'PROVIDER_AUTH_REQUIRED' ? 'login_required' : 'needs_chat_verification', chatErrorCode: check?.code || null, loginHint: provider === 'claude' ? 'claude auth login' : provider === 'codex' ? 'codex login' : 'pi /login' };
  });
  const result = { ...snapshot, providers, checkedAt: new Date().toISOString() };
  updateState({ lastDiagnostic: { checkedAt: result.checkedAt, daemonReachable: result.daemon.reachable, providers: providers.map(row => ({ provider: row.provider, status: row.status, startup: row.launcher.startup, authentication: row.authentication })) } });
  return result;
}
export async function listModels(provider) {
  if (!PROVIDERS.includes(provider)) throw new RuntimeError('INVALID_PROVIDER');
  return singleFlight(`models:${locations().paseoHome}:${provider}`,()=>readModels(provider));
}
async function readModels(provider) {
  return withClient(async client => {
    const result = await client.listProviderModels(provider);
    const snapshot = await client.getProvidersSnapshot(); const entry = snapshot.entries.find(row => row.provider === provider);
    if (result.error) throw new RuntimeError('PROVIDER_MODELS_UNAVAILABLE');
    return { ...safeProvider(entry || { provider, status: 'unknown' }), models: (result.models || []).map(model => ({ id: model.id, label: model.label || model.id, isDefault: model.isDefault === true, defaultThinkingOptionId: model.defaultThinkingOptionId || null, thinkingOptions: (model.thinkingOptions || []).map(option => ({ id: option.id, label: option.label || option.id, isDefault: option.isDefault === true })) })) };
  }, 150000);
}
export async function pair() {
  const result = await status(); if (!result.daemon.reachable) throw new RuntimeError('DAEMON_UNREACHABLE');
  const offer = await cli(['daemon', 'pair', '--relay'], { timeoutMs: 15000 });
  if (!offer.url || !offer.relayEnabled) throw new RuntimeError('PAIRING_UNAVAILABLE');
  const url = new URL(offer.url); if (url.protocol !== 'https:' || url.hostname !== 'app.paseo.sh') throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  const pairing = { url: offer.url, createdAt: new Date().toISOString() };
  atomicJson(path.join(locations().stateDir, 'pairing.private.json'), pairing);
  updateState({ pairingCreatedAt: pairing.createdAt });
  return pairing;
}
/** Runs exactly two tiny turns per selected provider. Call only after user authorization. */
export async function acceptance(options = {}) {
  const selectedProviders = options.providers || PROVIDERS;
  if (!Array.isArray(selectedProviders) || selectedProviders.some(provider => !PROVIDERS.includes(provider))) throw new RuntimeError('INVALID_PROVIDER');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 180000, 10000), 600000);
  const results = [];
  const previous = readState().acceptance?.providers || [];
  const cwd = options.cwd || path.join(locations().stateDir, 'acceptance-workspace'); privateDirectory(cwd);
  for (const provider of selectedProviders) {
    const row = { provider, passed: false, firstReply: false, followup: false, model: null, modeId: null, agentId: null };
    try {
      const catalog = await listModels(provider);
      const model = options.models?.[provider] || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
      if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('NO_AVAILABLE_MODEL');
      const modeId = options.modes?.[provider] || catalog.defaultModeId || undefined;
      if (modeId && catalog.modes.length && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
      row.model = model; row.modeId = modeId || null;
      await withClient(async client => {
        const marker = `PI_PASEO_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const workspace = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
        if (!workspace.workspace?.id) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
        await usingAcceptanceAgent(client,{ provider, model, modeId, cwd, workspaceId: workspace.workspace.id, title: `Pi Paseo ${provider} connection check`, initialPrompt: `Connection check only. Do not use tools or edit files. Remember ${marker}. Reply with exactly ${marker}.`, labels: { 'pi-paseo-acceptance': 'true' } },row,async agent=>{
        const first = await client.waitForFinish(agent.id, timeoutMs);
        if (first.status !== 'idle') throw new RuntimeError(first.status === 'permission' ? 'PERMISSION_REQUIRED' : first.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const firstEntries = await assistantEntries(client, agent.id);
        const firstReply = firstEntries.at(-1)?.item.text || ''; row.firstReply = String(firstReply).includes(marker);
        if (providerReplyError(firstReply)) throw new RuntimeError(providerReplyError(firstReply));
        if (!row.firstReply) throw new RuntimeError('EMPTY_OR_UNEXPECTED_REPLY');
        await client.sendAgentMessage(agent.id, 'What marker did I ask you to remember? Reply with that marker only. Do not use tools.');
        const second = await client.waitForFinish(agent.id, timeoutMs);
        if (second.status !== 'idle') throw new RuntimeError(second.status === 'permission' ? 'PERMISSION_REQUIRED' : second.status === 'timeout' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_TURN_FAILED');
        const secondEntries = await assistantEntries(client, agent.id);
        const followup = secondEntries.at(-1)?.item.text || ''; row.followup = latestAssistantCursor(secondEntries) !== latestAssistantCursor(firstEntries) && String(followup).includes(marker);
        if (providerReplyError(followup)) throw new RuntimeError(providerReplyError(followup));
        row.passed = row.firstReply && row.followup;
        });
      }, timeoutMs * 2 + 30000);
    } catch (error) { row.code = safeCode(error); }
    results.push(row);
    updateState({ acceptance: { checkedAt: new Date().toISOString(), passed: false, providers: results } });
    if (options.onProgress) await options.onProgress({ ...row });
  }
  const merged = [...previous.filter(row => !selectedProviders.includes(row.provider)), ...results];
  const result = { checkedAt: new Date().toISOString(), passed: PROVIDERS.every(provider => merged.some(row => row.provider === provider && row.passed && row.cleanup?.archived!==false)), providers: merged };
  updateState({ acceptance: result }); return result;
}
function chatInput(message) {
  if (typeof message !== 'string' || !message.trim() || message.length > 100000) throw new RuntimeError('INVALID_MESSAGE');
}
function chatCwd(cwd) {
  const directory = path.resolve(cwd || readState().settings?.cwd || locations().home);
  try { fs.accessSync(directory, fs.constants.R_OK); if (!fs.statSync(directory).isDirectory()) throw new Error(); }
  catch { throw new RuntimeError('INVALID_WORKSPACE'); }
  return directory;
}
export async function createChat(options = {}) {
  chatInput(options.message); const provider = options.provider;
  const catalog = await listModels(provider); const cwd = chatCwd(options.cwd);
  const model = options.model || catalog.models.find(model => model.isDefault)?.id || catalog.models[0]?.id;
  if (!model || !catalog.models.some(entry => entry.id === model)) throw new RuntimeError('INVALID_MODEL');
  const modeId = options.mode || catalog.defaultModeId || undefined;
  if (modeId && !catalog.modes.some(mode => mode.id === modeId)) throw new RuntimeError('INVALID_MODE');
  const selected = catalog.models.find(entry => entry.id === model);
  const thinkingOptionId = options.thinking || selected.defaultThinkingOptionId || undefined;
  if (thinkingOptionId && !selected.thinkingOptions.some(option => option.id === thinkingOptionId)) throw new RuntimeError('INVALID_THINKING_OPTION');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let agentId;
  try {
    return await withClient(async client => {
      const workspace = await client.createWorkspace({ source: { kind: 'directory', path: cwd } });
      if (!workspace.workspace?.id) throw new RuntimeError('WORKSPACE_CREATE_FAILED');
      const agent = await client.createAgent({ provider, model, modeId, thinkingOptionId, cwd, workspaceId: workspace.workspace.id, title: options.title || `Pi Web ${provider}`, initialPrompt: options.message, labels: { 'pi-paseo-plugin': readState().installationId } });
      agentId = agent.id;
      return chatResult(client, agentId, provider, model, timeoutMs);
    }, timeoutMs + 30000);
  } catch (error) {
    if (agentId && ['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
export async function continueChat(options = {}) {
  chatInput(options.message);
  if (typeof options.agentId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(options.agentId)) throw new RuntimeError('INVALID_AGENT_ID');
  const timeoutMs = Math.min(Math.max(options.timeoutMs || 120000, 1000), 600000);
  let provider = null, model = null;
  try {
    return await withClient(async client => {
      const found = await client.fetchAgent({ agentId: options.agentId });
      if (!found?.agent) throw new RuntimeError('AGENT_NOT_FOUND');
      provider = found.agent.provider; model = found.agent.model || found.agent.config?.model || null;
      const previousCursor = latestAssistantCursor(await assistantEntries(client, options.agentId));
      await client.sendAgentMessage(options.agentId, options.message);
      return chatResult(client, options.agentId, provider, model, timeoutMs, previousCursor);
    }, timeoutMs + 30000);
  } catch (error) {
    if (['DAEMON_REQUEST_TIMEOUT', 'COMMAND_TIMEOUT'].includes(error.code)) return { agentId: options.agentId, provider, model, reply: '', status: 'pending' };
    throw error;
  }
}
