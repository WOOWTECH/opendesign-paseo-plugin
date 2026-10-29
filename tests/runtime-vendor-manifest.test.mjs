import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256, classify, checkVendor, compareUpstream, manifestProblems, main} from '../scripts/check-vendor.mjs';

const script = path.resolve(import.meta.dirname, '../scripts/check-vendor.mjs');
const write = (dir, files) => {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), {recursive: true});
    fs.writeFileSync(path.join(dir, name), text);
  }
};

// What the base commit had, and what the vendored tree has now.
const BASE = {LICENSE: 'MIT', 'src/same.mjs': 'same', 'src/patched.mjs': 'old', 'src/stale.mjs': 'stale v1'};
const VENDORED = {...BASE, 'src/patched.mjs': 'new', 'src/added.mjs': 'ours'};

/** A vendored tree plus an upstream checkout (the base by default); the manifest is derived from the bytes. */
function fixture(t, {base = BASE, vendored = VENDORED, upstream = base} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-manifest-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const vendorDir = path.join(dir, 'vendor'), upstreamDir = path.join(dir, 'upstream');
  write(vendorDir, vendored);
  write(upstreamDir, upstream);
  const files = {};
  for (const [file, text] of Object.entries(vendored)) {
    const baseSha = Object.hasOwn(base, file) ? sha256(base[file]) : null;
    files[file] = {status: baseSha === null ? 'added' : baseSha === sha256(text) ? 'identical' : 'patched', vendoredSha256: sha256(text), baseSha256: baseSha, summary: `about ${file}`};
  }
  const manifest = {
    repository: 'https://example.invalid/pi-paseo-plugin', commit: 'a'.repeat(40), license: 'MIT', scope: 'test',
    local_patches: Object.entries(files).filter(([, entry]) => entry.status !== 'identical').map(([file]) => ({file, summary: `patch of ${file}`})),
    files,
  };
  fs.writeFileSync(path.join(vendorDir, 'PROVENANCE.json'), JSON.stringify(manifest, null, 2));
  return {vendorDir, upstreamDir, manifest};
}
const states = report => Object.fromEntries(report.results.map(({file, state}) => [file, state]));

test('a manifest derived from the files passes the offline check', t => {
  const {vendorDir} = fixture(t);
  assert.deepEqual(checkVendor(vendorDir), {problems: [], counts: {identical: 3, patched: 1, added: 1}, files: 5});
});

test('the real vendor/pi-paseo matches its manifest', () => {
  assert.deepEqual(checkVendor().problems, []);
});

test('an edit without a manifest update names the file and both hashes', t => {
  const {vendorDir} = fixture(t);
  write(vendorDir, {'src/same.mjs': 'same, edited'});
  assert.deepEqual(checkVendor(vendorDir).problems, [
    `vendor/pi-paseo/src/same.mjs was edited without updating PROVENANCE.json (sha256 ${sha256('same, edited')}, declared ${sha256('same')})`,
  ]);
});

test('an unlisted file and a listed file that is missing both fail', t => {
  const {vendorDir} = fixture(t);
  fs.rmSync(path.join(vendorDir, 'src/added.mjs'));
  write(vendorDir, {'src/new.mjs': 'sneaked in'});
  assert.deepEqual(checkVendor(vendorDir).problems, [
    'vendor/pi-paseo/src/added.mjs is listed in PROVENANCE.json but missing on disk',
    `vendor/pi-paseo/src/new.mjs is not listed in PROVENANCE.json (sha256 ${sha256('sneaked in')})`,
  ]);
});

test('node_modules below the vendored tree is not part of it', t => {
  const {vendorDir} = fixture(t);
  write(vendorDir, {'runtime/node_modules/dependency/index.js': 'installed by npm ci'});
  assert.deepEqual(checkVendor(vendorDir).problems, []);
});

test('a manifest whose entries contradict each other is reported', t => {
  const {manifest} = fixture(t);
  const mutate = change => { const copy = structuredClone(manifest); change(copy); return manifestProblems(copy); };
  const other = 'b'.repeat(64);
  assert.deepEqual(manifestProblems(manifest), []);
  assert.deepEqual(mutate(m => { m.files['src/same.mjs'].baseSha256 = other; }),
    ['files["src/same.mjs"] is declared identical but baseSha256 differs from vendoredSha256']);
  assert.deepEqual(mutate(m => { m.files['src/patched.mjs'].baseSha256 = m.files['src/patched.mjs'].vendoredSha256; }),
    ['files["src/patched.mjs"] is declared patched but baseSha256 is null or equals vendoredSha256']);
  assert.deepEqual(mutate(m => { m.files['src/added.mjs'].baseSha256 = other; }),
    ['files["src/added.mjs"] is declared added but baseSha256 is not null']);
  assert.deepEqual(mutate(m => { m.files['src/same.mjs'].summary = ' '; }), ['files["src/same.mjs"].summary must say what differs']);
  assert.deepEqual(mutate(m => { m.files['src/same.mjs'].status = 'forked'; }), ['files["src/same.mjs"].status must be one of identical, patched, added']);
  assert.deepEqual(mutate(m => { m.local_patches = m.local_patches.filter(patch => patch.file !== 'src/added.mjs'); }),
    ['src/added.mjs is added but has no local_patches entry']);
  assert.deepEqual(mutate(m => { m.local_patches.push({file: 'src/same.mjs', summary: 'x'}); }),
    ['local_patches lists src/same.mjs, which is not a patched or added file in files']);
  assert.deepEqual(mutate(m => { m.local_patches.push(m.local_patches[0]); }), [`local_patches lists ${manifest.local_patches[0].file} twice`]);
  assert.deepEqual(mutate(m => { m.commit = 'main'; }), ['commit must be the 40-character base commit']);
});

test('classify compares the vendored bytes with upstream and with the base', () => {
  const [v, b, u] = ['v', 'b', 'u'].map(sha256);
  assert.equal(classify({vendored: v, base: v, upstream: v}), 'IDENTICAL');
  assert.equal(classify({vendored: v, base: b, upstream: v}), 'IDENTICAL', 'a declared patch that landed upstream');
  assert.equal(classify({vendored: v, base: b, upstream: b}), 'PATCHED');
  assert.equal(classify({vendored: v, base: null, upstream: null}), 'PATCHED', 'a local file upstream does not have');
  assert.equal(classify({vendored: v, base: v, upstream: u}), 'UPSTREAM-AHEAD', 'a pristine copy that went stale');
  assert.equal(classify({vendored: v, base: b, upstream: u}), 'UPSTREAM-AHEAD', 'a patched copy upstream also changed');
  assert.equal(classify({vendored: v, base: v, upstream: null}), 'UPSTREAM-AHEAD', 'removed upstream');
  assert.equal(classify({vendored: v, base: null, upstream: u}), 'UPSTREAM-AHEAD', 'upstream added a file of the same name');
});

test('an upstream still at the base leaves only the declared patches', t => {
  const {vendorDir, upstreamDir} = fixture(t);
  assert.deepEqual(states(compareUpstream({vendorDir, upstreamDir})), {
    LICENSE: 'IDENTICAL', 'src/added.mjs': 'PATCHED', 'src/patched.mjs': 'PATCHED', 'src/same.mjs': 'IDENTICAL', 'src/stale.mjs': 'IDENTICAL',
  });
});

test('an upstream that moved on is reported per file, and files only upstream have are listed', t => {
  const {vendorDir, upstreamDir} = fixture(t);
  write(upstreamDir, {'src/stale.mjs': 'stale v2', 'src/added.mjs': 'theirs', 'src/patched.mjs': 'new', 'src/extra.mjs': 'only upstream'});
  fs.rmSync(path.join(upstreamDir, 'src/same.mjs'));
  const report = compareUpstream({vendorDir, upstreamDir});
  assert.deepEqual(states(report), {
    LICENSE: 'IDENTICAL', 'src/added.mjs': 'UPSTREAM-AHEAD', 'src/patched.mjs': 'IDENTICAL', 'src/same.mjs': 'UPSTREAM-AHEAD', 'src/stale.mjs': 'UPSTREAM-AHEAD',
  });
  assert.equal(report.results.find(row => row.file === 'src/same.mjs').note, 'removed upstream since the base');
  assert.equal(report.results.find(row => row.file === 'src/added.mjs').note, 'upstream has since added a different file of this name');
  assert.deepEqual(report.notVendored, ['src/extra.mjs']);
});

test('a vendored file edited without a manifest update is UNDECLARED against any upstream', t => {
  const {vendorDir, upstreamDir} = fixture(t);
  write(vendorDir, {'src/stale.mjs': 'stale v1, edited here'});
  const row = compareUpstream({vendorDir, upstreamDir}).results.find(({file}) => file === 'src/stale.mjs');
  assert.equal(row.state, 'UNDECLARED');
  assert.match(row.note, /edited without updating PROVENANCE\.json/);
});

test('exit status: ahead or patched passes, undeclared fails, a wrong argument is a usage error', t => {
  const {vendorDir, upstreamDir} = fixture(t);
  write(upstreamDir, {'src/stale.mjs': 'stale v2'});
  const run = argv => {
    const output = [];
    const status = main(argv, {vendorDir, log: line => output.push(line), error: line => output.push(line)});
    return {status, output: output.join('\n')};
  };
  assert.deepEqual(run([]), {status: 0, output: 'Vendored pi-paseo manifest verified: 5 files (3 identical, 1 patched, 1 added)'});
  const ahead = run(['--upstream', upstreamDir]);
  assert.equal(ahead.status, 0);
  assert.match(ahead.output, /UPSTREAM-AHEAD\s+src\/stale\.mjs/);
  assert.match(ahead.output, /IDENTICAL 2, PATCHED 2, UPSTREAM-AHEAD 1, UNDECLARED 0/);
  write(vendorDir, {'src/same.mjs': 'edited'});
  const undeclared = run(['--upstream', upstreamDir]);
  assert.equal(undeclared.status, 1);
  assert.match(undeclared.output, /UNDECLARED\s+src\/same\.mjs/);
  assert.equal(run([]).status, 1, 'the offline check fails on the same edit');
  assert.equal(run(['--bogus']).status, 2);
  assert.equal(run(['--upstream']).status, 2);
  assert.equal(run(['--upstream', path.join(upstreamDir, 'missing')]).status, 2);
  const unrelated = path.join(path.dirname(upstreamDir), 'unrelated');
  write(unrelated, {'README.md': 'not pi-paseo-plugin'});
  assert.equal(run(['--upstream', unrelated]).status, 2);
});

test('the command line verifies the real vendor/pi-paseo', () => {
  const result = spawnSync(process.execPath, [script], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Vendored pi-paseo manifest verified: \d+ files/);
});
