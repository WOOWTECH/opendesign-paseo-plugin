import fs from 'node:fs';
import path from 'node:path';
import { findExecutable, runProcess } from './process.mjs';
import { privateDirectory } from './state.mjs';

// Pi1-validated pins, checked against https://registry.npmjs.org before shipping.
export const PROVIDER_PACKAGES = Object.freeze({
  claude: Object.freeze({ name: '@anthropic-ai/claude-code', version: '2.1.270' }),
  codex: Object.freeze({ name: '@openai/codex', version: '0.162.1' }),
  pi: Object.freeze({ name: '@earendil-works/pi-coding-agent', version: '1.0.0' }),
});
const launchFailures = new Set(['COMMAND_UNAVAILABLE', 'COMMAND_FAILED', 'COMMAND_TIMEOUT', 'COMMAND_ABORTED', 'COMMAND_OUTPUT_LIMIT']);
export function providersPrefix(loc) { return path.join(loc.home, '.local/share/pi-paseo/providers'); }
function discoverCommand(name, env) {
  const executable = findExecutable(name, env);
  if (executable) return executable;
  // A dangling symlink or non-executable mount is present but broken, not missing.
  const candidates = path.isAbsolute(name) ? [name] : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, name));
  for (const file of candidates) {
    try { fs.lstatSync(file); return file; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return file; }
  }
  return null;
}
async function probe(command, env, run) {
  const result = { command: path.resolve(command), version: null, startup: 'invalid' };
  try {
    const text = await run(result.command, ['--version'], { env, timeoutMs: 15000, maxBytes: 4096 });
    result.version = text.trim().match(/\d+\.\d+\.\d+/)?.[0] || null;
    result.startup = result.version ? 'ready' : 'invalid';
  } catch (error) {
    result.startup = launchFailures.has(error?.code) ? error.code : 'PROVIDER_LAUNCH_FAILED';
  }
  return result;
}
/** Installation is opt-in; runtime activation serializes it under its existing lock. */
export async function resolveProviderLaunchers(loc, { installMissing = false, env = process.env, discover = discoverCommand, run = runProcess } = {}) {
  const prefix = providersPrefix(loc);
  const providerEnv = { ...env, HOME: loc.home, PI_CODING_AGENT_DIR: loc.agentDir, PI_AGENT_DATA_DIR: env.PI_AGENT_DATA_DIR || loc.agentDir };
  const result = {};
  for (const [provider, pkg] of Object.entries(PROVIDER_PACKAGES)) {
    const binary = path.join(prefix, 'node_modules/.bin', provider);
    const command = discover(provider, providerEnv) || discover(binary, providerEnv);
    if (command) { result[provider] = await probe(command, providerEnv, run); continue; }
    result[provider] = { command: null, version: null, startup: 'missing' };
    if (!installMissing) continue;
    const npm = discover('npm', providerEnv);
    if (!npm) { result[provider].startup = 'NPM_UNAVAILABLE'; continue; }
    try {
      privateDirectory(prefix);
      await run(npm, ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--save-exact', '--include=optional', '--registry=https://registry.npmjs.org', `${pkg.name}@${pkg.version}`], { cwd: prefix, env: providerEnv, timeoutMs: 300000 });
      const installed = discover(binary, providerEnv);
      if (!installed) { result[provider].startup = 'PROVIDER_INSTALL_FAILED'; continue; }
      result[provider] = await probe(installed, providerEnv, run);
      if (result[provider].startup === 'ready' && result[provider].version !== pkg.version) result[provider].startup = 'PROVIDER_VERSION_MISMATCH';
    } catch {
      // npm stderr and even an arbitrary error.code can contain account information.
      result[provider].startup = 'PROVIDER_INSTALL_FAILED';
    }
  }
  return result;
}
export function configureProviders(previous, launchers, loc, env = process.env) {
  const providers = { ...previous };
  for (const provider of Object.keys(PROVIDER_PACKAGES)) {
    const launcher = launchers[provider];
    providers[provider] = { ...providers[provider], enabled: launcher.startup === 'ready', command: launcher.command ? [path.resolve(launcher.command)] : undefined, env: { ...providers[provider]?.env, HOME: loc.home, PI_CODING_AGENT_DIR: loc.agentDir, PI_AGENT_DATA_DIR: env.PI_AGENT_DATA_DIR || loc.agentDir } };
  }
  return providers;
}
