import {setPrivateHeaders} from './security.mjs';

const ingressPattern = /^\/api\/hassio_ingress\/[A-Za-z0-9_-]{16,128}$/;
const routes = /^\/(?:paseo\/(?:setup\/?|assets\/(?:setup\.(?:js|css)|entry\.js)|entry\.js)|api\/paseo-bridge\/?)(?:\?[^\r\n]*)?$/;
function publicUrl(value) {
  if (typeof value !== 'string' || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}
function validHost(value) {
  const url = publicUrl(`https://${value}`);
  return typeof value === 'string' && url && url.host === value.toLowerCase() && url.pathname === '/' && !url.search && !url.hash;
}

/** Only for the private HA Unix socket. nginx must replace these context headers,
 * restrict the actual TCP peer to Supervisor, and discard all forwarded headers.
 * This is not an authentication mechanism for a public TCP listener. */
export function haIngressAllowed(req) {
  const h = req.headers;
  if (req.socket.remoteAddress || h['x-od-ha-peer'] !== '172.30.32.2') return false;
  if (!/^[a-f0-9]{32}$/.test(h['x-remote-user-id'] || '') || !ingressPattern.test(h['x-ingress-path'] || '')) return false;
  if (!validHost(h.host) || !routes.test(req.originalUrl || req.url)) return false;
  if (Object.keys(h).some(key => key === 'forwarded' || key.startsWith('x-forwarded-'))) return false;
  if (h['sec-fetch-site'] && !['same-origin', 'none'].includes(h['sec-fetch-site'])) return false;
  const origin = h.origin === undefined ? null : publicUrl(h.origin);
  if (h.origin !== undefined && (!origin || origin.origin !== h.origin || origin.host !== h.host.toLowerCase())) return false;
  if (!['GET', 'HEAD', 'POST'].includes(req.method)) return false;
  if (req.method === 'POST') {
    // Same-origin fetch carries the setup page's Referer (same-origin policy).
    // Require both on mutations, including clients without Fetch Metadata.
    const referer = publicUrl(h.referer);
    if (!origin || !referer || referer.origin !== origin.origin || referer.hash ||
        ![`${h['x-ingress-path']}/paseo/setup`, `${h['x-ingress-path']}/paseo/setup/`].includes(referer.pathname)) return false;
    if (h['sec-fetch-site'] && h['sec-fetch-site'] !== 'same-origin') return false;
  }
  return true;
}

export function haIngressMiddleware(req, res, next) {
  if (!haIngressAllowed(req)) {
    setPrivateHeaders(res);
    return res.status(403).json({error: {code: 'UNTRUSTED_REQUEST'}});
  }
  res.locals.paseoIngressPath = req.headers['x-ingress-path'];
  next();
}
