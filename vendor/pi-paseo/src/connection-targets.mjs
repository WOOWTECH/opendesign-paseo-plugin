import fs from 'node:fs';
import path from 'node:path';
import { RuntimeError } from './state.mjs';

export const CONNECTION_TARGETS = Object.freeze([
  Object.freeze({ id: 'paseo', label: 'Paseo', appUrl: 'https://app.paseo.sh', relayEndpoint: 'relay.paseo.sh:443', protectedRelay: true }),
  Object.freeze({ id: 'woowtech', label: 'Woowtech Smart', appUrl: 'https://smart.woowtech.io', relayEndpoint: 'relay.woowtech.io:443', protectedRelay: false }),
  Object.freeze({ id: 'apporo', label: 'Apporo Smart', appUrl: 'https://smart.apporo.ai', relayEndpoint: 'relay.apporo.ai:443', protectedRelay: false }),
]);

export function connectionTarget(id = 'paseo') {
  const target = CONNECTION_TARGETS.find(entry => entry.id === id);
  if (!target) throw new RuntimeError('INVALID_TARGET');
  return target;
}

export function readConnectionTarget(loc) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(loc.stateDir, 'preferences.json'), 'utf8'));
    return connectionTarget(value.connectionTarget || value.target || 'paseo').id;
  } catch (error) {
    if (error?.code === 'ENOENT') return 'paseo';
    if (error?.code === 'INVALID_TARGET') throw error;
    throw new RuntimeError('CONFIG_INVALID');
  }
}

export function targetEnvironment(target) {
  const profile = connectionTarget(target);
  return {
    PI_PASEO_CONNECTION_TARGET: profile.id,
    PASEO_APP_BASE_URL: profile.appUrl,
    PASEO_RELAY_ENABLED: 'true',
    PASEO_RELAY_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_PUBLIC_ENDPOINT: profile.relayEndpoint,
    PASEO_RELAY_USE_TLS: 'true',
    PASEO_RELAY_PUBLIC_USE_TLS: 'true',
    PASEO_CORS_ORIGINS: profile.appUrl,
  };
}

export function targetConfiguration(config, target) {
  const profile = connectionTarget(target);
  const origins = config.daemon?.cors?.allowedOrigins || [];
  if (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string')) throw new RuntimeError('CONFIG_INVALID');
  const managed = new Set(CONNECTION_TARGETS.map(entry => entry.appUrl));
  const relay = { ...config.daemon?.relay, enabled: true, endpoint: profile.relayEndpoint, publicEndpoint: profile.relayEndpoint, useTls: true, publicUseTls: true };
  // Set both states explicitly. Otherwise switching branded -> official could retain false.
  relay.requireProtectedSecurity = profile.protectedRelay;
  return { ...config, app: { ...config.app, baseUrl: profile.appUrl }, daemon: { ...config.daemon,
    relay, cors: { ...config.daemon?.cors, allowedOrigins: [...origins.filter(origin => !managed.has(origin.replace(/\/$/, ''))), profile.appUrl] } } };
}

function decodedOffer(url) {
  let offer;
  try { offer = JSON.parse(Buffer.from(url.hash.slice(7), 'base64url').toString('utf8')); }
  catch { throw new RuntimeError('PAIRING_OFFER_INVALID'); }
  return offer;
}

export function validatePairingOffer(official, target = 'paseo') {
  const profile = connectionTarget(target);
  let url;
  try { url = new URL(official); } catch { throw new RuntimeError('PAIRING_ORIGIN_INVALID'); }
  if (url.origin !== profile.appUrl || url.username || url.password || url.pathname !== '/' || url.search || !/^#offer=[A-Za-z0-9_-]+$/.test(url.hash)) throw new RuntimeError('PAIRING_ORIGIN_INVALID');
  const offer = decodedOffer(url);
  if (offer?.v !== 2 || typeof offer.serverId !== 'string' || !offer.serverId || typeof offer.daemonPublicKeyB64 !== 'string' || !offer.daemonPublicKeyB64 ||
      offer.relay?.endpoint !== profile.relayEndpoint || offer.relay?.useTls !== true) throw new RuntimeError('PAIRING_TARGET_MISMATCH');
  if (profile.protectedRelay) {
    if (offer.minimumSecurityMode !== 'protected') throw new RuntimeError('PAIRING_SECURITY_UNSUPPORTED');
  } else if (offer.minimumSecurityMode !== undefined) throw new RuntimeError('PAIRING_SECURITY_UNSUPPORTED');
  return url.href;
}

// Host security uses the same authoritative validator; this name documents
// that the returned value is the only URL safe to expose to a browser.
export const targetPairUrl = validatePairingOffer;
