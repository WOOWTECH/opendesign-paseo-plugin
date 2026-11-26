import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { prepareRuntimeManifest, runtimeDirectory, markRuntimeReady, runtimeReady, PASEO_VERSION, RUNTIME_REVISION } from '../vendor/pi-paseo/src/runtime-layout.mjs';

// Run in the target image/platform: node-pty contains platform native code.
const runtimeDir = process.argv[2];
if (process.argv.length !== 3 || !runtimeDir || !path.isAbsolute(runtimeDir)) throw new Error('ABSOLUTE_RUNTIME_DIRECTORY_REQUIRED');
const loc = { runtimeDir };
const root = prepareRuntimeManifest(loc);
const install = spawnSync('npm', ['ci', '--prefix', root, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  stdio: 'pipe', encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024,
});
if (install.status !== 0) throw new Error('LOCKED_RUNTIME_INSTALL_FAILED');
const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
{
  // node-pty ships a linux-x64 glibc prebuild under a libc-neutral directory.
  // It loads through gcompat on Alpine but crashes at the first PTY spawn.
  // Its supported installer flag removes that prebuild and builds for musl.
  // This is the only reviewed dependency whose lifecycle scripts may run.
  const rebuild = spawnSync('npm', ['rebuild', '--prefix', root, 'node-pty', '--ignore-scripts=false', '--no-audit', '--no-fund'], {
    env: { ...process.env, ...(musl ? { npm_config_build_from_source: 'true' } : {}) },
    stdio: 'pipe', encoding: 'utf8', timeout: 600000, maxBuffer: 4 * 1024 * 1024,
  });
  if (rebuild.status !== 0) throw new Error('NATIVE_NODE_PTY_BUILD_FAILED');
}
for (const name of ['cli', 'client', 'server', 'protocol']) {
  if (JSON.parse(fs.readFileSync(path.join(root, 'node_modules/@getpaseo', name, 'package.json'))).version !== PASEO_VERSION) throw new Error('RUNTIME_PACKAGE_VERSION_MISMATCH');
}
const check = spawnSync(process.execPath, [path.join(root, 'node_modules/@getpaseo/cli/bin/paseo'), '--version'], {
  encoding: 'utf8', timeout: 20000, maxBuffer: 65536,
});
if (check.status !== 0 || check.stdout.trim() !== PASEO_VERSION) throw new Error('RUNTIME_CLI_NOT_EXECUTABLE');
if (!fs.existsSync(path.join(root, 'node_modules/@getpaseo/server/dist/server/web-ui/index.html'))) throw new Error('RUNTIME_WEB_UI_MISSING');
const require = createRequire(path.join(root, 'package.json'));
const pty = require('node-pty');
await new Promise((resolve, reject) => {
  let output = '';
  const terminal = pty.spawn('/bin/sh', ['-c', 'printf OPENDESIGN_NATIVE_PTY_OK'], { name: 'xterm', cols: 80, rows: 24, cwd: '/tmp', env: { PATH: '/usr/local/bin:/usr/bin:/bin' } });
  const timer = setTimeout(() => { terminal.kill(); reject(new Error('NATIVE_PTY_TIMEOUT')); }, 10000);
  terminal.onData(chunk => { output += chunk; });
  terminal.onExit(({ exitCode }) => { clearTimeout(timer); exitCode === 0 && output.includes('OPENDESIGN_NATIVE_PTY_OK') ? resolve() : reject(new Error('NATIVE_PTY_FAILED')); });
});
markRuntimeReady(loc);
if (!runtimeReady(loc)) throw new Error('RUNTIME_RECEIPT_NOT_READY');
const lockSha256 = createHash('sha256').update(fs.readFileSync(path.join(runtimeDirectory(loc), 'package-lock.json'))).digest('hex');
console.log(JSON.stringify({ version: PASEO_VERSION, revision: RUNTIME_REVISION, lockSha256, nativePty: true, nodePtyBuiltForMusl: musl, ready: true }));
