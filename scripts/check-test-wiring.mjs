#!/usr/bin/env node
// Fails when a tests/*.test.mjs file is run by nothing. Every one must match a path or glob that a `test*` npm
// script in package.json passes to the runner, or be listed with a reason in tests/LEGACY.txt.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(import.meta.dirname, '..');

/** Only `*` and `?` (never across a `/`), which is what the test scripts use and the shell expands. */
export function globToRegExp(glob) {
  const source = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${source}$`);
}

/** Every tests/... path or glob mentioned by a `test` or `test:*` script. */
export function testScriptPatterns(scripts) {
  const patterns = [];
  for (const [name, command] of Object.entries(scripts)) {
    if (!/^test(?::|$)/.test(name)) continue;
    for (const match of command.match(/(?:\.\/)?tests\/[^\s"'&|;<>()]+/g) ?? []) patterns.push(match.replace(/^\.\//, ''));
  }
  return patterns;
}

/** One entry per line: `<path> <reason>`. Blank lines and lines starting with # are ignored. */
export function parseLegacy(text) {
  const entries = [];
  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const [file, ...reason] = trimmed.split(/\s+/);
    entries.push({file, reason: reason.join(' '), line: index + 1});
  });
  return entries;
}

export function wiringProblems({scripts, testFiles, legacyText}) {
  const matchers = testScriptPatterns(scripts).map(globToRegExp);
  const wired = file => matchers.some(matcher => matcher.test(file));
  const problems = [];
  const listed = new Set();
  for (const {file, reason, line} of parseLegacy(legacyText)) {
    const where = `tests/LEGACY.txt:${line}: ${file}`;
    if (listed.has(file)) problems.push(`${where} is listed twice`);
    listed.add(file);
    if (!testFiles.includes(file)) problems.push(`${where} does not exist`);
    else if (wired(file)) problems.push(`${where} is already run by a test* npm script; remove the entry`);
    if (!reason) problems.push(`${where} has no reason`);
  }
  for (const file of testFiles) {
    if (!wired(file) && !listed.has(file)) problems.push(`${file} is not run by any test* npm script and is not listed in tests/LEGACY.txt`);
  }
  return problems;
}

export function main() {
  const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
  const testFiles = fs.readdirSync(path.join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
  const legacyFile = path.join(root, 'tests/LEGACY.txt');
  const legacyText = fs.existsSync(legacyFile) ? fs.readFileSync(legacyFile, 'utf8') : '';
  const problems = wiringProblems({scripts, testFiles, legacyText});
  if (problems.length) {
    console.error(problems.join('\n'));
    return 1;
  }
  const legacy = parseLegacy(legacyText).length;
  console.log(`Test wiring verified: ${testFiles.length} test files (${testFiles.length - legacy} run by test* scripts, ${legacy} listed in tests/LEGACY.txt)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
