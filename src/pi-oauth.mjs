import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { RuntimeError, assertSafePath } from '../vendor/pi-paseo/src/state.mjs';
import { providerRelease, piRepaired } from './provider-install.mjs';
import { findExecutable } from '../vendor/pi-paseo/src/process.mjs';

export const piOAuthProvider = 'openai-codex';

function preinstalledCodingRoot(context) {
  const executable = findExecutable('pi', context.env);
  if (!executable) throw new RuntimeError('PROVIDER_UNAVAILABLE');
  const entry = fs.realpathSync(executable);
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 6 && directory !== path.dirname(directory); depth++) {
    const file = path.join(directory, 'package.json');
    assertSafePath(file);
    if (fs.existsSync(file)) {
      const pkg = JSON.parse(fs.readFileSync(file));
      if (pkg.name === '@earendil-works/pi-coding-agent') {
        if (pkg.version !== '1.1.0') throw new RuntimeError('PROVIDER_VERSION_MISMATCH');
        if (typeof pkg.bin?.pi !== 'string' || path.resolve(directory, pkg.bin.pi) !== entry) throw new RuntimeError('PROVIDER_UNAVAILABLE');
        return directory;
      }
    }
    directory = path.dirname(directory);
  }
  throw new RuntimeError('PROVIDER_UNAVAILABLE');
}

/** Version-specific official SDK exports; never infer or serialize token JSON here. */
export async function loadPiOAuth(context) {
  const release = providerRelease(context, 'pi');
  const managedRoot = path.join(release, 'node_modules/@earendil-works/pi-coding-agent');
  assertSafePath(path.join(managedRoot, 'package.json'));
  try {
    const managed = fs.existsSync(path.join(managedRoot, 'package.json'));
    const codingRoot = managed ? managedRoot : preinstalledCodingRoot(context);
    const version = managed ? '1.0.0' : '1.1.0';
    if (managed && (JSON.parse(fs.readFileSync(path.join(codingRoot, 'package.json'))).version !== version || !piRepaired(release, context.packageRoot))) throw new RuntimeError('PROVIDER_REPAIR_FAILED');
    const require = createRequire(path.join(codingRoot, 'package.json'));
    // The reviewed AI package exposes this provider only under the import
    // condition, so CommonJS require.resolve() cannot select it. Locate its
    // manifest through Node's package search order, then use its ESM export.
    const aiRoot = (require.resolve.paths('@earendil-works/pi-ai') || [])
      .map(root => path.join(root, '@earendil-works/pi-ai'))
      .find(root => fs.existsSync(path.join(root, 'package.json')));
    if (!aiRoot) throw new RuntimeError('PROVIDER_UNAVAILABLE');
    assertSafePath(path.join(aiRoot, 'package.json'));
    const ai = JSON.parse(fs.readFileSync(path.join(aiRoot, 'package.json')));
    if (ai.name !== '@earendil-works/pi-ai' || ai.version !== (managed ? '1.0.0' : '1.4.0')) throw new RuntimeError('PROVIDER_VERSION_MISMATCH');
    if (ai.exports?.['./providers/*']?.import !== './dist/providers/*.js') throw new RuntimeError('PROVIDER_UNAVAILABLE');
    const providerFile = path.join(aiRoot, 'dist/providers/openai-codex.js');
    assertSafePath(providerFile);
    const storageFile = path.join(codingRoot, 'dist/core/auth-storage.js'); assertSafePath(storageFile);
    const [{ AuthStorage }, { openaiCodexProvider }] = await Promise.all([import(pathToFileURL(storageFile).href), import(pathToFileURL(providerFile).href)]);
    const oauth = openaiCodexProvider().auth?.oauth;
    if (typeof AuthStorage?.create !== 'function' || typeof oauth?.login !== 'function') throw new RuntimeError('PROVIDER_LOGIN_FAILED');
    return { AuthStorage, oauth, providerId: piOAuthProvider };
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError('PROVIDER_UNAVAILABLE');
  }
}

/** SDK callback/credential lifecycle, testable without an account or a network request. */
export async function runPiOAuth(context, { signal, notify, prompt, load = loadPiOAuth } = {}) {
  signal?.throwIfAborted();
  const authPath = path.join(context.env.PI_CODING_AGENT_DIR, 'auth.json');
  assertSafePath(authPath);
  const { AuthStorage, oauth, providerId } = await load(context);
  signal?.throwIfAborted();
  const storage = AuthStorage.create(authPath);
  if ((await storage.list({ signal })).some(row => row.providerId === providerId)) {
    notify({ phase: 'credential_present' });
    return;
  }
  const credentials = await oauth.login({
    signal,
    notify: event => {
      if (event.type === 'auth_url') notify({ phase: 'awaiting_authorization', authorizationUrl: event.url });
      if (event.type === 'device_code') notify({ phase: 'awaiting_authorization', authorizationUrl: event.verificationUri, deviceCode: event.userCode });
    },
    prompt: async request => {
      if (request.type === 'select') {
        if (!request.options?.some(option => option.id === 'browser')) throw new RuntimeError('PROVIDER_LOGIN_FAILED');
        return 'browser';
      }
      if (request.type !== 'manual_code') throw new RuntimeError('PROVIDER_LOGIN_FAILED');
      return prompt({ signal: request.signal });
    },
  });
  signal?.throwIfAborted();
  assertSafePath(authPath);
  // Official storage merges this single provider and preserves every other entry.
  // A concurrent tenant login wins; do not replace the credential it just created.
  await storage.modify(providerId, async current => current ? undefined : credentials, { signal });
  notify({ phase: 'authorization_completed' });
}
