import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {installHost} from '../scripts/install-host.mjs';
import {preload} from '../bin/preload.mjs';
export const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const root=sourceRoot;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const nativeArgv=['node','/app/apps/daemon/bin/od.mjs'];
export function releaseFixture(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'od-release-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source'), home = path.join(temporary, 'home'), hostRoot = path.join(temporary, 'host');
  for (const directory of [source, home, hostRoot]) fs.mkdirSync(directory);
  const write = (base, relative, bytes) => { const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
  for (const relative of ['bin/preload.mjs', 'host/overlay.mjs', 'host/release-state.mjs', 'host/compatibility-profile.mjs', 'src/flock-helper.py', 'plugin/open-design.json', 'plugin/SKILL.md', 'open-design.json', 'SKILL.md']) write(source, relative, fs.readFileSync(path.join(root, relative)));
  for (const relative of ['package.json', 'node_modules/@modelcontextprotocol/sdk/package.json']) write(source, relative, JSON.stringify(relative === 'package.json' ? { name: '@woowtech/opendesign-paseo', version: '0.1.0', type: 'module' } : { name: '@modelcontextprotocol/sdk', version: '1.31.0' }));
  write(source, 'package-lock.json', '{"lockfileVersion":3}');
  write(source, 'host/adapter.mjs', 'export function installBridgeBodyParser(){};export function registerPaseoBridge(){};export function stopBeforeNativeUninstall(){};');
  write(source, 'host/plugin-transaction.mjs', 'export function installNativeManagedPlugin(){};export function nativeManagedPluginTransactionOptions(){};export function recoverManagedPluginTransaction(){};export function withManagedPluginMutationLock(){};');
  const stocks = {
    'apps/daemon/dist/server.js': `export const stock=true;\nexport async function start(){\n    app.use(express.json({ limit: '4mb' }));\n    if (fs.existsSync(staticDir)) { }\n                daemonUrl = url;\n        const cleanupDaemonBackgroundWork = () => {};\n            daemonShutdownStarted = true;\n}\n`,
    'apps/daemon/dist/mcp-config.js': `export async function write(){\n    const next = sanitizeMcpConfig(body);\n    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');\n}\n`,
    'apps/daemon/dist/routes/plugins/index.js': `export async function remove(){const result = await plugins.uninstallPlugin(db, req.params.id, paths.PLUGIN_REGISTRY_ROOTS);}\n`,
    'apps/daemon/dist/plugins/installer.js': `import { upsertPluginLockfileEntry } from './lockfile.js';\nexport async function* install(){\n    yield { kind: 'progress', phase: 'copying', message: \`Copying to \${destFolder}\` };\n    // Plan §3.II1 / §3.JJ1 — emit 'plugin.installed' OR\n    yield { kind: 'success', plugin: parsed.record, warnings };\n}\nexport async function uninstallPlugin(db, id, roots = defaultRegistryRoots()) { return {}; }\n`,
    'apps/daemon/dist/plugins/lockfile.js': `export function upsertPluginLockfileEntry(){};\nexport function lockEntryFromInstalled(){};\nasync function withLockfileQueue(filePath, task) { return task(); }\n`,
    'apps/web/out/index.html': '<html><head></head><body>Original app</body></html>',
  };
  for (const [relative, bytes] of Object.entries(stocks)) write(hostRoot, relative, bytes);
  write(hostRoot, 'package.json', '{"type":"module"}');
  write(source, 'host/compatibility.json', JSON.stringify({ adapterProtocolVersion: 1, files: Object.fromEntries(Object.entries(stocks).map(([file, bytes]) => [file, sha(bytes)])) }));
  const base = path.join(home, '.local/share/opendesign-paseo');
  return { temporary, source, home, hostRoot, stocks, base, write,
    install: () => installHost({ source, home, hostRoot, lockTimeoutMs: 1000 }),
    pointer: name => JSON.parse(fs.readFileSync(path.join(base, name + '.json'))),
    boot: () => preload({ base, hostRoot, argv: nativeArgv, cwd: '/app', lockTimeoutMs: 1000 }),
    revision: value => write(source, 'host/adapter.mjs', `export const revision=${JSON.stringify(value)};export function installBridgeBodyParser(){};export function registerPaseoBridge(){};export function stopBeforeNativeUninstall(){};`),
  };
}

