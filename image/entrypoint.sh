#!/bin/sh
set -eu
node /opt/opendesign-agent-runtime/scripts/install-host.mjs --source /opt/opendesign-agent-runtime --home "$HOME" --host-root /app
case " ${NODE_OPTIONS:-} " in
  *" --import file://$HOME/.local/share/opendesign-paseo/bin/preload.mjs "*) ;;
  *) NODE_OPTIONS="${NODE_OPTIONS:-} --import file://$HOME/.local/share/opendesign-paseo/bin/preload.mjs" ;;
esac
export NODE_OPTIONS
exec "$@"
