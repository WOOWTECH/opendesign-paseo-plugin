import { readFile } from 'node:fs/promises';
const dockerfile = await readFile(new URL('../image/Dockerfile', import.meta.url), 'utf8');
for (const pkg of ['@anthropic-ai/claude-code@2.1.296', '@openai/codex@0.162.1', '@earendil-works/pi-coding-agent@1.1.0']) {
  if (!dockerfile.includes(pkg)) throw new Error(`missing pinned CLI: ${pkg}`);
}
for (const command of ['claude --version', 'codex --version', 'pi --version']) {
  if (!dockerfile.includes(command)) throw new Error(`missing build-time CLI check: ${command}`);
}
if (/opendesign-agent-runtime|install-host\\.mjs|opendesign-paseo|NODE_OPTIONS/.test(dockerfile)) throw new Error('retired Paseo integration remains in the image');
console.log('OpenDesign image contract verified');
