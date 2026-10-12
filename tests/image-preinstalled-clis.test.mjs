import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const dockerfile = await readFile(new URL('../image/Dockerfile', import.meta.url), 'utf8');

test('image pins and preinstalls all supported CLIs before switching to the OpenDesign user', () => {
  for (const expected of [
    '@anthropic-ai/claude-code@2.1.296',
    '@openai/codex@0.162.1',
    '@earendil-works/pi-coding-agent@1.1.0',
  ]) assert.ok(dockerfile.includes(expected), `missing pinned package ${expected}`);
  assert.match(dockerfile, /apk add --no-cache[^\n]*python3/);
  assert.match(dockerfile, /USER 1001:1001[\s\S]*RUN[^\n]*claude --version[^\n]*codex --version[^\n]*pi --version/);
});

test('retired Paseo plugin manifests are no longer distributed', async () => {
  await assert.rejects(readFile(new URL('../open-design.json', import.meta.url)), { code: 'ENOENT' });
  await assert.rejects(readFile(new URL('../plugin/open-design.json', import.meta.url)), { code: 'ENOENT' });
});

test('image keeps the native OpenDesign launch command without Paseo adapter injection', () => {
  assert.match(dockerfile, /CMD \["node", "apps\/daemon\/bin\/od\.mjs"/);
  assert.doesNotMatch(dockerfile, /opendesign-agent-runtime|install-host\.mjs|opendesign-paseo|NODE_OPTIONS/);
  assert.doesNotMatch(dockerfile, /COPY .*entrypoint\.sh/);
});
