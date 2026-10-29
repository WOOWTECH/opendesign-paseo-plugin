#!/usr/bin/env node
// vendor/pi-paseo is a declared fork of WOOWTECH/pi-paseo-plugin: vendor/pi-paseo/PROVENANCE.json lists every
// vendored file with its state against the recorded base commit (identical, patched or added) and its sha256.
//
//   node scripts/check-vendor.mjs                       offline: every file listed, every listing present, bytes match
//   node scripts/check-vendor.mjs --upstream <dir>      also compare with a checkout of pi-paseo-plugin at any commit
//
// With --upstream each file is IDENTICAL (same bytes as upstream), PATCHED (upstream is still the base, only our
// declared change differs), UPSTREAM-AHEAD (upstream changed, removed or newly added the file since the base) or
// UNDECLARED (not listed, listed but missing, or edited without updating the manifest). Only UNDECLARED, or a
// malformed manifest, fails; the other states are information for the next sync.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export const VENDOR_DIR = path.join(root, 'vendor/pi-paseo');
const LABEL = 'vendor/pi-paseo';
const MANIFEST = 'PROVENANCE.json';
const STATUSES = ['identical', 'patched', 'added'];
const SHA256 = /^[0-9a-f]{64}$/;
const USAGE = 'Usage: node scripts/check-vendor.mjs [--upstream <pi-paseo-plugin checkout>]';

/** A wrong argument or directory, as opposed to a finding about the vendored files. */
class UsageError extends Error {}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function shaOrNull(file) {
  try { return sha256(fs.readFileSync(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Files below dir/prefix as paths relative to dir; node_modules is never part of a vendored tree. */
function listFiles(dir, prefix = '') {
  const found = [];
  const entries = fs.readdirSync(path.join(dir, prefix), {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') found.push(...listFiles(dir, relative)); }
    else found.push({file: relative, regular: entry.isFile()});
  }
  return found;
}

export function readManifest(vendorDir = VENDOR_DIR) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, MANIFEST), 'utf8')); }
  catch (error) { throw new Error(`${LABEL}/${MANIFEST} cannot be read: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`${LABEL}/${MANIFEST} must be a JSON object`);
  return manifest;
}

/** Structural problems in the manifest itself, independent of the files on disk. */
export function manifestProblems(manifest) {
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(manifest.commit ?? '')) problems.push('commit must be the 40-character base commit');
  const files = manifest.files;
  if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) {
    return [...problems, 'files must map every vendored file to its entry'];
  }
  const changed = new Map();
  for (const [file, entry] of Object.entries(files)) {
    const where = `files["${file}"]`;
    if (!STATUSES.includes(entry?.status)) { problems.push(`${where}.status must be one of ${STATUSES.join(', ')}`); continue; }
    if (!SHA256.test(entry.vendoredSha256 ?? '')) problems.push(`${where}.vendoredSha256 must be a sha256 hex digest`);
    if (entry.baseSha256 !== null && !SHA256.test(entry.baseSha256 ?? '')) problems.push(`${where}.baseSha256 must be a sha256 hex digest or null`);
    if (typeof entry.summary !== 'string' || !entry.summary.trim()) problems.push(`${where}.summary must say what differs`);
    if (entry.status === 'identical' && entry.baseSha256 !== entry.vendoredSha256) problems.push(`${where} is declared identical but baseSha256 differs from vendoredSha256`);
    if (entry.status === 'patched' && (entry.baseSha256 === null || entry.baseSha256 === entry.vendoredSha256)) problems.push(`${where} is declared patched but baseSha256 is null or equals vendoredSha256`);
    if (entry.status === 'added' && entry.baseSha256 !== null) problems.push(`${where} is declared added but baseSha256 is not null`);
    if (entry.status !== 'identical') changed.set(file, entry.status);
  }
  const listed = new Set();
  if (!Array.isArray(manifest.local_patches)) problems.push('local_patches must be an array with one entry per patched or added file');
  for (const patch of Array.isArray(manifest.local_patches) ? manifest.local_patches : []) {
    if (listed.has(patch?.file)) problems.push(`local_patches lists ${patch.file} twice`);
    listed.add(patch?.file);
    if (!changed.has(patch?.file)) problems.push(`local_patches lists ${patch?.file}, which is not a patched or added file in files`);
  }
  for (const [file, status] of changed) if (!listed.has(file)) problems.push(`${file} is ${status} but has no local_patches entry`);
  return problems;
}

/** One row per file that is listed or present; `issue` says why a row is UNDECLARED. */
export function inspectVendor(vendorDir = VENDOR_DIR) {
  const manifest = readManifest(vendorDir);
  const declared = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  const onDisk = new Map(listFiles(vendorDir).filter(({file}) => file !== MANIFEST).map(item => [item.file, item]));
  const rows = [...new Set([...Object.keys(declared), ...onDisk.keys()])].sort().map(file => {
    const entry = declared[file];
    const disk = onDisk.get(file);
    if (!disk) return {file, entry, issue: 'is listed in PROVENANCE.json but missing on disk'};
    if (!disk.regular) return {file, entry, issue: 'is not a regular file'};
    const actual = sha256(fs.readFileSync(path.join(vendorDir, file)));
    if (!entry) return {file, entry, issue: `is not listed in PROVENANCE.json (sha256 ${actual})`};
    if (actual !== entry.vendoredSha256) return {file, entry, issue: `was edited without updating PROVENANCE.json (sha256 ${actual}, declared ${entry.vendoredSha256})`};
    return {file, entry, issue: null};
  });
  return {manifest, rows};
}

/** Offline check: every problem as a message; an empty list means the manifest and the files agree. */
export function checkVendor(vendorDir = VENDOR_DIR) {
  const {manifest, rows} = inspectVendor(vendorDir);
  const problems = [...manifestProblems(manifest), ...rows.filter(row => row.issue).map(row => `${LABEL}/${row.file} ${row.issue}`)];
  const counts = {identical: 0, patched: 0, added: 0};
  for (const row of rows) if (!row.issue && Object.hasOwn(counts, row.entry.status)) counts[row.entry.status]++;
  return {problems, counts, files: rows.length};
}

/** `base` and `upstream` are sha256 values, null when the file did not exist at the base or does not exist upstream. */
export function classify({vendored, base, upstream}) {
  if (upstream === vendored) return 'IDENTICAL';
  if (upstream === base) return 'PATCHED';
  return 'UPSTREAM-AHEAD';
}

function noteFor(state, status, base, upstream) {
  if (state === 'IDENTICAL') return status === 'identical' ? '' : `declared ${status}; upstream now has the same bytes`;
  if (state === 'PATCHED') return status === 'added' ? 'local file, not in upstream' : 'only the declared patch differs';
  if (upstream === null) return 'removed upstream since the base';
  if (base === null) return 'upstream has since added a different file of this name';
  return status === 'identical' ? 'upstream changed since the base; the vendored copy is stale' : 'upstream changed since the base; re-check the patch';
}

/** Files in the upstream directories that the manifest covers but does not list (informational). */
function notVendored(declared, upstreamDir) {
  const directories = new Set(Object.keys(declared).map(file => path.posix.dirname(file)).filter(directory => directory !== '.'));
  const extra = [];
  for (const directory of directories) {
    if (!fs.existsSync(path.join(upstreamDir, directory))) continue;
    for (const {file} of listFiles(upstreamDir, directory)) if (!Object.hasOwn(declared, file)) extra.push(file);
  }
  return extra.sort();
}

export function compareUpstream({vendorDir = VENDOR_DIR, upstreamDir}) {
  const {manifest, rows} = inspectVendor(vendorDir);
  const results = rows.map(row => {
    if (row.issue) return {file: row.file, state: 'UNDECLARED', declared: row.entry?.status ?? '-', note: row.issue};
    const {status, vendoredSha256: vendored, baseSha256: base} = row.entry;
    const upstream = shaOrNull(path.join(upstreamDir, row.file));
    const state = classify({vendored, base, upstream});
    return {file: row.file, state, declared: status, note: noteFor(state, status, base, upstream), present: upstream !== null};
  });
  const compared = results.filter(result => result.state !== 'UNDECLARED');
  if (compared.length && !compared.some(result => result.present)) {
    throw new UsageError(`none of the vendored files exists under ${upstreamDir}; is it a checkout of pi-paseo-plugin?`);
  }
  return {results, manifestProblems: manifestProblems(manifest), notVendored: notVendored(manifest.files ?? {}, upstreamDir)};
}

function formatTable(results) {
  const rows = [{state: 'STATE', file: 'FILE', declared: 'DECLARED', note: 'NOTE'}, ...results];
  const width = key => Math.max(...rows.map(row => row[key].length));
  return rows.map(row => `${row.state.padEnd(width('state'))}  ${row.file.padEnd(width('file'))}  ${row.declared.padEnd(width('declared'))}  ${row.note}`.trimEnd()).join('\n');
}

export function main(argv = process.argv.slice(2), {vendorDir = VENDOR_DIR, log = console.log, error = console.error} = {}) {
  let upstreamDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--upstream' && argv[i + 1]) upstreamDir = path.resolve(argv[++i]);
    else if (argv[i] === '--help') { log(USAGE); return 0; }
    else { error(USAGE); return 2; }
  }
  try {
    if (!upstreamDir) {
      const {problems, counts, files} = checkVendor(vendorDir);
      if (problems.length) { error(problems.join('\n')); return 1; }
      log(`Vendored pi-paseo manifest verified: ${files} files (${counts.identical} identical, ${counts.patched} patched, ${counts.added} added)`);
      return 0;
    }
    if (!fs.statSync(upstreamDir, {throwIfNoEntry: false})?.isDirectory()) throw new UsageError(`${upstreamDir} is not a directory`);
    const report = compareUpstream({vendorDir, upstreamDir});
    log(formatTable(report.results));
    const tally = state => report.results.filter(result => result.state === state).length;
    log(`\n${['IDENTICAL', 'PATCHED', 'UPSTREAM-AHEAD', 'UNDECLARED'].map(state => `${state} ${tally(state)}`).join(', ')}`);
    if (report.notVendored.length) log(`Only in upstream, not vendored: ${report.notVendored.join(', ')}`);
    if (report.manifestProblems.length) error(report.manifestProblems.join('\n'));
    return tally('UNDECLARED') || report.manifestProblems.length ? 1 : 0;
  } catch (failure) {
    error(failure.message);
    return failure instanceof UsageError ? 2 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
