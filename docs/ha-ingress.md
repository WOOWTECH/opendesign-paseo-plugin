# Home Assistant transport (0.2.1)

PaaS keeps the existing loopback HTTPS-origin configuration. HA explicitly selects
`OPENDESIGN_PASEO_TRANSPORT=ha-ingress` and supplies `OPENDESIGN_PASEO_SOCKET`
(an absolute Unix socket path). `OPENDESIGN_PASEO_NATIVE_PORT=7456`, persistent
`HOME`, `OPENDESIGN_PASEO_DATA_DIR`, the packaged launcher directory and
`OPENDESIGN_PASEO_AUTO_ENABLE=1` complete the HA configuration. Both shells can
install the same immutable npm archive; no native-core overlay is needed.

The HA wrapper must create the socket parent before dropping privileges. The
bridge owns the socket (0660); use a setgid parent owned by the runtime UID and
nginx group (2750). No public TCP bridge listener is started in HA mode. The
wrapper supervises `bin/serve.mjs` alongside OpenDesign in one PID namespace.
Do not delete a live socket or run two bridges sharing one data directory.

Nginx must restrict `/paseo/` and `/api/paseo-bridge` to actual Supervisor peer
172.30.32.2, not an address from a header. It must disable request-header
passthrough, copy Host/Origin/Referer/Fetch Metadata and Content-Type, and set:

- `X-OD-HA-Peer` from `$remote_addr`.
- `X-Remote-User-Id` from Supervisor's authenticated user header.
- `X-Ingress-Path` only from a validated `/api/hassio_ingress/<token>` prefix.

Never forward `Forwarded` or `X-Forwarded-*` to this transport. They are not
origin authority. The runtime rejects TCP, missing user/path, malformed routes,
cross-site metadata and conflicting origin/Host. POST also requires the setup
page's same-origin Referer under the exact prefix. Both HTTPS and local HA HTTP
work; prefix and origin never come from query parameters. Setup HTML has
same-origin referrers (external auth/pair links retain noreferrer), prefixed
assets, and an explicit prefix for API requests and native onboarding links.

HA authentication remains at Supervisor. This does not add an admin-role check;
it follows the existing add-on Ingress access boundary. Same-UID agent code is
trusted local code and can already control OpenDesign/Paseo. Do not expose this
Unix socket outside the container or treat its context headers as public auth.

First boot enables the managed runtime once and creates/reconciles its marked
native onboarding project. Explicit stop persists; normal process shutdown
retains desired state. No runtime/provider credentials are supplied by the HA
Supervisor. Model authentication and real two-turn verification remain user
setup actions.
