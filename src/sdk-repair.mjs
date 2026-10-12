import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeError, assertSafePath, atomicJson } from '../vendor/pi-paseo/src/state.mjs';
import { sourceRoot, contained } from './runtime-context.mjs';

export const PI_REPAIR = '5.0.12';
function manifest(root) { assertSafePath(path.join(root, 'package.json')); return JSON.parse(fs.readFileSync(path.join(root, 'package.json'))); }
function digest(root, { excludeModules = false } = {}) {
  const hash = createHash('sha256');
  const visit = (directory, prefix = '') => {
    assertSafePath(directory);
    for (const row of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excludeModules && row.name === 'node_modules') continue;
      const file = path.join(directory, row.name), relative = prefix + row.name;
      assertSafePath(file);
      if (row.isDirectory()) visit(file, relative + '/');
      else if (row.isFile()) { hash.update(relative + '\0'); hash.update(fs.readFileSync(file)); }
      else throw new RuntimeError('PROVIDER_REPAIR_FAILED');
    }
  };
  visit(root); return hash.digest('hex');
}
function repairSource(packageRoot) {
  const require = createRequire(path.join(packageRoot, 'package.json'));
  const brace = path.dirname(require.resolve('brace-expansion/package.json'));
  const balanced = path.dirname(createRequire(path.join(brace, 'package.json')).resolve('balanced-match/package.json'));
  if (manifest(brace).name !== 'brace-expansion' || manifest(brace).version !== PI_REPAIR || manifest(balanced).name !== 'balanced-match' || !manifest(balanced).version.startsWith('4.')) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
  return { brace, balanced, braceHash: digest(brace, { excludeModules: true }), balancedHash: digest(balanced, { excludeModules: true }) };
}
function targets(release) {
  const sdk = path.join(release, 'node_modules/@earendil-works/pi-coding-agent');
  if (manifest(sdk).name !== '@earendil-works/pi-coding-agent' || manifest(sdk).version !== '1.0.0') throw new RuntimeError('PROVIDER_REPAIR_FAILED');
  const found = new Set(); let minimatches = 0;
  const visit = directory => {
    if (!fs.existsSync(directory)) return;
    assertSafePath(directory);
    for (const row of fs.readdirSync(directory, { withFileTypes: true })) {
      if (row.name.startsWith('.')) continue;
      const root = path.join(directory, row.name);
      assertSafePath(root);
      if (!row.isDirectory()) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
      if (row.name.startsWith('@')) { visit(root); continue; }
      const pkg = manifest(root);
      if (pkg.name === 'minimatch' && /^10\./.test(pkg.version)) {
        minimatches++;
        const target = path.dirname(createRequire(path.join(root, 'package.json')).resolve('brace-expansion/package.json'));
        if (!contained(release, target)) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
        const dependency = manifest(target);
        if (dependency.name !== 'brace-expansion' || !/^5\./.test(dependency.version)) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
        found.add(target);
      }
      visit(path.join(root, 'node_modules'));
    }
  };
  visit(path.join(release, 'node_modules'));
  if (!minimatches) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
  return [...found];
}
function verified(target, source) {
  return manifest(target).version === PI_REPAIR && digest(target, { excludeModules: true }) === source.braceHash && digest(path.join(target, 'node_modules/balanced-match'), { excludeModules: true }) === source.balancedHash;
}

/** Pi's embedded shrinkwrap can bypass npm overrides: repair only actual minimatch 10 dependencies. */
export function repairPiSdk(release, packageRoot = sourceRoot) {
  assertSafePath(release);
  try {
    const source = repairSource(packageRoot), repaired = [];
    for (const target of targets(release)) {
      let ready = false; try { ready = verified(target, source); } catch {}
      if (!ready) {
        const stage = target + '.' + randomUUID() + '.stage', backup = stage + '.old';
        try {
          fs.cpSync(source.brace, stage, { recursive: true, filter: file => { assertSafePath(file); return true; } });
          fs.mkdirSync(path.join(stage, 'node_modules'), { recursive: true });
          fs.cpSync(source.balanced, path.join(stage, 'node_modules/balanced-match'), { recursive: true, filter: file => { assertSafePath(file); return true; } });
          if (!verified(stage, source)) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
          fs.renameSync(target, backup);
          try { fs.renameSync(stage, target); } catch (error) { fs.renameSync(backup, target); throw error; }
          fs.rmSync(backup, { recursive: true });
        } finally { fs.rmSync(stage, { recursive: true, force: true }); }
      }
      repaired.push(path.relative(release, target));
    }
    atomicJson(path.join(release, '.pi-sdk-repair.json'), { version: PI_REPAIR, braceHash: source.braceHash, balancedHash: source.balancedHash, targets: repaired });
    return { version: PI_REPAIR, targets: repaired };
  } catch { throw new RuntimeError('PROVIDER_REPAIR_FAILED'); }
}

/** Validate installed bytes, not lock metadata; older minimatch families are left alone. */
export function piRepaired(release, packageRoot = sourceRoot) {
  try { const source = repairSource(packageRoot); return targets(release).every(target => verified(target, source)); }
  catch { return false; }
}
