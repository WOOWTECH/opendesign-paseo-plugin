import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {globToRegExp, testScriptPatterns, parseLegacy, wiringProblems} from '../scripts/check-test-wiring.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('globs match within one path segment and treat dots literally', () => {
  const glob = globToRegExp('tests/launcher-*.test.mjs');
  assert.ok(glob.test('tests/launcher-http.test.mjs'));
  assert.ok(!glob.test('tests/launcher/http.test.mjs'));
  assert.ok(!glob.test('tests/host-launcher-x.test.mjs'));
  assert.ok(!glob.test('tests/launcher-httpXtest.mjs'));
  assert.ok(globToRegExp('tests/ui?.test.mjs').test('tests/uis.test.mjs'));
  assert.ok(!globToRegExp('tests/ui.test.mjs').test('tests/uiXtest.mjs'));
});

test('only test and test:* scripts contribute patterns', () => {
  const scripts = {
    test: 'node --test tests/a.test.mjs && npm run test:launcher',
    'test:launcher': 'node --test ./tests/launcher-*.test.mjs tests/b.test.mjs',
    'check:tests': 'node scripts/check-test-wiring.mjs tests/ignored.test.mjs',
    start: 'node tests/not-a-test-script.test.mjs',
  };
  assert.deepEqual(testScriptPatterns(scripts), ['tests/a.test.mjs', 'tests/launcher-*.test.mjs', 'tests/b.test.mjs']);
});

test('legacy entries need a path and a reason; comments and blank lines are ignored', () => {
  const entries = parseLegacy('# comment\n\ntests/a.test.mjs needs flock on PATH\ntests/b.test.mjs\n');
  assert.deepEqual(entries, [
    {file: 'tests/a.test.mjs', reason: 'needs flock on PATH', line: 3},
    {file: 'tests/b.test.mjs', reason: '', line: 4},
  ]);
});

test('an unwired, unlisted file is reported; wired and listed files are not', () => {
  const scripts = {test: 'node --test tests/launcher-*.test.mjs'};
  const testFiles = ['tests/launcher-a.test.mjs', 'tests/orphan.test.mjs', 'tests/old.test.mjs'];
  assert.deepEqual(wiringProblems({scripts, testFiles, legacyText: 'tests/old.test.mjs fails: retired\n'}), [
    'tests/orphan.test.mjs is not run by any test* npm script and is not listed in tests/LEGACY.txt',
  ]);
  assert.deepEqual(wiringProblems({scripts, testFiles, legacyText: 'tests/old.test.mjs retired\ntests/orphan.test.mjs flaky\n'}), []);
});

test('stale, redundant, duplicate and reasonless legacy entries are reported', () => {
  const scripts = {test: 'node --test tests/a.test.mjs'};
  const testFiles = ['tests/a.test.mjs', 'tests/b.test.mjs'];
  const legacyText = [
    'tests/a.test.mjs now wired',
    'tests/gone.test.mjs deleted long ago',
    'tests/b.test.mjs',
    'tests/b.test.mjs listed twice',
  ].join('\n');
  assert.deepEqual(wiringProblems({scripts, testFiles, legacyText}), [
    'tests/LEGACY.txt:1: tests/a.test.mjs is already run by a test* npm script; remove the entry',
    'tests/LEGACY.txt:2: tests/gone.test.mjs does not exist',
    'tests/LEGACY.txt:3: tests/b.test.mjs has no reason',
    'tests/LEGACY.txt:4: tests/b.test.mjs is listed twice',
  ]);
});

test('this repository has no unwired test file', () => {
  const result = spawnSync(process.execPath, ['scripts/check-test-wiring.mjs'], {cwd: root, encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Test wiring verified: \d+ test files/);
});
