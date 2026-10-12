import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { findExecutable } from '../vendor/pi-paseo/src/process.mjs';
import { providers, safeError } from './runtime-context.mjs';
import { providerEnvironment } from './provider-install.mjs';

const officialHosts = {
  claude: new Set(['claude.ai', 'console.anthropic.com', 'auth.anthropic.com', 'platform.claude.com']),
  codex: new Set(['auth.openai.com', 'platform.openai.com', 'openai.com']),
  pi: new Set(['auth.openai.com', 'platform.openai.com', 'openai.com']),
};
const commands = { claude: ['auth', 'login'], codex: ['login', '--device-auth'], pi: ['/login'] };
const instructions = {
  claude: 'Use the official Claude Code authorization page in this protected view. Existing credentials require chat verification.',
  codex: 'Use the official Codex device authorization page and enter the device code in this protected view.',
  pi: 'Open the official authorization page, then paste its redirect URL or authorization code into this protected view if asked. Credentials stay in the existing tenant provider home.',
};
const phases = new Set(['idle', 'starting', 'awaiting_authorization', 'authorization_completed', 'credential_present', 'interactive_required', 'cancelled', 'expired', 'error']);

export function officialAuthorizationUrl(text, provider) {
  for (const match of String(text).matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
    try {
      const url = new URL(match[0].replace(/[).,]+$/, ''));
      if (!url.username && !url.password && !url.port && officialHosts[provider]?.has(url.hostname)) return url.href;
    } catch {}
  }
  return null;
}

/** Auth output is transient and available only from protected login(), never status/MCP. */
export function createAuthFlow(context, { launch = spawn, discover = findExecutable, timeoutMs = 120000, settleMs = 800 } = {}) {
  let active;
  const records = new Map();
  const credentialPath = provider => provider === 'claude' ? path.join(context.env.CLAUDE_CONFIG_DIR, '.credentials.json') : provider === 'codex' ? path.join(context.env.CODEX_HOME, 'auth.json') : path.join(context.env.PI_CODING_AGENT_DIR, 'auth.json');
  const snapshot = (provider, protectedView = false) => {
    const record = records.get(provider) || { phase: 'idle' };
    return { provider, phase: phases.has(record.phase) ? record.phase : 'error', startedAt: record.startedAt || null, expiresAt: record.expiresAt || null, code: record.code || null,
      ...(provider !== 'pi' ? { command: [provider, ...commands[provider]] } : {}), instructions: instructions[provider],
      ...(protectedView && record.authorizationUrl ? { authorizationUrl: record.authorizationUrl } : {}),
      ...(protectedView && record.deviceCode ? { deviceCode: record.deviceCode } : {}),
      ...(protectedView && record.requiresCode ? { requiresCode: true, inputKind: 'redirect_url_or_code' } : {}) };
  };
  const cancel = (phase = 'cancelled') => {
    if (!active) return;
    const current = active;
    const record = records.get(current.provider);
    record.phase = phase; delete record.authorizationUrl; delete record.deviceCode; delete record.requiresCode;
    clearTimeout(current.timer);
    const kill = signal => { try { if (process.platform === 'linux' && current.child.pid) process.kill(-current.child.pid, signal); else current.child.kill(signal); } catch {} };
    kill('SIGTERM');
    const forced = setTimeout(() => kill('SIGKILL'), 1500); forced.unref();
    current.forced = forced;
    // Keep active until exit: a second login cannot race a cancelling CLI.
  };
  const settle = child => new Promise(resolve => { const timer = setTimeout(resolve, settleMs); child.once('close', () => { clearTimeout(timer); resolve(); }); });
  const login = async (action, provider, input = {}) => {
    if (!providers.includes(provider)) throw new RuntimeError('INVALID_PROVIDER');
    if (!['start', 'status', 'cancel', 'guide', 'complete'].includes(action)) throw new RuntimeError('INVALID_LOGIN_ACTION');
    if (action === 'cancel') { if (active?.provider === provider) cancel(); return snapshot(provider, true); }
    if (action === 'complete') {
      const code = typeof input === 'string' ? input : input?.code;
      if (provider !== 'pi' || active?.provider !== 'pi' || !records.get('pi')?.requiresCode) throw new RuntimeError('INVALID_LOGIN_ACTION');
      if (typeof code !== 'string' || !code.trim() || code.length > 2048 || /[\x00-\x1f]/.test(code)) throw new RuntimeError('INVALID_LOGIN_INPUT');
      const child = active.child;
      records.get('pi').requiresCode = false;
      child.stdin.write(JSON.stringify({ action: 'complete', code }) + '\n');
      await settle(child);
      return snapshot(provider, true);
    }
    if (action !== 'start') return snapshot(provider, true);
    if (active) {
      if (active.provider !== provider) throw new RuntimeError('OPERATION_BUSY');
      return snapshot(provider, true);
    }
    // Never replace an existing tenant authentication file automatically.
    if (provider !== 'pi' && fs.existsSync(credentialPath(provider))) {
      records.set(provider, { phase: 'credential_present' });
      return snapshot(provider, true);
    }
    const env = providerEnvironment(context), executable = provider === 'pi' ? process.execPath : discover(provider, env);
    if (!executable) throw new RuntimeError('PROVIDER_UNAVAILABLE');
    const record = { phase: 'starting', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
    records.set(provider, record);
    const child = launch(executable, provider === 'pi' ? [path.join(context.packageRoot, 'src/pi-auth-worker.mjs')] : commands[provider], { cwd: context.home, env, detached: process.platform === 'linux', shell: false, stdio: [provider === 'pi' ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    const current = { child, provider, timer: setTimeout(() => cancel('expired'), timeoutMs) };
    current.timer.unref(); active = current;
    let output = '', bytes = 0;
    const receive = chunk => {
      if (['cancelled', 'expired', 'error'].includes(record.phase)) return;
      bytes += chunk.length;
      if (bytes > 32768) { record.code = 'COMMAND_OUTPUT_LIMIT'; cancel('error'); return; }
      output += String(chunk).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
      if (provider === 'pi') {
        let newline;
        while ((newline = output.indexOf('\n')) !== -1) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          let value;
          try { value = JSON.parse(line); } catch { record.code = 'PROVIDER_LOGIN_FAILED'; cancel('error'); return; }
          if (phases.has(value.phase)) record.phase = value.phase;
          if (value.code) record.code = safeError(value).code;
          if (value.authorizationUrl) {
            const url = officialAuthorizationUrl(value.authorizationUrl, 'pi');
            if (!url) { record.code = 'PROVIDER_LOGIN_FAILED'; cancel('error'); return; }
            record.authorizationUrl = url;
          }
          if (typeof value.deviceCode === 'string' && /^[A-Z0-9-]{3,64}$/.test(value.deviceCode)) record.deviceCode = value.deviceCode;
          if (value.requiresCode === true) record.requiresCode = true;
          if (['authorization_completed', 'credential_present', 'cancelled', 'expired', 'error'].includes(record.phase)) { delete record.authorizationUrl; delete record.deviceCode; delete record.requiresCode; }
        }
        return;
      }
      const url = officialAuthorizationUrl(output, provider);
      if (url) { record.authorizationUrl = url; record.phase = 'awaiting_authorization'; }
      if (provider === 'codex') {
        const found = output.match(/\b[A-Z0-9]{4,6}-[A-Z0-9]{4,6}\b/);
        if (found) record.deviceCode = found[0];
      }
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', provider === 'pi' ? chunk => { bytes += chunk.length; if (bytes > 32768) { record.code = 'COMMAND_OUTPUT_LIMIT'; cancel('error'); } } : receive);
    child.stdin?.on('error', () => {});
    child.once('error', () => { record.code = 'PROVIDER_LOGIN_FAILED'; record.phase = 'error'; });
    child.once('close', exit => {
      clearTimeout(current.timer); clearTimeout(current.forced);
      if (!['cancelled', 'expired', 'error', 'credential_present'].includes(record.phase)) { record.phase = exit === 0 ? 'authorization_completed' : 'error'; if (exit !== 0) record.code = 'PROVIDER_LOGIN_FAILED'; }
      delete record.authorizationUrl; delete record.deviceCode; delete record.requiresCode; output = '';
      if (active === current) active = undefined;
    });
    await settle(child);
    return snapshot(provider, true);
  };
  return { login, publicStatus: () => providers.map(provider => snapshot(provider)), cancel: () => cancel(), dispose: () => cancel() };
}
