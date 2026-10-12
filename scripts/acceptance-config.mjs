#!/usr/bin/env node
/** Print a template only. Never read credentials, create private files, or infer login. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact explicit authorization; URL or account access never grants target authority. */
export function authorizedTargetMatches(target, allowed) {
  if (!target || !allowed || typeof target !== 'object' || typeof allowed !== 'object') return false;
  if (!Number.isSafeInteger(allowed.workspaceId) || allowed.workspaceId <= 0 ||
      !Number.isSafeInteger(allowed.serviceId) || allowed.serviceId <= 0) return false;
  if (['namespace', 'release'].some(key => typeof allowed[key] !== 'string' ||
      !allowed[key] || allowed[key] !== allowed[key].trim() || allowed[key].length > 128)) return false;
  try {
    const approved = new URL(allowed.baseOrigin), actual = new URL(target.base);
    if (typeof allowed.baseOrigin !== 'string' || approved.protocol !== 'https:' ||
        approved.origin !== allowed.baseOrigin || approved.username || approved.password ||
        actual.protocol !== 'https:' || actual.username || actual.password || actual.search || actual.hash ||
        !['', '/'].includes(actual.pathname) || actual.origin !== allowed.baseOrigin) return false;
  } catch { return false; }
  return ['workspaceId', 'serviceId', 'namespace', 'release'].every(key => target[key] === allowed[key]);
}

export function acceptanceConfigTemplate() {
  return {
    authorizedTarget: { baseOrigin: '', workspaceId: '', serviceId: '', namespace: '', release: '' },
    signedInProviders: [],
    models: { claude: '', codex: '', pi: '' },
    modes: { claude: '', codex: '', pi: '' },
    timeoutMs: 180000,
    turnTimeoutSeconds: 180,
    lifecycleTimeoutSeconds: 360,
    stopHoldSeconds: 20,
    selectors: {
      root: '#main', enable: '#enable', disable: '#disable', provider: '#provider',
      model: '#model', mode: '#mode', models: '#models', pair: '#pair',
      pairLink: '#pair-link', pairPanel: '#pair-panel', acceptance: '#acceptance', result: '#test-result',
    },
    native: {
      gitUrl: 'https://github.com/WOOWTECH/opendesign-paseo-plugin',
      pluginsPath: '/plugins', integrationsPath: '/integrations', pluginApi: '/api/plugins/woowtech-paseo',
      selectors: {
        importOpen: 'section.plugin-marketplace[aria-labelledby="plugin-marketplace-title"] .plugin-marketplace__create', importInput: 'section.plugin-marketplace__create-panel[aria-labelledby="plugin-create-title"] .plugin-marketplace__url-import-row input',
        importSubmit: 'section.plugin-marketplace__create-panel [data-testid="plugin-create-import-url"]',
        pluginCard: '[data-testid="plugins-card-woowtech-paseo"], [data-testid="plugins-card-more-woowtech-paseo"]',
        integrationEntry: 'section.integrations-view[aria-labelledby="integrations-title"] [data-paseo-entry="woowtech-paseo"] a[href="/paseo/setup"]',
      },
    },
    sdk: {
      clientModule: '/REPLACE_WITH_PINNED_RUNTIME/node_modules/@getpaseo/cli/dist/utils/client.js',
      target: { kind: 'instance', home: '/REPLACE_WITH_MANAGED_PASEO_HOME' },
      cwd: '/REPLACE_WITH_DEDICATED_ACCEPTANCE_WORKSPACE',
    },
    official: {
      startUrl: 'https://app.paseo.sh/', connected: '', targetDaemon: '', targetDaemonText: '',
      websocketHosts: [],
      selectors: {
        provider: '', model: '', mode: '', title: '', prompt: '', send: '', assistant: '',
        ownedTitle: '', archive: '', archived: '',
      },
      actions: { pair: [], selectDaemon: [], newAgent: [], create: [], archive: [] },
      selectionAssertions: { provider: '', model: '', mode: '' },
    },
    recovery: {
      expectedEnabled: false, expectedReady: false, expectedOnboardingId: '', samples: 3, intervalMs: 2000,
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 2) process.stdout.write(JSON.stringify(acceptanceConfigTemplate(), null, 2) + '\n');
  else if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write('Usage: node scripts/acceptance-config.mjs\nPrints a nonsecret JSON template only; the parent saves it privately with mode 0600 and fills verified selections/selectors.\n');
  else { process.stdout.write('{"passed":false,"code":"ACCEPTANCE_INVALID_ARGUMENT"}\n'); process.exitCode = 1; }
}
