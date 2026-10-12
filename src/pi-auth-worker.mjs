import readline from 'node:readline';
import { environmentContext, safeError } from './runtime-context.mjs';
import { runPiOAuth } from './pi-oauth.mjs';
import { officialAuthorizationUrl } from './auth-flow.mjs';
import { RuntimeError } from '../vendor/pi-paseo/src/state.mjs';

const controller = new AbortController();
process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
const timeout = setTimeout(() => controller.abort(), 300000); timeout.unref();
const input = readline.createInterface({ input: process.stdin, terminal: false });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let pending;
const clearPrompt = () => { const current = pending; pending = undefined; current?.cleanup(); };
input.on('line', line => {
  if (Buffer.byteLength(line) > 4096) { controller.abort(); return; }
  try {
    const value = JSON.parse(line);
    if (value.action !== 'complete' || typeof value.code !== 'string' || !value.code.trim() || value.code.length > 2048 || /[\x00-\x1f]/.test(value.code) || !pending) return;
    const resolve = pending.resolve; clearPrompt(); resolve(value.code);
  } catch { controller.abort(); }
});
try {
  const context = environmentContext();
  await runPiOAuth(context, {
    signal: controller.signal,
    notify: value => {
      if (value.authorizationUrl) {
        const url = officialAuthorizationUrl(value.authorizationUrl, 'codex');
        if (!url) throw new RuntimeError('PROVIDER_LOGIN_FAILED');
        send({ phase: value.phase, authorizationUrl: url, ...(value.deviceCode ? { deviceCode: value.deviceCode } : {}) });
      } else send({ phase: value.phase });
    },
    prompt: ({ signal }) => new Promise((resolve, reject) => {
      if (pending) { reject(new RuntimeError('OPERATION_BUSY')); return; }
      const cancel = () => { clearPrompt(); reject(new RuntimeError('OPERATION_ABORTED')); };
      pending = { resolve, cleanup: () => { controller.signal.removeEventListener('abort', cancel); signal?.removeEventListener('abort', cancel); } };
      controller.signal.addEventListener('abort', cancel, { once: true }); signal?.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted || signal?.aborted) { cancel(); return; }
      send({ phase: 'awaiting_authorization', requiresCode: true, inputKind: 'redirect_url_or_code' });
    }),
  });
} catch (error) {
  send({ phase: controller.signal.aborted ? 'cancelled' : 'error', code: safeError(error).code });
  process.exitCode = 1;
} finally { clearTimeout(timeout); clearPrompt(); input.close(); }
