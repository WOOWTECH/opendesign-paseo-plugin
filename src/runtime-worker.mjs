import fs from 'node:fs';
import path from 'node:path';
import * as runtime from '../vendor/pi-paseo/src/runtime.mjs';
import { RuntimeError } from '../vendor/pi-paseo/src/state.mjs';
import { environmentContext, safeError } from './runtime-context.mjs';
import { installProviders } from './provider-install.mjs';
import { publicStatus, publicModels, publicAcceptance, publicChat } from './public-dto.mjs';

export async function executeRuntimeJob(context, { action, input = {} }, engine = runtime) {
  if (action === 'enable') {
    await installProviders(context);
    return publicStatus(await engine.activate());
  }
  if (action === 'disable') return publicStatus(await engine.deactivate());
  if (action === 'status' || action === 'diagnose') {
    const value = action === 'diagnose' ? await engine.diagnose() : await engine.status();
    const result = publicStatus(value);
    const homes = { claude: path.join(context.env.CLAUDE_CONFIG_DIR, '.credentials.json'), codex: path.join(context.env.CODEX_HOME, 'auth.json'), pi: path.join(context.env.PI_CODING_AGENT_DIR, 'auth.json') };
    for (const row of result.providers) row.credentialPresent = fs.existsSync(homes[row.provider]);
    return result;
  }
  if (action === 'models') return publicModels(await engine.listModels(input.provider), context.env);
  if (action === 'acceptance') return publicAcceptance(await engine.acceptance(input));
  if (action === 'createchat') return publicChat(await engine.createChat(input), context.env);
  if (action === 'continue') return publicChat(await engine.continueChat(input), context.env);
  if (action === 'pair') {
    const offer = await engine.pair();
    let url;
    try { url = new URL(offer.url); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
    if (url.protocol !== 'https:' || url.hostname !== 'app.paseo.sh' || url.port || url.username || url.password) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
    return { url: url.href, createdAt: new Date().toISOString() };
  }
  throw new RuntimeError('INVALID_RUNTIME_ACTION');
}

// A single bounded IPC job; npm/provider output never goes to the host stdout.
if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    let body = '';
    for await (const chunk of process.stdin) {
      body += chunk;
      if (Buffer.byteLength(body) > 128 * 1024) throw new RuntimeError('INVALID_RUNTIME_INPUT');
    }
    const result = await executeRuntimeJob(environmentContext(), JSON.parse(body));
    process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: safeError(error).code }) + '\n');
    process.exitCode = 1;
  }
}
