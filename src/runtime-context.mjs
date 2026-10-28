import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafePath, RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { runtimeReady } from '../vendor/pi-paseo/src/runtime-layout.mjs';

export const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const providers = Object.freeze(['claude', 'codex', 'pi']);
const publicErrorCodes = new Set(`ACCEPTANCE_CLEANUP_FAILED AGENT_NOT_FOUND AGENT_NOT_OWNED COMMAND_ABORTED COMMAND_FAILED COMMAND_OUTPUT_LIMIT COMMAND_TIMEOUT COMMAND_UNAVAILABLE CONFIG_CORRUPT CONFIG_INVALID DAEMON_NOT_OWNED DAEMON_REQUEST_TIMEOUT DAEMON_STOPPED DAEMON_UNREACHABLE EMPTY_OR_UNEXPECTED_REPLY INVALID_ACCEPTANCE_OPTIONS INVALID_AGENT_ID INVALID_CHAT_OPTIONS INVALID_COMMAND_OUTPUT INVALID_LOCK_OPTIONS INVALID_LOGIN_ACTION INVALID_MESSAGE INVALID_MODE INVALID_MODEL INVALID_ONBOARDING_ID INVALID_ONBOARDING_URL INVALID_PORT INVALID_PROCESS_OPTIONS INVALID_PROVIDER INVALID_PROVIDER_HOME INVALID_RUNTIME_ACTION INVALID_RUNTIME_INPUT INVALID_RUNTIME_PATH INVALID_THINKING_OPTION INVALID_TIMEOUT INVALID_TOOL_INPUT INVALID_WORKSPACE LOCK_ABORTED LOCK_BUSY LOCK_GUARD_FAILED LOCK_GUARD_TIMEOUT LOCK_GUARD_UNAVAILABLE LOCK_GUARD_UNSUPPORTED NODE_VERSION_UNSUPPORTED NOT_INSTALLED NO_AVAILABLE_MODEL NPM_UNAVAILABLE ONBOARDING_INITIALIZATION_FAILED ONBOARDING_NOT_CREATED ONBOARDING_NOT_STARTED ONBOARDING_RECONCILIATION_REQUIRED ONBOARDING_TIMEOUT OPERATION_ABORTED OPERATION_BUSY OPERATION_INTERRUPTED OPERATION_TIMEOUT PAIRING_ORIGIN_INVALID PAIRING_UNAVAILABLE PERMISSION_REQUIRED PORT_UNAVAILABLE PROVIDER_AUTH_REQUIRED PROVIDER_INSTALL_FAILED PROVIDER_LAUNCH_FAILED PROVIDER_LOGIN_FAILED PROVIDER_MODELS_UNAVAILABLE PROVIDER_NOT_OWNED PROVIDER_QUOTA_EXHAUSTED PROVIDER_REPAIR_FAILED PROVIDER_TIMEOUT PROVIDER_TURN_FAILED PROVIDER_UNAVAILABLE PROVIDER_VERSION_MISMATCH RESTART_REQUIRED RUNTIME_BUSY RUNTIME_FAILED RUNTIME_NOT_OWNED SERVICE_DISABLED SERVICE_DISPOSED STATE_BUSY STATE_CORRUPT STATE_SECRET_FIELD SUPERVISOR_NOT_OWNED SUPERVISOR_STOP_TIMEOUT SUPERVISOR_UNAVAILABLE UNSAFE_LOCK UNSAFE_SYMLINK VERSION_MISMATCH WEB_UI_MISSING WORKSPACE_CREATE_FAILED`.split(' '));

export function safeError(error) {
  // Only categories defined by this bridge/runtime may cross the host boundary.
  const code = publicErrorCodes.has(error?.code) || error?.code === 'INVALID_LOGIN_INPUT' ? error.code : 'RUNTIME_FAILED';
  return new RuntimeError(code);
}

export function contained(root, file) {
  const relative = path.relative(root, path.resolve(file));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export function runtimeContext({ dataDir, home, packageRoot = sourceRoot, env = process.env } = {}) {
  if (![dataDir, home, packageRoot].every(value => typeof value === 'string' && path.isAbsolute(value))) throw new RuntimeError('INVALID_RUNTIME_PATH');
  const context = { dataDir: path.resolve(dataDir), home: path.resolve(home), packageRoot: path.resolve(packageRoot) };
  context.stateDir = path.join(context.dataDir, 'paseo');
  context.toolsDir = path.join(context.stateDir, 'packages');
  context.sourceStore = path.join(context.home, '.local/share/opendesign-paseo');
  // Managed Paseo runtime shipped inside the image next to this package: <packageRoot>/managed-runtime, built at image
  // build time. It is located from packageRoot - which the supervisor, runtime workers and the stdio MCP server all
  // receive - and not from an environment variable that the child filter below would drop. Used in place and read-only
  // once its receipt matches the lock this package ships: no npm, no copy onto the tenant volumes. Absent or not ready
  // keeps the previous behaviour (lock-pinned `npm ci` into <data>/paseo/packages/runtime).
  const bundled = path.join(context.packageRoot, 'managed-runtime');
  context.runtimeDir = runtimeReady({ runtimeDir: bundled }) ? bundled : path.join(context.toolsDir, 'runtime');
  for (const file of [context.stateDir, context.toolsDir, path.join(context.packageRoot, 'src/runtime-worker.mjs')]) assertSafePath(file);
  // Web credentials and host controls never belong to a daemon/provider child.
  const childEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (/^(?:OD_|OPEN_?DESIGN_|OPENDESIGN_|PI_WEB_|PI_PASEO_|PASEO_|OMNIGENT|CODEX_SESSION|CODEX_THREAD)/i.test(key)) continue;
    if (/^(?:NODE_OPTIONS|NODE_PATH|AUTH_SECRET|SESSION_SECRET|JWT_SECRET|WEB_PASSWORD|WEB_AUTH_TOKEN|COOKIE|AUTHORIZATION)$/i.test(key)) continue;
    if (/^npm_config_(?:prefix|userconfig|globalconfig|cache|global)$/i.test(key)) continue;
    childEnv[key] = value;
  }
  const providerDir = (name, fallback) => {
    const candidate = env[name];
    if (candidate && (!path.isAbsolute(candidate) || !contained(context.home, candidate))) throw new RuntimeError('INVALID_PROVIDER_HOME');
    const dir = candidate || path.join(context.home, fallback);
    assertSafePath(dir);
    return dir;
  };
  const agentDir = providerDir('PI_CODING_AGENT_DIR', '.pi/agent');
  const codexHome = providerDir('CODEX_HOME', '.codex');
  const claudeHome = providerDir('CLAUDE_CONFIG_DIR', '.claude');
  Object.assign(childEnv, {
    HOME: context.home, CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: claudeHome, PI_CODING_AGENT_DIR: agentDir, PI_AGENT_DATA_DIR: agentDir,
    PI_PASEO_STATE_DIR: context.stateDir, PI_PASEO_RUNTIME_DIR: context.runtimeDir,
    PI_PASEO_FLOCK_HELPER: path.join(context.packageRoot, 'src/flock-helper.py'),
    PI_OAUTH_CALLBACK_HOST: '127.0.0.1',
    OPENDESIGN_PASEO_DATA_DIR: context.dataDir, OPENDESIGN_PASEO_PACKAGE_ROOT: context.packageRoot,
    NO_COLOR: '1', npm_config_cache: path.join(context.toolsDir, 'npm-cache'),
  });
  context.env = childEnv;
  return Object.freeze(context);
}

export function environmentContext(env = process.env) {
  return runtimeContext({ dataDir: env.OPENDESIGN_PASEO_DATA_DIR || env.OD_DATA_DIR, home: env.HOME, packageRoot: env.OPENDESIGN_PASEO_PACKAGE_ROOT || sourceRoot, env });
}
