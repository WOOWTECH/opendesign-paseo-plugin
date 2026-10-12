import { providers, safeError } from './runtime-context.mjs';

const id = value => typeof value === 'string' && value.length <= 300 && /^[A-Za-z0-9_.:/@+~ \[\]-]+$/.test(value) ? value : null;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const code = value => value ? safeError({ code: value }).code : null;
const secretValue = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|bearer)\s*[=:]\s*["']?[^\s"',;]+/gi;

export function redactText(value, env = {}) {
  let text = String(value ?? '').slice(0, 100000);
  for (const [key, secret] of Object.entries(env)) if (/(?:token|key|secret|password|cookie|authorization)/i.test(key) && typeof secret === 'string' && secret.length >= 6) text = text.split(secret).join('[redacted]');
  return text.replace(/https?:\/\/app\.paseo\.sh\S*/gi, '[protected pairing link]')
    .replace(/https?:\/\/[^\s<>"']+(?:[?&#](?:token|key|secret|code|state|ticket|pairing|session)[^\s<>"']*)/gi, '[protected authorization link]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9_.-]{12,})\b/g, '[redacted]')
    .replace(secretValue, '[redacted]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted]');
}
const plainLabel = (value, fallback, env) => redactText(typeof value === 'string' && value.length ? value : fallback, env).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);

export function publicProvider(row = {}, provider = row.provider) {
  return { provider, label: provider === 'claude' ? 'Claude Code' : provider === 'codex' ? 'Codex' : 'Pi',
    status: ['ready', 'available', 'unavailable', 'unknown', 'error', 'disabled'].includes(row.status) ? row.status : 'unknown',
    enabled: row.enabled === true, startup: ['ready', 'missing', 'invalid'].includes(row.startup || row.launcher?.startup) ? row.startup || row.launcher.startup : code(row.startup || row.launcher?.startup),
    version: /^\d+\.\d+\.\d+$/.test(row.version || row.launcher?.version || '') ? row.version || row.launcher.version : null,
    authentication: ['chat_verified', 'login_required', 'needs_chat_verification'].includes(row.authentication) ? row.authentication : 'needs_chat_verification',
    credentialPresent: row.credentialPresent === true, chatVerified: row.chatVerified === true,
    defaultModeId: id(row.defaultModeId), modes: (Array.isArray(row.modes) ? row.modes : []).slice(0, 200).map(mode => ({ id: id(mode.id), label: id(mode.label) || id(mode.id) })).filter(mode => mode.id),
    code: code(row.chatErrorCode || row.code) };
}

export function publicAcceptance(value = {}) {
  return { checkedAt: date(value.checkedAt), passed: value.passed === true, historical: true,
    providers: (Array.isArray(value.providers) ? value.providers : []).filter(row => providers.includes(row.provider)).map(row => ({
      provider: row.provider, passed: row.passed === true && row.cleanup?.archived === true, firstReply: row.firstReply === true, followup: row.followup === true,
      model: id(row.model), modeId: id(row.modeId), agentId: id(row.agentId), code: code(row.code), cleanup: { archived: row.cleanup?.archived === true, code: code(row.cleanup?.code) },
    })) };
}

export function publicStatus(value = {}) {
  const state = value.state || {};
  return { schemaVersion: 1, version: value.version === '0.11.2' ? value.version : null, installed: value.installed === true,
    phase: ['not_installed', 'installing', 'starting', 'running', 'stopped', 'disabled', 'error', 'restart_required'].includes(value.phase) ? value.phase : 'error',
    daemon: { owned: value.daemon?.owned === true, running: value.daemon?.running === true, reachable: value.daemon?.reachable === true, ready: value.daemon?.owned === true && value.daemon?.reachable === true && value.daemon?.running === true,
      relayEnabled: value.daemon?.relayEnabled === true, relayConnected: typeof value.daemon?.relayConnected === 'boolean' ? value.daemon.relayConnected : null,
      checkedAt: date(value.daemon?.statusCheckedAt || value.daemon?.checkedAt), relayVerifiedAt: date(value.daemon?.relayVerifiedAt) },
    providers: providers.map(provider => {
      const row = value.providers?.find(row => row.provider === provider) || { provider };
      const previous = state.acceptance?.providers?.find(row => row.provider === provider);
      return publicProvider({ ...row, launcher: row.launcher || state.providerLaunchers?.[provider], authentication: row.authentication || (previous?.passed ? 'chat_verified' : previous?.code === 'PROVIDER_AUTH_REQUIRED' ? 'login_required' : 'needs_chat_verification') }, provider);
    }),
    lastVerification: publicAcceptance(state.acceptance || value.lastVerification), diagnosticCode: code(value.diagnosticCode), pairingAvailable: value.pairingAvailable === true };
}

export function publicModels(value = {}, env = {}) {
  return { ...publicProvider(value), models: (Array.isArray(value.models) ? value.models : []).slice(0, 2000).map(model => ({
    id: id(model.id), label: plainLabel(model.label, id(model.id), env), isDefault: model.isDefault === true, defaultThinkingOptionId: id(model.defaultThinkingOptionId),
    thinkingOptions: (Array.isArray(model.thinkingOptions) ? model.thinkingOptions : []).slice(0, 100).map(option => ({ id: id(option.id), label: plainLabel(option.label, id(option.id), env), isDefault: option.isDefault === true })),
  })).filter(model => model.id) };
}

export function publicChat(value = {}, env = {}) {
  return { agentId: id(value.agentId), provider: providers.includes(value.provider) ? value.provider : null, model: id(value.model),
    reply: redactText(value.reply, env), status: ['completed', 'pending', 'permission_required', 'error'].includes(value.status) ? value.status : 'error', ...(value.code ? { code: code(value.code) } : {}) };
}
