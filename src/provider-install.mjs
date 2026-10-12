import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PROVIDER_PACKAGES } from '../vendor/pi-paseo/src/provider-launchers.mjs';
import { assertSafePath, atomicJson, privateDirectory, RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { findExecutable, runProcess } from '../vendor/pi-paseo/src/process.mjs';
import { PI_REPAIR, piRepaired, repairPiSdk } from './sdk-repair.mjs';
export { PI_REPAIR, piRepaired } from './sdk-repair.mjs';

export function discoverProviderCommand(name, env) {
  const found = findExecutable(name, env);
  if (found) return found;
  const candidates = path.isAbsolute(name) ? [name] : (env.PATH || '').split(path.delimiter).map(dir => path.resolve(dir, name));
  for (const file of candidates) {
    try { fs.lstatSync(file); return file; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return file; }
  }
  return null;
}
export function providerRelease(context, provider) {
  const pkg = PROVIDER_PACKAGES[provider];
  if (!pkg) throw new RuntimeError('INVALID_PROVIDER');
  return path.join(context.toolsDir, 'providers', `${provider}-${pkg.version}${provider === 'pi' ? '-brace-' + PI_REPAIR : ''}`);
}
export function providerEnvironment(context) {
  const bins = Object.keys(PROVIDER_PACKAGES).map(provider => path.join(providerRelease(context, provider), 'node_modules/.bin'));
  return { ...context.env, PATH: [...bins, path.join(context.home, '.local/bin'), context.env.PATH || '/usr/local/bin:/usr/bin:/bin'].join(path.delimiter) };
}

/** Only manager enable calls this. Existing tenant launchers/auth are preserved. */
export async function installProviders(context, { run = runProcess, discover = discoverProviderCommand } = {}) {
  const env = providerEnvironment(context);
  for (const [provider, pkg] of Object.entries(PROVIDER_PACKAGES)) {
    const root = providerRelease(context, provider);
    const managed = path.join(root, 'node_modules/.bin', provider);
    const existing = discover(provider, env);
    const owned = existing === managed;
    if (existing && !owned) continue;
    if (existing && (provider !== 'pi' || piRepaired(root, context.packageRoot))) { publishLauncher(context, provider, managed); continue; }
    const npm = discover('npm', env);
    if (!npm) throw new RuntimeError('NPM_UNAVAILABLE');
    privateDirectory(root);
    assertSafePath(path.join(root, 'package.json'));
    if (fs.existsSync(path.join(root, 'package.json')) && JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).name !== `opendesign-paseo-${provider}`) throw new RuntimeError('PROVIDER_NOT_OWNED');
    const manifest = { name: `opendesign-paseo-${provider}`, private: true, version: pkg.version, dependencies: { [pkg.name]: pkg.version }, ...(provider === 'pi' ? { overrides: { 'minimatch@10': { 'brace-expansion': PI_REPAIR } } } : {}) };
    atomicJson(path.join(root, 'package.json'), manifest);
    await run(npm, ['install', '--prefix', root, '--no-audit', '--no-fund', '--save-exact', '--include=optional', '--registry=https://registry.npmjs.org'], { env, cwd: root, timeoutMs: 300000 });
    if (provider === 'pi') { repairPiSdk(root, context.packageRoot); if (!piRepaired(root, context.packageRoot)) throw new RuntimeError('PROVIDER_REPAIR_FAILED'); }
    if (!discover(managed, env)) throw new RuntimeError('PROVIDER_INSTALL_FAILED');
    // Verify the exact version only after the Pi repair has been checked.
    const result = await run(managed, ['--version'], { env, timeoutMs: 15000, maxBytes: 4096 });
    if (result.match(/\d+\.\d+\.\d+/)?.[0] !== pkg.version) throw new RuntimeError('PROVIDER_VERSION_MISMATCH');
    const lock = fs.readFileSync(path.join(root, 'package-lock.json'));
    atomicJson(path.join(root, '.opendesign-provider.json'), { provider, version: pkg.version, lockSha256: createHash('sha256').update(lock).digest('hex'), ...(provider === 'pi' ? { braceExpansion: PI_REPAIR } : {}) });
    publishLauncher(context, provider, managed);
  }
  return env;
}

function publishLauncher(context, provider, managed) {
  const dir = path.join(context.home, '.local/bin'), file = path.join(dir, provider);
  assertSafePath(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); assertSafePath(dir);
  // Existing commands (including dangling/foreign links) belong to the tenant.
  try { fs.lstatSync(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.symlinkSync(managed, file);
}
